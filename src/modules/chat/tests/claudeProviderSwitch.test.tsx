import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { ClaudeProviderSwitch } from '@/modules/chat/modals/ClaudeProviderSwitch';

const SESSION_ID = 'existing-chat';
const SESSION_ENDPOINT = `/api/providers/sessions/${SESSION_ID}/claude-settings`;
const CURRENT = { selectedProfile: 'gateway', revision: 3, model: 'old-model', effort: 'max' };
const PROFILES = [{ id: 'gateway', label: 'Gateway' }, { id: 'backup', label: 'Backup' }];

const profileResponse = (selectedProfile: string | null, revision: number) =>
  Response.json({ success: true, data: { ...CURRENT, selectedProfile, revision, profiles: PROFILES } });

const trigger = () => screen.getByRole<HTMLButtonElement>('button', { name: /: Switch Claude provider$/ });
const confirm = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Switch this chat' });

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function renderPicker(fetchMock: typeof fetch, disabled = false) {
  vi.stubGlobal('fetch', fetchMock);
  const onSwitch = vi.fn();
  const view = render(<ClaudeProviderSwitch sessionId={SESSION_ID} disabled={disabled} onSwitch={onSwitch} />);
  return { ...view, onSwitch };
}

afterEach(() => vi.unstubAllGlobals());

test('loads the closed label and requires a fresh revision and explicit choice before switching', async () => {
  const fresh = deferredResponse();
  const initial = deferredResponse();
  const next = { selectedProfile: null, revision: 8, model: 'default', effort: 'default' };
  const fetchMock = vi.fn<typeof fetch>()
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(fresh.promise)
    .mockResolvedValueOnce(Response.json({ success: true, data: next }));
  const { onSwitch } = renderPicker(fetchMock);

  expect(trigger().textContent).toBe('Loading provider…');
  expect(screen.queryByRole('dialog')).toBeNull();
  initial.resolve(profileResponse('gateway', 3));
  await waitFor(() => expect(trigger().textContent).toBe('Gateway'));

  fireEvent.click(trigger());
  expect(screen.getByRole('status').textContent).toBe('Loading providers…');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(confirm().disabled).toBe(true);

  fresh.resolve(profileResponse('backup', 7));
  const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Current: Backup' });
  expect(select.value).toBe('');
  expect(confirm().disabled).toBe(true);
  fireEvent.change(select, { target: { value: 'backup' } });
  expect(confirm().disabled).toBe(true);
  fireEvent.change(select, { target: { value: ':instance' } });
  fireEvent.click(confirm());

  await waitFor(() => expect(trigger().textContent).toBe('Default Claude authorization'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onSwitch).toHaveBeenCalledExactlyOnceWith(SESSION_ID, next);
  const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(puts.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
    [SESSION_ENDPOINT, { selectedProfile: null, revision: 7 }],
  ]);
});

test('shows load failure and unavailable profile distinctly, and allows retry in the picker', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ success: true, data: { revision: 3, profiles: PROFILES } }))
    .mockResolvedValueOnce(Response.json({ success: false, error: '/server-only/settings.json' }, { status: 503 }))
    .mockResolvedValueOnce(profileResponse('retired-profile', 3));
  renderPicker(fetchMock);
  await waitFor(() => expect(trigger().textContent).toBe('Provider load failed'));
  fireEvent.click(trigger());
  expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load Claude providers/);
  expect(screen.queryByText('/server-only/settings.json')).toBeNull();
  expect(confirm().disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(trigger());
  await screen.findByRole('combobox', { name: 'Current: Unavailable Claude provider' });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(trigger().textContent).toBe('Unavailable Claude provider');
});

test('resets the picker on session change and ignores a late previous-session read', async () => {
  const obsolete = deferredResponse();
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(profileResponse('gateway', 3))
    .mockReturnValueOnce(obsolete.promise)
    .mockResolvedValueOnce(profileResponse(null, 0));
  const { rerender, onSwitch } = renderPicker(fetchMock);
  await waitFor(() => expect(trigger().textContent).toBe('Gateway'));
  fireEvent.click(trigger());
  const previousSignal = fetchMock.mock.calls[1]?.[1]?.signal;
  expect(previousSignal?.aborted).toBe(false);

  rerender(<ClaudeProviderSwitch sessionId="second-chat" disabled={false} onSwitch={onSwitch} />);
  expect(previousSignal?.aborted).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(trigger().textContent).toBe('Default Claude authorization'));
  await act(async () => obsolete.resolve(profileResponse('backup', 4)));
  expect(trigger().textContent).toBe('Default Claude authorization');
  expect(onSwitch).not.toHaveBeenCalled();
});

test('a concurrent switch refreshes the current label but requires reopening to edit', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(profileResponse('gateway', 3))
    .mockResolvedValueOnce(profileResponse('gateway', 3))
    .mockResolvedValueOnce(Response.json({ success: false, error: { code: 'CLAUDE_SETTINGS_CHANGED', message: '/server-only/settings.json' } }, { status: 409 }))
    .mockResolvedValueOnce(profileResponse('backup', 4));
  const { onSwitch } = renderPicker(fetchMock);
  fireEvent.click(trigger());
  fireEvent.change(await screen.findByRole('combobox', { name: 'Current: Gateway' }), { target: { value: 'backup' } });
  fireEvent.click(confirm());
  expect((await screen.findByRole('alert')).textContent).toMatch(/changed in another tab/);
  expect(screen.queryByText('/server-only/settings.json')).toBeNull();
  const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Current: Backup' });
  expect(select.disabled).toBe(true);
  expect(confirm().disabled).toBe(true);
  expect(onSwitch).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(trigger().textContent).toBe('Backup');
});

test('shows the current label while disabled and rejects an in-flight server busy response', async () => {
  const pending = deferredResponse();
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(profileResponse('gateway', 3))
    .mockResolvedValueOnce(profileResponse('gateway', 3))
    .mockReturnValueOnce(pending.promise);
  const { rerender, onSwitch } = renderPicker(fetchMock, true);
  await waitFor(() => expect(trigger().textContent).toBe('Gateway'));
  fireEvent.click(trigger());
  expect(screen.queryByRole('dialog')).toBeNull();

  rerender(<ClaudeProviderSwitch sessionId={SESSION_ID} disabled={false} onSwitch={onSwitch} />);
  fireEvent.click(trigger());
  const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Current: Gateway' });
  fireEvent.change(select, { target: { value: 'backup' } });
  rerender(<ClaudeProviderSwitch sessionId={SESSION_ID} disabled onSwitch={onSwitch} />);
  expect(confirm().disabled).toBe(true);
  fireEvent.click(confirm());
  expect(fetchMock).toHaveBeenCalledTimes(2);

  rerender(<ClaudeProviderSwitch sessionId={SESSION_ID} disabled={false} onSwitch={onSwitch} />);
  fireEvent.click(confirm());
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  pending.resolve(Response.json({ success: false, error: { code: 'SESSION_BUSY' } }, { status: 409 }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/background work to finish/);
  expect(trigger().textContent).toBe('Gateway');
  expect(onSwitch).not.toHaveBeenCalled();
});
