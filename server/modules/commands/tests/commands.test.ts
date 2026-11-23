import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createCommandsRouter } from '../commands.routes.js';

/**
 * Stands in for `providerModelsService`. `resolveSessionModel` mirrors the real
 * precedence closely enough for the command handlers: a model recorded for the
 * session wins, otherwise the client's requested model, otherwise the catalog
 * default.
 */
function createModelsService(sessionModels: Record<string, string> = {}) {
  return {
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'default', label: 'Default' }],
      DEFAULT: 'default',
    }),
    getCurrentActiveModel: async () => ({ model: 'default' }),
    setSessionModel: () => null,
    resolveSessionModel: async (
      provider: string,
      options: { sessionId?: string | null; requestedModel?: string | null } = {},
    ) => {
      const recorded = options.sessionId ? sessionModels[options.sessionId] : undefined;
      const model = recorded || options.requestedModel || 'default';
      return {
        provider,
        sessionId: options.sessionId ?? null,
        model,
        source: model === 'default' ? 'default' : 'session',
      };
    },
    resolveResumeModel: async () => undefined,
  };
}

async function executeCommand(
  commandName: string,
  context: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const router = createCommandsRouter({
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService(sessionModels) as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName, context }),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('models command returns models only for the active provider using injected catalog', async () => {
  const result = await executeCommand('/models', { provider: 'codex' });
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data.available as object), ['codex']);
});

test('models command falls back to claude for unsupported providers', async () => {
  const result = await executeCommand('/models', { provider: 'unknown-provider' });
  const data = result.data as { current: { provider: string } };
  assert.equal(data.current.provider, 'claude');
});

test('models command reports the model recorded for the session', async () => {
  const result = await executeCommand(
    '/models',
    { provider: 'claude', sessionId: 'session-1', model: 'sonnet' },
    { 'session-1': 'haiku' },
  );

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('models command reports the composer model for a chat with no session yet', async () => {
  const result = await executeCommand('/models', { provider: 'claude', model: 'haiku' });

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('cost and status commands report the same resolved model as /models', async () => {
  const context = { provider: 'claude', sessionId: 'session-1', model: 'sonnet' };
  const sessionModels = { 'session-1': 'haiku' };

  const cost = await executeCommand('/cost', context, sessionModels);
  const status = await executeCommand('/status', context, sessionModels);

  assert.equal((cost.data as { model: string }).model, 'haiku');
  assert.equal((status.data as { model: string }).model, 'haiku');
});


test('/cost reports one Claude response without adding cached input twice', async () => {
  const cost = await executeCommand('/cost', { provider: 'claude', tokenUsage: {
    used: 9000, total: 160_000, inputTokens: 8000,
    latestResponse: { input: 200, uncachedInput: 25, cacheRead: 150, cacheWrite: 25, output: 20 },
  } });
  assert.deepEqual(cost.data, {
    tokenUsage: { used: 220, total: 160_000 },
    tokenBreakdown: { input: 200, uncachedInput: 25, cacheRead: 150, cacheWrite: 25, output: 20, cacheHitRate: 0.75 },
    provider: 'claude',
    model: 'default',
  });
});

test('/cost preserves zero and omits absent counters and a hit rate without a denominator', async () => {
  const cost = await executeCommand('/cost', { provider: 'claude', tokenUsage: {
    used: 90, total: 160_000,
    latestResponse: { uncachedInput: 20, cacheRead: 0, output: 0 },
  } });
  const data = cost.data as Record<string, unknown>;
  assert.deepEqual(data.tokenUsage, { total: 160_000 });
  assert.deepEqual(data.tokenBreakdown, { uncachedInput: 20, cacheRead: 0, output: 0 });
});

test('/cost derives uncached input and allows a measured zero hit rate', async () => {
  const cost = await executeCommand('/cost', { provider: 'claude', tokenUsage: {
    latestResponse: { input: 30, cacheRead: 0, cacheWrite: 10, output: 0 },
  } });
  assert.deepEqual((cost.data as Record<string, unknown>).tokenBreakdown, {
    input: 30, uncachedInput: 20, cacheRead: 0, cacheWrite: 10, output: 0, cacheHitRate: 0,
  });
});

test('/cost neither derives uncached input from a partial breakdown nor divides by zero', async () => {
  const cost = await executeCommand('/cost', { provider: 'claude', tokenUsage: {
    latestResponse: { input: 0, cacheRead: 0 },
  } });
  assert.deepEqual((cost.data as Record<string, unknown>).tokenBreakdown, { input: 0, cacheRead: 0 });
});

test('/cost does not treat a cumulative fallback as a response', async () => {
  const cost = await executeCommand('/cost', { provider: 'claude', tokenUsage: {
    used: 800, total: 160_000, inputTokens: 700, outputTokens: 100, cacheReadTokens: 600,
  } });
  const data = cost.data as Record<string, unknown>;
  assert.deepEqual(data.tokenUsage, { total: 160_000 });
  assert.deepEqual(data.tokenBreakdown, {});
});

test('/cost retains the non-Claude provider breakdown and total', async () => {
  const cost = await executeCommand('/cost', { provider: 'opencode', tokenUsage: {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheCreationTokens: 10, used: 130,
  } });
  const data = cost.data as Record<string, unknown>;
  assert.deepEqual(data.tokenUsage, { used: 130, total: 0 });
  assert.deepEqual(data.tokenBreakdown, { input: 100, output: 20 });
});
