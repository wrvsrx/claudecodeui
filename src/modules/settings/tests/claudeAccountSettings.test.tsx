import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import type { AgentProvider, ProviderAuthStatus } from '@/shared/types';

const PROFILE = { id: 'work', label: 'Work gateway' };
const DISCONNECTED: ProviderAuthStatus = {
  authenticated: false,
  email: null,
  method: null,
  loading: false,
  error: null,
};

function endpointResponse(selectedProfile: string | null, profiles = [PROFILE]) {
  return Response.json({ profiles, selectedProfile });
}

function stubEndpoint(respond: (init?: RequestInit) => Promise<Response>) {
  const endpoint = vi.fn(respond);
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    url === '/api/claude-settings' ? endpoint(init) : Promise.resolve(Response.json({ data: { updateInProgress: false } })));
  return endpoint;
}

function account(agent: AgentProvider = 'claude', authStatus = DISCONNECTED) {
  return <AccountContent key={agent} agent={agent} authStatus={authStatus} onLogin={() => {}} />;
}

async function picker() {
  return await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Default Claude endpoint' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('loads the account endpoint with authentication and shows configuration, not a login requirement', async () => {
  localStorage.setItem('auth-token', 'test-token');
  const endpoint = stubEndpoint(async () => endpointResponse(PROFILE.id));
  render(account());

  expect((await picker()).value).toBe(PROFILE.id);
  expect(screen.getByText(/applies only to new Claude chats/)).toBeTruthy();
  expect(screen.getByText(/Configured endpoint: Work gateway\. Credentials have not been verified here\./)).toBeTruthy();
  expect(screen.queryByText('Not connected')).toBeNull();
  expect(screen.queryByRole('button', { name: /log in|sign in/i })).toBeNull();
  expect(endpoint).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
  }));
});

test('waits for confirmation, serializes authenticated updates, and resets to the server default', async () => {
  localStorage.setItem('auth-token', 'test-token');
  let completeSave!: (response: Response) => void;
  const endpoint = stubEndpoint(async (init) => {
    if (init?.method !== 'PUT') return endpointResponse(null);
    if (JSON.parse(String(init.body)).selectedProfile === null) return endpointResponse(null);
    return new Promise<Response>((resolve) => { completeSave = resolve; });
  });
  render(account());

  const select = await picker();
  expect(select.value).toBe('');
  expect(screen.getByText('Not connected')).toBeTruthy();
  fireEvent.change(select, { target: { value: PROFILE.id } });
  expect(select.value).toBe('');
  expect(select.disabled).toBe(true);
  expect(screen.getByText('Saving Claude endpoint…')).toBeTruthy();
  expect(endpoint).toHaveBeenCalledTimes(2);
  expect(endpoint).toHaveBeenLastCalledWith(expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ selectedProfile: PROFILE.id }),
    headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
  }));

  await act(async () => completeSave(endpointResponse(PROFILE.id)));
  expect(select.disabled).toBe(false);
  expect(select.value).toBe(PROFILE.id);
  expect(screen.queryByText('Not connected')).toBeNull();
  fireEvent.change(select, { target: { value: '' } });
  await waitFor(() => expect(select.value).toBe(''));
  expect(endpoint).toHaveBeenLastCalledWith(expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ selectedProfile: null }),
  }));
  expect(await screen.findByText('Not connected')).toBeTruthy();
});

test('reports a failed load and retries without assuming the server default', async () => {
  const endpoint = stubEndpoint(async () => endpointResponse(null, []));
  endpoint.mockResolvedValueOnce(new Response('', { status: 503 }));
  render(account());

  expect((await screen.findByRole('alert')).textContent).toContain('Could not load Claude endpoint settings.');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByText('Not connected')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Not connected')).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
});

test('keeps the confirmed endpoint on save error and can reload the saved value', async () => {
  const endpoint = stubEndpoint(vi.fn()
    .mockResolvedValueOnce(endpointResponse(null))
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce(endpointResponse(PROFILE.id)));
  render(account());

  const select = await picker();
  fireEvent.change(select, { target: { value: PROFILE.id } });
  expect((await screen.findByRole('alert')).textContent).toContain('Could not confirm the change.');
  expect(select.value).toBe('');
  expect(select.disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Reload settings' }));
  expect((await picker()).value).toBe(PROFILE.id);
  expect(endpoint).toHaveBeenCalledTimes(3);
  expect(endpoint.mock.lastCall?.[0]?.method).toBeUndefined();
});

test('keeps removed profiles visibly unavailable and lets the user clear them with an empty catalog', async () => {
  const endpoint = stubEndpoint(async (init) => endpointResponse(init?.method === 'PUT' ? null : 'removed', []));
  render(account());

  const select = await picker();
  expect(select.selectedOptions[0]?.textContent).toBe('Unavailable endpoint');
  expect((await screen.findByRole('alert')).textContent).toContain('Your saved endpoint is no longer available.');
  expect(screen.queryByText('Not connected')).toBeNull();
  fireEvent.change(select, { target: { value: '' } });
  expect(await screen.findByText('Not connected')).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(endpoint).toHaveBeenLastCalledWith(expect.objectContaining({ body: '{"selectedProfile":null}' }));
});

test('only loads the catalog on the Claude account panel and aborts when leaving it', async () => {
  let completeLoad!: (response: Response) => void;
  const endpoint = stubEndpoint(async () => new Promise<Response>((resolve) => { completeLoad = resolve; }));
  const { rerender } = render(account('codex'));
  expect(endpoint).not.toHaveBeenCalled();
  rerender(account());
  const signal = endpoint.mock.lastCall?.[0]?.signal;
  expect(signal?.aborted).toBe(false);
  rerender(account('codex'));
  expect(signal?.aborted).toBe(true);
  await act(async () => completeLoad(endpointResponse(PROFILE.id)));
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByText('Not connected')).toBeTruthy();
  expect(endpoint).toHaveBeenCalledTimes(1);
});
