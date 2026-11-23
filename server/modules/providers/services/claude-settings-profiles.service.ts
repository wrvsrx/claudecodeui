import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk';

import { userPreferencesDb } from '@/modules/database/index.js';
import { CLAUDE_SETTINGS_PROFILE_PREFERENCE_KEY } from '@/shared/index.js';
import { AppError } from '@/shared/utils.js';

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(filePath: string): unknown {
  if (!path.isAbsolute(filePath) || filePath.includes('\0') || !statSync(filePath).isFile()) {
    throw new Error('Expected an absolute path to a regular JSON file.');
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

function readProfiles(): Map<string, { label: string; path: string }> {
  const profiles = new Map<string, { label: string; path: string }>();
  const manifestPath = process.env.CLOUDCLI_CLAUDE_SETTINGS_PROFILES;
  if (manifestPath === undefined) {
    return profiles;
  }

  try {
    const manifest = readJson(manifestPath);
    if (!isRecord(manifest)) {
      throw new Error('Expected a profile map.');
    }
    for (const [id, profile] of Object.entries(manifest)) {
      if (!PROFILE_ID.test(id) || !isRecord(profile)
        || typeof profile.label !== 'string' || !profile.label.trim()
        || typeof profile.path !== 'string' || !path.isAbsolute(profile.path) || profile.path.includes('\0')) {
        throw new Error('Invalid profile declaration.');
      }
      profiles.set(id, { label: profile.label, path: profile.path });
    }
  } catch {
    // Never include a raw filesystem or JSON error in an API response.
    throw new AppError('Claude settings profiles are misconfigured on the server.', {
      code: 'CLAUDE_SETTINGS_PROFILES_MISCONFIGURED', statusCode: 503,
    });
  }
  return profiles;
}

function readSettings(settingsPath: string): Settings {
  try {
    const settings = readJson(settingsPath);
    if (!isRecord(settings)) {
      throw new Error('Expected a settings object.');
    }
    // The SDK validates the Claude-specific settings schema. Only the server's
    // manifest above can supply a filename here.
    return settings as Settings;
  } catch {
    throw new AppError('The selected Claude settings profile could not be loaded.', {
      code: 'CLAUDE_SETTINGS_PROFILE_UNAVAILABLE', statusCode: 503,
    });
  }
}

function readAccountSelection(userId: number): string | null {
  try {
    const value = userPreferencesDb.getPreference(userId, CLAUDE_SETTINGS_PROFILE_PREFERENCE_KEY);
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && PROFILE_ID.test(value)) return value;
  } catch {
    // Never let a failed read become a request to use the instance credentials.
  }
  throw new AppError('The saved Claude settings profile could not be read. Choose a profile or reset it in Account settings.', {
    code: 'CLAUDE_SETTINGS_PROFILE_UNAVAILABLE', statusCode: 409,
  });
}

function accountSettingsResponse(
  profiles: ReturnType<typeof readProfiles>,
  selectedProfile: string | null,
) {
  return {
    profiles: Array.from(profiles, ([id, { label }]) => ({ id, label })),
    selectedProfile,
  };
}

// Providers routes manage the account default; session creation pins it and
// the runtime uses only the session's binding, never the live account default.
export const claudeSettingsProfilesService = {
  getAccountSettings(userId: number) {
    // Keep removed ids visible so the UI can explain why an explicit reset is needed.
    return accountSettingsResponse(readProfiles(), readAccountSelection(userId));
  },

  setAccountSelection(userId: number, selectedProfile: string | null) {
    const profiles = readProfiles();
    if (selectedProfile !== null) {
      const profile = profiles.get(selectedProfile);
      if (!profile) {
        throw new AppError('Unknown Claude settings profile.', {
          code: 'UNKNOWN_CLAUDE_SETTINGS_PROFILE', statusCode: 400,
        });
      }
      readSettings(profile.path);
    }
    userPreferencesDb.savePreferences(userId, {
      [CLAUDE_SETTINGS_PROFILE_PREFERENCE_KEY]: selectedProfile ?? undefined,
    });
    return accountSettingsResponse(profiles, selectedProfile);
  },

  resolveNewSessionProfileId(userId: number): string | undefined {
    const selectedProfile = readAccountSelection(userId);
    if (selectedProfile === null) return undefined;

    const profile = readProfiles().get(selectedProfile);
    if (!profile) {
      throw new AppError('Your saved Claude settings profile is no longer enabled. Choose a profile or reset it in Account settings.', {
        code: 'CLAUDE_SETTINGS_PROFILE_UNAVAILABLE', statusCode: 409,
      });
    }
    readSettings(profile.path);
    return selectedProfile;
  },

  applyToSdkOptions(
    profileId: string,
    options: { settings?: Settings; env: NodeJS.ProcessEnv },
  ): NonNullable<Options['settings']> {
    const profile = readProfiles().get(profileId);
    if (!profile) {
      throw new AppError('This session’s Claude settings profile is no longer enabled.', {
        code: 'CLAUDE_SETTINGS_PROFILE_UNAVAILABLE', statusCode: 409,
      });
    }
    const settings = readSettings(profile.path);
    // Inherited static credentials may take precedence over the selected
    // profile's helper. Do not mutate process.env or affect default sessions.
    if (settings.apiKeyHelper) {
      delete options.env.ANTHROPIC_API_KEY;
      delete options.env.ANTHROPIC_AUTH_TOKEN;
      delete options.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (settings.env?.ANTHROPIC_BASE_URL) {
      delete options.env.ANTHROPIC_BASE_URL;
    }
    return options.settings ? { ...settings, ...options.settings } : profile.path;
  },
};
