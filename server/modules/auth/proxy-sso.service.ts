import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

const SINGLE_EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const HEX_SECRET = /^[0-9a-fA-F]{64}$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

function isSameOrigin(request: IncomingMessage): boolean {
  const site = request.headersDistinct['sec-fetch-site'];
  if (site && (site.length !== 1 || site[0] !== 'same-origin')) {
    return false;
  }
  const origins = request.headersDistinct.origin;
  if (!origins) {
    // Non-browser clients can omit Fetch Metadata and Origin; they still need
    // proxy proof, plus either the explicit exchange header or a valid WS JWT.
    return true;
  }
  const host = singleHeader(request, 'host');
  if (origins.length !== 1 || !host || origins[0] === undefined) {
    return false;
  }
  try {
    const origin = new URL(origins[0]);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname);
    return origin.origin === origins[0]
      && (origin.protocol === 'https:' || (loopback && origin.protocol === 'http:'))
      && origin.host === host.toLowerCase();
  } catch {
    return false;
  }
}

/** Configures the explicit single-user SSO bridge for the server entrypoint. */
export function createProxySsoBridge(environment: NodeJS.ProcessEnv, host: string, isPlatform: boolean) {
  const filename = environment.CLOUDCLI_SSO_SECRET_FILE;
  if (filename === undefined) {
    return null;
  }
  const expectedEmail = normalizeEmail(environment.CLOUDCLI_SSO_EMAIL ?? '');
  if (expectedEmail.length > 254 || !SINGLE_EMAIL.test(expectedEmail)) {
    throw new Error('CLOUDCLI_SSO_EMAIL must be a single valid address when the SSO bridge is enabled');
  }
  if (!['127.0.0.1', '::1'].includes(host) || isPlatform) {
    throw new Error('CloudCLI SSO requires a loopback HOST (127.0.0.1 or ::1) and non-platform mode');
  }

  let secretText: string;
  try {
    // Latin-1 preserves invalid non-ASCII bytes rather than masking their high bits.
    secretText = readFileSync(filename, 'latin1').replace(/\r?\n$/, '');
  } catch {
    throw new Error('Cannot read CLOUDCLI_SSO_SECRET_FILE');
  }
  if (secretText.length !== 64 || !HEX_SECRET.test(secretText)) {
    throw new Error('CLOUDCLI_SSO_SECRET_FILE must contain exactly 64 ASCII hexadecimal digits');
  }
  const expected = Buffer.from(secretText, 'ascii');

  function verifyProxy(request: IncomingMessage): boolean {
    const secret = singleHeader(request, 'x-cloudcli-proxy-secret');
    if (!secret || secret.length !== 64 || !HEX_SECRET.test(secret)) {
      return false;
    }
    const validSecret = timingSafeEqual(Buffer.from(secret, 'ascii'), expected);
    const email = singleHeader(request, 'x-forwarded-email');
    return validSecret && email !== undefined && normalizeEmail(email) === expectedEmail;
  }

  return {
    verifyProxy,
    allowsExchange: (request: IncomingMessage) =>
      singleHeader(request, 'x-cloudcli-sso') === '1' && isSameOrigin(request) && verifyProxy(request),
    allowsUpgrade: (request: IncomingMessage) => verifyProxy(request) && isSameOrigin(request),
  };
}
