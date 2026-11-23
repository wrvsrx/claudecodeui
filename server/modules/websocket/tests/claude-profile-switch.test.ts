import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '../services/chat-run-registry.service.js';
import { runDetachedChatTurn } from '../services/chat-websocket.service.js';
import type { AnyRecord } from '@/shared/types.js';

test('a stale queued or scheduled send cannot restore the model and effort from before a profile switch', async () => {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-switch-dispatch-'));
  const sessionId = 'stable-chat-id';
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  try {
    await initializeDatabase();
    sessionsDb.createAppSession(sessionId, 'claude', dir);
    sessionsDb.assignProviderSessionId(sessionId, 'stable-native-id');
    sessionsDb.switchClaudeSettingsProfile(sessionId, 'target', 'default');
    const received: AnyRecord[] = [];
    const runtime = { hasRuntime: () => true, run: async (_provider: string, _command: string, options: AnyRecord) => {
      received.push(options);
    } } as never;
    const send = () => runDetachedChatTurn({ sessionId, userId: 1, content: 'follow-up',
      options: { model: 'stale-model', effort: 'high' } }, { runtime });
    assert.equal((await send()).started, true);
    assert.equal(received[0].model, 'default');
    assert.equal(received[0].effort, 'default');
    sessionsDb.setSessionModel(sessionId, 'explicit-new-model');
    assert.equal((await send()).started, true);
    assert.equal(received[1].model, 'explicit-new-model');
    assert.equal(sessionsDb.getSessionById(sessionId)?.provider_session_id, 'stable-native-id');
    assert.equal(sessionsDb.getSessionById(sessionId)?.claude_settings_profile_id, 'target');
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
