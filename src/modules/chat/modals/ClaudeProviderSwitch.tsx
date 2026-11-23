import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, ApiRequestError, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/shared/ui';

type Profile = { id: string; label: string };
type Selection = { selectedProfile: string | null; revision: number; model: string | null; effort: string | null };
type SessionSettings = Selection & { profiles: Profile[] };
type SettingsLoad = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; settings: SessionSettings };
type ClaudeProviderSwitchProps = {
  sessionId: string;
  disabled: boolean;
  onSwitch: (sessionId: string, selection: Selection) => void;
};

function isValidSelection(data: Selection | undefined): data is Selection {
  return !!data && (data.selectedProfile === null || typeof data.selectedProfile === 'string')
    && Number.isSafeInteger(data.revision) && data.revision >= 0
    && (data.model === null || typeof data.model === 'string')
    && (data.effort === null || typeof data.effort === 'string');
}

/** ChatComposer uses this picker to show and switch the active Claude conversation's profile. */
export function ClaudeProviderSwitch(props: ClaudeProviderSwitchProps) {
  // Changing sessions discards the open dialog, draft choice, and last server snapshot together.
  return <SessionProviderPicker key={props.sessionId} {...props} />;
}

function SessionProviderPicker({ sessionId, disabled, onSwitch }: ClaudeProviderSwitchProps) {
  const { t } = useTranslation('chat');
  const titleId = useId();
  const descriptionId = useId();
  // The dialog is controlled so it cannot close while a switch is being saved.
  const [open, setOpen] = useState(false);
  // Keep the server's profile and revision together, even when the dialog is closed.
  const [load, setLoad] = useState<SettingsLoad>({ status: 'loading' });
  // Refresh on every edit, independently of closing the dialog, so a closed picker still gets a label.
  const [refresh, setRefresh] = useState(0);
  // An empty draft means no explicit choice, not instance authorization.
  const [selection, setSelection] = useState('');
  // Show actionable switch failures without exposing server paths.
  const [error, setError] = useState<'switch' | 'busy' | 'stale' | null>(null);
  // Keep the dialog and confirm button locked until the request settles.
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void api.providers.claudeSessionSettings(sessionId, { signal })
      .then(readApiJson<{ data: SessionSettings }>)
      .then(({ data }) => {
        if (!isValidSelection(data) || !Array.isArray(data.profiles)
          || !data.profiles.every((profile) => typeof profile?.id === 'string' && typeof profile.label === 'string')) {
          throw new Error('Invalid provider settings');
        }
        if (!signal.aborted) setLoad({ status: 'ready', settings: data });
      }).catch(() => {
        if (!signal.aborted) setLoad({ status: 'failed' });
      });
    return () => controller.abort();
  }, [refresh, sessionId]);

  const refreshSettings = useCallback(() => {
    setLoad({ status: 'loading' });
    setRefresh((previous) => previous + 1);
  }, []);

  const changeOpen = useCallback((next: boolean) => {
    if (inFlight.current || (next && disabled)) return;
    setSelection('');
    setError(null);
    if (next) refreshSettings();
    setOpen(next);
  }, [disabled, refreshSettings]);

  const settings = load.status === 'ready' ? load.settings : null;
  const target = selection === ':instance' ? null : selection;
  const canSwitch = !!settings && !!selection && target !== settings.selectedProfile
    && (target === null || settings.profiles.some(({ id }) => id === target));
  const save = async () => {
    if (!settings || !canSwitch || disabled || error === 'stale' || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await readApiJson<{ data: Selection }>(await api.providers.switchClaudeSessionSettings(
        sessionId, target, settings.revision,
      ));
      if (!isValidSelection(result.data)) throw new Error('Invalid provider settings');
      setLoad({ status: 'ready', settings: { ...result.data, profiles: settings.profiles } });
      onSwitch(sessionId, result.data);
      setOpen(false);
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.code === 'CLAUDE_SETTINGS_CHANGED') {
        setError('stale');
        refreshSettings();
      } else {
        setError(failure instanceof ApiRequestError && failure.code === 'SESSION_BUSY' ? 'busy' : 'switch');
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const actionLabel = t('providerSwitch.action', { defaultValue: 'Switch Claude provider' });
  const defaultLabel = t('providerSwitch.instance', { defaultValue: 'Default Claude authorization' });
  const currentLabel = !settings ? (load.status === 'failed'
    ? t('providerSwitch.failedLabel', { defaultValue: 'Provider load failed' })
    : t('providerSwitch.loadingLabel', { defaultValue: 'Loading provider…' }))
    : settings.selectedProfile === null ? defaultLabel
      : settings.profiles.find(({ id }) => id === settings.selectedProfile)?.label
        ?? t('providerSwitch.unavailable', { defaultValue: 'Unavailable Claude provider' });

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        className="flex h-8 min-w-0 max-w-28 items-center rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-56"
        disabled={disabled || saving}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('providerSwitch.trigger', {
          defaultValue: '{{provider}}: {{action}}', provider: currentLabel, action: actionLabel,
        })}
        title={currentLabel}
      >
        <span className="truncate">{currentLabel}</span>
      </DialogTrigger>
      <DialogContent aria-labelledby={titleId} aria-describedby={descriptionId}>
        <DialogTitle id={titleId}>{actionLabel}</DialogTitle>
        <p id={descriptionId} className="text-sm text-muted-foreground">{t('providerSwitch.description', {
          defaultValue: 'Keeps this chat and its history. The selected provider receives the conversation when you next send a message. Your account default stays unchanged.',
        })}</p>
        {settings ? (
          <label className="grid gap-2 text-sm">
            {t('providerSwitch.current', { defaultValue: 'Current: {{provider}}', provider: currentLabel })}
            <select className="rounded-md border bg-background p-2" value={selection}
              disabled={disabled || saving || error === 'stale'} onChange={(event) => setSelection(event.target.value)}>
              <option value="" disabled>{t('providerSwitch.choose', { defaultValue: 'Choose a provider' })}</option>
              <option value=":instance">{defaultLabel}</option>
              {settings.profiles.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
        ) : load.status === 'loading' && <p role="status">{t('providerSwitch.loading', { defaultValue: 'Loading providers…' })}</p>}
        {(error || load.status === 'failed') && <p role="alert" className="text-sm text-destructive">{
          error === 'busy' ? t('providerSwitch.busy', { defaultValue: 'Wait for this session’s turn, Shell, and background work to finish.' })
            : error === 'stale' ? t('providerSwitch.stale', { defaultValue: 'The provider changed in another tab. Reopen this picker.' })
              : load.status === 'failed' ? t('providerSwitch.loadError', { defaultValue: 'Could not load Claude providers. Reopen this picker to try again.' })
                : t('providerSwitch.switchError', { defaultValue: 'Could not switch to the selected provider.' })
        }</p>}
        <Button type="button" disabled={disabled || !canSwitch || saving || error === 'stale'} onClick={() => void save()}>
          {t('providerSwitch.confirm', { defaultValue: 'Switch this chat' })}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
