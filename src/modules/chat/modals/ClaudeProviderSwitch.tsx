import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, ApiRequestError, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type Profile = { id: string; label: string };
type Selection = { selectedProfile: string | null; revision: number; model: string | null; effort: string | null };

/** ChatInterface uses this picker to switch only the active Claude conversation. */
export function ClaudeProviderSwitch({ sessionId, disabled, onSwitch }: {
  sessionId: string;
  disabled: boolean;
  onSwitch: (sessionId: string, selection: Selection) => void;
}) {
  const { t } = useTranslation('chat');
  const descriptionId = useId();
  // Load fresh selections from the server when the picker opens.
  const [open, setOpen] = useState(false);
  // Keep the previous revision so another tab's switch cannot be overwritten.
  const [data, setData] = useState<{ profiles: Profile[]; current: Selection } | null>(null);
  // Empty means no explicit choice, not instance authorization.
  const [selection, setSelection] = useState('');
  // Show actionable failures without exposing server paths.
  const [error, setError] = useState<'load' | 'switch' | 'busy' | 'stale' | null>(null);
  // Keep the dialog and confirm button locked until the request settles.
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    void api.providers.claudeSessionSettings(sessionId, { signal })
      .then(readApiJson<{ data: Selection & { profiles: Profile[] } }>)
      .then(({ data: current }) => {
        if (!Array.isArray(current?.profiles) || !Number.isSafeInteger(current.revision)) throw new Error('Invalid provider settings');
        if (!signal.aborted) setData({ profiles: current.profiles, current });
      }).catch(() => {
        if (!signal.aborted) setError('load');
      });
    return () => controller.abort();
  }, [open, sessionId]);

  const changeOpen = (next: boolean) => {
    if (inFlight.current) return;
    setData(null);
    setSelection('');
    setError(null);
    setOpen(next);
  };

  const target = selection === ':instance' ? null : selection;
  const canSwitch = !!data && !!selection && target !== data.current.selectedProfile
    && (target === null || data.profiles.some(({ id }) => id === target));
  const save = async () => {
    if (!data || !canSwitch || disabled || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await readApiJson<{ data: Selection }>(await api.providers.switchClaudeSessionSettings(
        sessionId, target, data.current.revision,
      ));
      onSwitch(sessionId, result.data);
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof ApiRequestError && failure.code === 'SESSION_BUSY' ? 'busy'
        : failure instanceof ApiRequestError && failure.code === 'CLAUDE_SETTINGS_CHANGED' ? 'stale' : 'switch');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const defaultLabel = t('providerSwitch.instance', { defaultValue: 'Default Claude authorization' });
  const currentLabel = !data ? '' : data.current.selectedProfile === null ? defaultLabel
    : data.profiles.find(({ id }) => id === data.current.selectedProfile)?.label
      ?? t('providerSwitch.unavailable', { defaultValue: 'Unavailable Claude provider' });

  return (
    <>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => changeOpen(true)}>
        {t('providerSwitch.action', { defaultValue: 'Switch Claude provider' })}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent aria-describedby={descriptionId}>
          <DialogTitle>{t('providerSwitch.action', { defaultValue: 'Switch Claude provider' })}</DialogTitle>
          <p id={descriptionId} className="text-sm text-muted-foreground">{t('providerSwitch.description', {
            defaultValue: 'Keeps this chat and its history. The selected provider receives the conversation when you next send a message. Your account default stays unchanged.',
          })}</p>
          {data ? (
            <label className="grid gap-2 text-sm">
              {t('providerSwitch.current', { defaultValue: 'Current: {{provider}}', provider: currentLabel })}
              <select className="rounded-md border bg-background p-2" value={selection} disabled={saving}
                onChange={(event) => setSelection(event.target.value)}>
                <option value="" disabled>{t('providerSwitch.choose', { defaultValue: 'Choose a provider' })}</option>
                <option value=":instance">{defaultLabel}</option>
                {data.profiles.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
          ) : !error && <p role="status">{t('providerSwitch.loading', { defaultValue: 'Loading providers…' })}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{
            error === 'busy' ? t('providerSwitch.busy', { defaultValue: 'Wait for this session’s turn, Shell, and background work to finish.' })
              : error === 'stale' ? t('providerSwitch.stale', { defaultValue: 'The provider changed in another tab. Reopen this picker.' })
                : error === 'load' ? t('providerSwitch.loadError', { defaultValue: 'Could not load Claude providers. Reopen this picker to try again.' })
                  : t('providerSwitch.switchError', { defaultValue: 'Could not switch to the selected provider.' })
          }</p>}
          <Button type="button" disabled={disabled || !canSwitch || saving || error === 'stale'} onClick={() => void save()}>
            {t('providerSwitch.confirm', { defaultValue: 'Switch this chat' })}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
