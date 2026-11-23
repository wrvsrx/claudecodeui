import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

type ClaudeProfile = { id: string; label: string };

type ClaudeAccountSettings = {
  profiles: ClaudeProfile[];
  selectedProfile: string | null;
};

type SettingsRequest = { kind: 'load' } | { kind: 'save'; selectedProfile: string | null };

function isProfile(value: unknown): value is ClaudeProfile {
  return !!value && typeof value === 'object'
    && 'id' in value && typeof value.id === 'string' && value.id.trim() !== ''
    && 'label' in value && typeof value.label === 'string' && value.label.trim() !== '';
}

function isAccountSettings(value: unknown): value is ClaudeAccountSettings {
  return !!value && typeof value === 'object'
    && 'profiles' in value && Array.isArray(value.profiles) && value.profiles.every(isProfile)
    && new Set(value.profiles.map(({ id }) => id)).size === value.profiles.length
    && 'selectedProfile' in value
    && (value.selectedProfile === null || (typeof value.selectedProfile === 'string' && value.selectedProfile.trim() !== ''));
}

export function useClaudeAccountSettings(enabled: boolean) {
  // Keep the last server-confirmed default visible until a write succeeds, even if that write fails.
  const [settings, setSettings] = useState<ClaudeAccountSettings | null>(null);
  // Tell the panel whether to allow editing and which request failure to explain.
  const [status, setStatus] = useState<'loading' | 'saving' | 'ready' | 'loadError' | 'saveError'>('loading');
  // Prevent duplicate requests before React disables the picker and ignore replies after leaving the panel.
  const activeRequest = useRef<AbortController | null>(null);

  const request = useCallback(async (action: SettingsRequest) => {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const { signal } = controller;
    setStatus(action.kind === 'load' ? 'loading' : 'saving');
    if (action.kind === 'load') setSettings(null);

    try {
      const response = action.kind === 'load'
        ? await api.providers.claudeSettings({ signal })
        : await api.providers.updateClaudeSettings(action.selectedProfile, { signal });
      const body = await readApiJson<unknown>(response);
      if (signal.aborted) return;
      if (!isAccountSettings(body)) throw new Error('Invalid Claude account settings response');
      setSettings(body);
      setStatus('ready');
    } catch {
      if (!signal.aborted) setStatus(action.kind === 'load' ? 'loadError' : 'saveError');
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void request({ kind: 'load' });
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [enabled, request]);

  return {
    profiles: settings?.profiles ?? [],
    selectedProfile: settings?.selectedProfile ?? null,
    hasLoaded: settings !== null,
    status,
    reload: () => void request({ kind: 'load' }),
    selectProfile: (selectedProfile: string | null) => {
      if (!settings || selectedProfile === settings.selectedProfile) return;
      if (selectedProfile !== null && !settings.profiles.some(({ id }) => id === selectedProfile)) return;
      void request({ kind: 'save', selectedProfile });
    },
  };
}
