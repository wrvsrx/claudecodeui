import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { createAuthRouter } from '../auth.routes.js';
import { createAuthService } from '../auth.service.js';
import { createProxySsoBridge } from '../proxy-sso.service.js';

const secret = '0123456789AbCdEf'.repeat(4);
const publicHost = 'cloudcli.example.test';
const email = ' Allowed@Example.TEST ';

function secretFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cloudcli-sso-'));
  return {
    filename: join(dir, 'secret'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('SSO is opt-in and refuses to start with invalid configuration', (t) => {
  const fixture = secretFixture();
  t.after(fixture.cleanup);
  const env = { CLOUDCLI_SSO_SECRET_FILE: fixture.filename, CLOUDCLI_SSO_EMAIL: email };
  assert.equal(createProxySsoBridge({ CLOUDCLI_SSO_EMAIL: email }, '0.0.0.0', true), null);
  assert.throws(() => createProxySsoBridge({ ...env, CLOUDCLI_SSO_SECRET_FILE: '' }, '127.0.0.1', false), /Cannot read/);
  assert.throws(() => createProxySsoBridge(env, '127.0.0.1', false), /Cannot read/);
  for (const invalid of [undefined, '', 'not-an-address', 'one@example.test,two@example.test', 'a@-example.test']) {
    assert.throws(() => createProxySsoBridge({ ...env, CLOUDCLI_SSO_EMAIL: invalid }, '127.0.0.1', false), /CLOUDCLI_SSO_EMAIL/);
  }
  assert.throws(() => createProxySsoBridge(env, '0.0.0.0', false), /loopback HOST/);
  assert.throws(() => createProxySsoBridge(env, '127.0.0.1', true), /non-platform mode/);
  for (const malformed of ['', '0'.repeat(63), `${secret}\n\n`, `${secret} `, '\u00b0' + secret.slice(1)]) {
    writeFileSync(fixture.filename, malformed, 'latin1');
    assert.throws(() => createProxySsoBridge(env, '127.0.0.1', false), /64 ASCII hexadecimal digits/);
  }
  for (const terminator of ['', '\n', '\r\n']) {
    writeFileSync(fixture.filename, secret + terminator, 'ascii');
    assert.ok(createProxySsoBridge(env, '127.0.0.1', false));
  }
});

test('SSO proof fails closed, protects exchange and upgrade, and disables native endpoints', async (t) => {
  const fixture = secretFixture();
  t.after(fixture.cleanup);
  writeFileSync(fixture.filename, `${secret}\n`);
  const bridge = createProxySsoBridge({
    CLOUDCLI_SSO_SECRET_FILE: fixture.filename, CLOUDCLI_SSO_EMAIL: email,
  }, '127.0.0.1', false);
  assert.ok(bridge);
  const service = createAuthService({
    users: {
      hasUsers: () => false,
      createUser: () => { throw new Error('unexpected native registration'); },
      getUserByUsername: () => { throw new Error('unexpected native login'); },
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined, commit: () => undefined, rollback: () => undefined,
    },
    hashPassword: async () => { throw new Error('unexpected native password hash'); },
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
  });
  const app = express();
  app.use((req, res, next) => {
    if (!bridge.verifyProxy(req)) {
      res.sendStatus(401);
      return;
    }
    next();
  });
  app.use('/api/auth', createAuthRouter(service, (_req, _res, next) => next(), bridge,
    async () => service.issueProxySession(() => ({ id: 1n, username: 'local' }))));
  app.get('/upgrade-check', (req, res) => res.sendStatus(bridge.allowsUpgrade(req) ? 204 : 403));
  const server = createServer(app).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;

  const proof = { host: publicHost, 'x-cloudcli-proxy-secret': secret, 'x-forwarded-email': email };
  const exchange = { ...proof, origin: `https://${publicHost}`, 'sec-fetch-site': 'same-origin', 'x-cloudcli-sso': '1' };
  function send(path: string, headers: Record<string, string | string[]>, method = 'POST') {
    return new Promise<{ status?: number; cache?: string; data: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, headers, method }, (res) => {
        const chunks: string[] = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, cache: res.headers['cache-control'], data: chunks.join('') }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  for (const rejected of [
    { ...proof, 'x-cloudcli-proxy-secret': '' },
    { ...proof, 'x-cloudcli-proxy-secret': secret.toLowerCase() },
    { ...proof, 'x-cloudcli-proxy-secret': [secret, secret] },
    { ...proof, 'x-forwarded-email': ['unknown@example.test', email] },
    { ...proof, 'x-forwarded-email': 'unknown@example.test' },
  ]) {
    assert.equal((await send('/api/auth/status', rejected, 'GET')).status, 401);
  }
  const status = await send('/api/auth/status', proof, 'GET');
  assert.deepEqual(JSON.parse(status.data), { ssoBridge: true, needsSetup: false, isAuthenticated: false });
  assert.equal(status.cache, 'no-store');
  for (const denied of [proof, { ...exchange, 'sec-fetch-site': 'cross-site' },
    { ...exchange, origin: 'https://hostile.example.test' }, { ...exchange, origin: 'null' }]) {
    assert.equal((await send('/api/auth/sso', denied)).status, 403);
  }
  for (const endpoint of ['register', 'login']) {
    assert.equal((await send(`/api/auth/${endpoint}`, proof)).status, 403);
  }
  const issued = await send('/api/auth/sso', exchange);
  assert.equal(issued.status, 200);
  assert.equal(issued.cache, 'no-store');
  assert.deepEqual(JSON.parse(issued.data), { success: true, user: { id: 1, username: 'local' }, token: 'signed-token' });
  assert.equal((await send('/upgrade-check', exchange, 'GET')).status, 204);
  assert.equal((await send('/upgrade-check', { ...exchange, origin: 'https://hostile.example.test' }, 'GET')).status, 403);
});
