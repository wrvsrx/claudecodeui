import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb, userDb, userPreferencesDb } from '@/modules/database/index.js';
import { CLAUDE_SETTINGS_PROFILE_PREFERENCE_KEY } from '@/shared/index.js';
import { AppError } from '@/shared/utils.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';
import { claudeSettingsProfilesRoutes } from '../claude-settings-profiles.routes.js';
import { CLAUDE_PREDEFINED_MODELS } from '../list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '../list/claude/claude-runtime.provider.js';
import providerRouter from '../provider.routes.js';
import { claudeSettingsProfilesService } from '../services/claude-settings-profiles.service.js';
import { sessionsService } from '../services/sessions.service.js';

const MANIFEST_ENV = 'CLOUDCLI_CLAUDE_SETTINGS_PROFILES';
const profileSettings = { apiKeyHelper: 'echo not-a-real-key', env: { ANTHROPIC_BASE_URL: 'https://gateway.invalid' } };

async function withFixture(run: (fixture: { dir: string; manifest: string; settings: string }) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudcli-claude-settings-'));
  const manifest = path.join(dir, 'manifest.json');
  const settings = path.join(dir, 'server-only-settings.json');
  const previous = Object.fromEntries([
    MANIFEST_ENV, 'DATABASE_PATH', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  ].map((key) => [key, process.env[key]]));
  try {
    process.env[MANIFEST_ENV] = manifest;
    closeConnection();
    process.env.DATABASE_PATH = path.join(dir, 'test.db');
    await writeFile(process.env.DATABASE_PATH, '');
    await writeFile(manifest, JSON.stringify({ gateway: { label: 'Gateway', path: settings } }));
    await writeFile(settings, JSON.stringify(profileSettings));
    await initializeDatabase();
    await run({ dir, manifest, settings });
  } finally {
    closeConnection();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test('authenticated accounts select and pin Claude profiles independently', async () => {
  await withFixture(async ({ dir, manifest, settings }) => {
    const { authenticateToken, createAuthModule } = await import('@/modules/auth/index.js');
    const { userRoutes } = await import('@/modules/user/index.js');
    const app = express().use(express.json())
      .use('/api/auth', createAuthModule(null))
      .use('/api/claude-settings', authenticateToken, claudeSettingsProfilesRoutes)
      .use('/api/providers', authenticateToken, providerRouter)
      .use('/api/user', authenticateToken, userRoutes);
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      assert.ok(error instanceof AppError);
      res.status(error.statusCode).json({ code: error.code, message: error.message });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const credentials = (username: string) => JSON.stringify({ username, password: 'test-password' });
      const json = { 'content-type': 'application/json' };
      const register = await fetch(`${base}/auth/register`, {
        method: 'POST', headers: json, body: credentials('profile-user'),
      });
      assert.ok(register.ok);
      const { token } = await register.json() as { token: string };
      const firstUser = userDb.getUserByUsername('profile-user');
      assert.ok(firstUser);
      // Registration intentionally supports a single account. Seed a second row
      // and log in normally to exercise token isolation without changing Auth.
      const secondUser = userDb.createUser('second-user', firstUser.password_hash);
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: json, body: credentials('second-user'),
      });
      assert.ok(login.ok);
      const { token: secondToken } = await login.json() as { token: string };
      const headers = { ...json, authorization: `Bearer ${token}` };
      const secondHeaders = { ...json, authorization: `Bearer ${secondToken}` };
      const get = (requestHeaders = headers) => fetch(`${base}/claude-settings`, { headers: requestHeaders });
      const put = (body: unknown, requestHeaders: Record<string, string> = headers) => fetch(`${base}/claude-settings`, {
        method: 'PUT', headers: requestHeaders, body: JSON.stringify(body),
      });
      const create = (provider: string, requestHeaders = headers, extra = {}) => fetch(`${base}/providers/sessions`, {
        method: 'POST', headers: requestHeaders, body: JSON.stringify({ provider, projectPath: dir, ...extra }),
      });
      const createSession = async (provider: string, requestHeaders = headers, extra = {}) => {
        const response = await create(provider, requestHeaders, extra);
        assert.equal(response.status, 201);
        const payload = await response.json() as { data: { sessionId: string } };
        assert.equal(JSON.stringify(payload).includes(settings), false);
        return payload.data.sessionId;
      };
      const boundProfile = (id: string) => sessionsDb.getSessionById(id)?.claude_settings_profile_id;
      const profiles = [{ id: 'gateway', label: 'Gateway' }];
      assert.equal((await fetch(`${base}/claude-settings`)).status, 401);
      assert.equal((await put({ selectedProfile: 'gateway' }, json)).status, 401);
      const listed = await get();
      assert.equal(listed.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await listed.json(), { profiles, selectedProfile: null });
      const oldDefault = await createSession('claude');

      assert.equal((await put({})).status, 400);
      assert.equal((await put([])).status, 400);
      for (const id of ['toString', '__proto__', 'unknown', settings, '', 1, { path: settings }]) {
        assert.equal((await put({ selectedProfile: id })).status, 400, String(id));
      }
      const selected = await put({ selectedProfile: 'gateway', userId: secondUser.id });
      assert.equal(selected.status, 200);
      assert.equal(selected.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await selected.json(), { profiles, selectedProfile: 'gateway' });
      // A fresh DB connection and HTTP read must observe the stored selection.
      closeConnection();
      await initializeDatabase();
      assert.deepEqual(await (await get()).json(), { profiles, selectedProfile: 'gateway' });
      assert.deepEqual(await (await get(secondHeaders)).json(), { profiles, selectedProfile: null });
      assert.equal(boundProfile(await createSession('claude', secondHeaders, { userId: firstUser.id })), null);
      assert.equal(boundProfile(await createSession('codex')), null);
      assert.equal(boundProfile(oldDefault), null);
      const pinned = await createSession('claude');
      assert.equal(boundProfile(pinned), 'gateway');
      assert.equal((await create('claude', headers, { claudeSettingsProfile: 'gateway' })).status, 400);
      assert.equal((await create('claude', headers, { claudeSettingsProfile: null })).status, 400);

      const genericUpdate = await fetch(`${base}/user/preferences`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ [CLAUDE_SETTINGS_PROFILE_PREFERENCE_KEY]: 'unknown' }),
      });
      assert.equal(genericUpdate.status, 400);
      assert.deepEqual(await (await get()).json(), { profiles, selectedProfile: 'gateway' });

      await writeFile(manifest, 'not JSON');
      const broken = await get();
      assert.equal(broken.status, 503);
      assert.equal((await broken.text()).includes(manifest), false);
      assert.equal((await create('claude')).status, 503);
      delete process.env[MANIFEST_ENV];
      assert.deepEqual(await (await get()).json(), { profiles: [], selectedProfile: 'gateway' });
      const unavailable = await create('claude');
      assert.equal(unavailable.status, 409);
      assert.match(JSON.stringify(await unavailable.json()), /Account settings/);
      assert.equal(boundProfile(await createSession('claude', secondHeaders)), null);
      assert.deepEqual(await (await put({ selectedProfile: null })).json(), { profiles: [], selectedProfile: null });
      assert.equal(boundProfile(await createSession('claude')), null);
      assert.equal(boundProfile(pinned), 'gateway');

      // Invalid stored values must not silently fall back to host credentials.
      userPreferencesDb.savePreferences(firstUser.id, { [CLAUDE_SETTINGS_PROFILE_PREFERENCE_KEY]: { path: settings } });
      assert.equal((await get()).status, 409);
      assert.equal((await create('claude')).status, 409);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test('Claude queries use the persisted profile on first run and resume, never raw chat options', async () => {
  await withFixture(async ({ dir, manifest, settings }) => {
    const userId = Number(userDb.createUser('profile-user', 'hash').id);
    const defaultId = sessionsService.createAppSession('claude', dir, 'Hello', userId).sessionId;
    claudeSettingsProfilesService.setAccountSelection(userId, 'gateway');
    const { sessionId } = sessionsService.createAppSession('claude', dir, 'Hello', userId);
    claudeSettingsProfilesService.setAccountSelection(userId, null);
    const captured: AnyRecord[] = [];
    const sent: AnyRecord[] = [];
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: (id) => sessionsService.resolveProviderSessionId(id),
      resolveClaudeSettingsProfileId: (id) => sessionsService.resolveClaudeSettingsProfileId(id),
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
      createQuery: ({ options }) => {
        captured.push(options);
        const stream = (async function* () { yield* []; })();
        return Object.assign(stream, { interrupt: async () => {} });
      },
    };
    const run = (id: string, options: AnyRecord = {}) => queryClaudeSDK('hello', {
      sessionId: id, cwd: dir, settings: '/client/settings.json', claudeSettingsProfile: 'client', ...options,
    }, { userId: null, send: (message: AnyRecord) => { sent.push(message); } }, context);
    process.env.ANTHROPIC_API_KEY = 'host-test-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'host-test-token';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-test-oauth';
    process.env.ANTHROPIC_BASE_URL = 'https://host-gateway.invalid';
    await run(sessionId);
    assert.equal(captured[0]?.settings, settings);
    assert.equal(captured[0]?.resume, undefined);
    assert.equal(captured[0]?.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(captured[0]?.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(captured[0]?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(captured[0]?.env.ANTHROPIC_BASE_URL, undefined);
    sessionsDb.assignProviderSessionId(sessionId, 'native-claude-id');
    closeConnection();
    await initializeDatabase();
    await run(sessionId);
    assert.equal(captured[1]?.resume, 'native-claude-id');
    assert.equal(captured[1]?.settings, settings);
    await run(defaultId);
    assert.equal(captured[2]?.settings, undefined);
    assert.equal(captured[2]?.env.ANTHROPIC_API_KEY, 'host-test-key');
    assert.equal(captured[2]?.env.ANTHROPIC_AUTH_TOKEN, 'host-test-token');
    await run(sessionId, { model: 'claude-fable-5', effort: 'ultracode' });
    assert.deepEqual(captured[3]?.settings, { ...profileSettings, ultracode: true, enableWorkflows: true });
    assert.equal(captured[3]?.effort, 'xhigh');
    await writeFile(manifest, '{}');
    await run(sessionId);
    assert.equal(captured.length, 4, 'a removed profile must not start an SDK process');
    assert.ok(sent.some((message) => message.kind === 'error' && String(message.content).includes('no longer enabled')));
  });
});
