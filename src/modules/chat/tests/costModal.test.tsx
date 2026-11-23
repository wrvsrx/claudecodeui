import assert from 'node:assert/strict';

import { render, screen, within } from '@testing-library/react';
import { test, vi } from 'vitest';

import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import '@/modules/i18n';
import type { CostCommandData } from '@/shared/types';

function renderCost(data: CostCommandData) {
  render(
    <CommandResultModal
      payload={{ kind: 'cost', data }}
      onClose={vi.fn()}
      providerModelCatalog={{}}
      providerModelActions={{ create: vi.fn(), update: vi.fn(), remove: vi.fn(), setCustomModelsOnly: vi.fn() }}
      activeProvider="claude"
      activeProviderModel="sonnet"
      currentSessionId={null}
      onSelectProviderModel={vi.fn()}
    />,
  );
}

function assertRow(label: string, value: string) {
  const row = screen.getByText(label, { exact: true }).parentElement?.parentElement;
  assert.ok(row);
  assert.ok(within(row).getByText(value, { exact: true }));
}

test('Claude cost shows each latest-response counter and the read/total percentage', () => {
  renderCost({
    provider: 'claude',
    model: 'sonnet',
    tokenUsage: { used: 84, total: 160_000 },
    tokenBreakdown: { input: 80, uncachedInput: 10, cacheRead: 60, cacheWrite: 10, output: 4, cacheHitRate: 0.75 },
  });

  assertRow('Total tokens used', '84');
  assertRow('Total input tokens', '80');
  assertRow('Uncached input tokens', '10');
  assertRow('Cache read tokens', '60');
  assertRow('Cache write tokens', '10');
  assertRow('Output tokens', '4');
  assertRow('Cache hit rate', (0.75).toLocaleString(undefined, { style: 'percent' }));
  assertRow('Context window', (160_000).toLocaleString());
  assert.ok(screen.getByText('sonnet'));
});

test('Claude cost distinguishes an explicit zero from unavailable figures', () => {
  renderCost({ provider: 'claude', tokenBreakdown: { cacheRead: 0, output: 0 } });

  assertRow('Total tokens used', 'Unavailable');
  assertRow('Total input tokens', 'Unavailable');
  assertRow('Cache read tokens', '0');
  assertRow('Cache write tokens', 'Unavailable');
  assertRow('Output tokens', '0');
  assertRow('Cache hit rate', 'Unavailable');
});

test('non-Claude cost keeps the existing breakdown', () => {
  renderCost({ provider: 'codex', tokenUsage: { used: 15 }, tokenBreakdown: { input: 10, output: 5 } });

  assertRow('Input tokens', '10');
  assertRow('Output tokens', '5');
  assert.equal(screen.queryByText('Cache hit rate'), null);
});
