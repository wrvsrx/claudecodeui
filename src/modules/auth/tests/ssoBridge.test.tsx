import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AuthProvider, ProtectedRoute } from '@/modules/auth';
import '@/modules/i18n';
import { api } from '@/shared/api';

const token = 'app.sso.jwt';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const bridgeStatus = () => json({ ssoBridge: true, needsSetup: false });
const exchangeSuccess = () => json({ success: true, user: { id: 1, username: 'sso' }, token });
const proxyRejected = () => new Response('Unauthorized', { status: 401 });

function renderGate() {
  render(
    <StrictMode>
      <AuthProvider>
        <ProtectedRoute>
          <button type="button" onClick={() => void api.projects()}>Load projects</button>
        </ProtectedRoute>
      </AuthProvider>
    </StrictMode>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('exchanges only the same-origin proxy session, even with a stored JWT and StrictMode', async () => {
  localStorage.setItem('auth-token', 'another.old.jwt');
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    switch (url) {
      case '/api/auth/status': return json({ ssoBridge: true, needsSetup: true });
      case '/api/auth/sso': return exchangeSuccess();
      case '/api/user/onboarding-status':
        expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        return json({ hasCompletedOnboarding: true });
      default: return json({});
    }
  });
  vi.stubGlobal('fetch', fetch);
  renderGate();
  await screen.findByRole('button', { name: 'Load projects' });
  expect(localStorage.getItem('auth-token')).toBe(token);
  expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/auth/'))).toEqual([
    ['/api/auth/status', { cache: 'no-store', redirect: 'manual' }],
    ['/api/auth/sso', {
      method: 'POST', headers: { 'X-CloudCLI-SSO': '1' }, credentials: 'same-origin',
      mode: 'same-origin', cache: 'no-store', redirect: 'manual',
    }],
  ]);
});

test('a proxy 401 before status is known does not fall back to native auth', async () => {
  localStorage.setItem('auth-token', 'another.old.jwt');
  const fetch = vi.fn(async () => proxyRejected());
  vi.stubGlobal('fetch', fetch);
  renderGate();
  await screen.findByRole('button', { name: 'Reload page' });
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(localStorage.getItem('auth-token')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('failed exchange clears stale app credentials and does not retry automatically', async () => {
  localStorage.setItem('auth-token', 'another.old.jwt');
  const fetch = vi.fn(async (url: string) =>
    url === '/api/auth/status' ? bridgeStatus() : proxyRejected(),
  );
  vi.stubGlobal('fetch', fetch);
  renderGate();
  await screen.findByRole('button', { name: 'Reload page' });
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(localStorage.getItem('auth-token')).toBeNull();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/status', '/api/auth/sso']);
});

test('401 without X-Auth-Error on a live bridge session attempts one recovery, then prompts reload', async () => {
  let proxyExpired = false;
  const fetch = vi.fn(async (url: string, _options?: RequestInit) => {
    if (proxyExpired) return proxyRejected();
    if (url === '/api/auth/status') return bridgeStatus();
    if (url === '/api/auth/sso') return exchangeSuccess();
    if (url === '/api/user/onboarding-status') return json({ hasCompletedOnboarding: true });
    return json({});
  });
  vi.stubGlobal('fetch', fetch);
  renderGate();
  const projects = await screen.findByRole('button', { name: 'Load projects' });
  proxyExpired = true;
  fireEvent.click(projects);
  fireEvent.click(projects);
  await screen.findByRole('button', { name: 'Reload page' });
  expect(localStorage.getItem('auth-token')).toBeNull();
  expect(fetch.mock.calls.filter(([url]) => url === '/api/auth/status')).toHaveLength(2);
  expect(fetch.mock.calls.filter(([url]) => url === '/api/auth/sso')).toHaveLength(1);
  expect(fetch).toHaveBeenCalledWith('/api/projects', expect.objectContaining({ redirect: 'manual' }));
});

test.each([false, true])('standalone auth still shows its native form (needsSetup=%s)', async needsSetup => {
  const fetch = vi.fn(async () => json({ needsSetup }));
  vi.stubGlobal('fetch', fetch);
  renderGate();
  await waitFor(() => expect(screen.queryByRole('button', { name: needsSetup ? 'Create Account' : 'Sign In' })).not.toBeNull());
  expect(fetch).toHaveBeenCalledTimes(1);
});
