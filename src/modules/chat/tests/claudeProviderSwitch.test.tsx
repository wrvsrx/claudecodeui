import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { ClaudeProviderSwitch } from '@/modules/chat/modals/ClaudeProviderSwitch';

const sessionId = 'existing-chat';
const sessionEndpoint = `/api/providers/sessions/${sessionId}/claude-settings`;
const current = { selectedProfile: 'gateway', revision: 3, model: 'old-model', effort: 'max' };

afterEach(() => vi.unstubAllGlobals());

function setup(response: Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== sessionEndpoint) throw new Error('Unexpected endpoint');
    return init?.method === 'PUT' ? response : Response.json({ success: true, data: { ...current,
      profiles: [{ id: 'gateway', label: 'Gateway' }, { id: 'backup', label: 'Backup' }],
    } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const onSwitch = vi.fn();
  render(<ClaudeProviderSwitch sessionId={sessionId} disabled={false} onSwitch={onSwitch} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch Claude provider' }));
  return { onSwitch, fetchMock };
}

test('requires explicit selection, sends null for default and updates only the current chat', async () => {
  const next = { selectedProfile: null, revision: 4, model: 'default', effort: 'default' };
  const { onSwitch, fetchMock } = setup(Response.json({ success: true, data: next }));
  const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Current: Gateway' });
  const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Switch this chat' });
  expect(select.value).toBe('');
  expect(confirm.disabled).toBe(true);
  fireEvent.change(select, { target: { value: 'gateway' } });
  expect(confirm.disabled).toBe(true);
  fireEvent.change(select, { target: { value: ':instance' } });
  fireEvent.click(confirm);
  await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith(sessionId, next));
  const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(puts.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
    [sessionEndpoint, { selectedProfile: null, revision: 3 }],
  ]);
});

test('a concurrent change does not update local state or disclose server error text', async () => {
  const { onSwitch } = setup(Response.json({ success: false, error: { code: 'CLAUDE_SETTINGS_CHANGED', message: '/server-only/settings.json' } }, { status: 409 }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Current: Gateway' }), { target: { value: 'backup' } });
  fireEvent.click(screen.getByRole('button', { name: 'Switch this chat' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/changed in another tab/);
  expect(screen.queryByText('/server-only/settings.json')).toBeNull();
  expect(onSwitch).not.toHaveBeenCalled();
});
