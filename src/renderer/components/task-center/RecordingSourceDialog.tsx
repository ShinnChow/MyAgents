import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MonitorUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { RecordingSourceSelection } from '@/../shared/types/record';

interface Props {
  mode: 'start' | 'settings';
  initialSelection: RecordingSourceSelection;
  modelPackUsable?: boolean;
  error?: string | null;
  busy?: boolean;
  onConfirm: (selection: RecordingSourceSelection) => void | Promise<void>;
  onCancel: () => void;
  onOpenSpeechSettings: () => void;
}

function sourceErrorMessage(error: string, t: (key: string) => string): string {
  if (error.includes('RECORDING_SCREEN_PERMISSION_REQUIRED')) {
    return t('records.screenPermissionRequired');
  }
  if (error.includes('RECORDING_MICROPHONE_PERMISSION_REQUIRED')) {
    return t('records.microphonePermissionRequired');
  }
  if (error.includes('RECORDING_MICROPHONE_UNAVAILABLE')) {
    return t('records.microphoneUnavailable');
  }
  if (error.includes('RECORDING_SYSTEM_AUDIO_UNAVAILABLE')) {
    return t('records.systemAudioUnavailable');
  }
  if (error.includes('RECORDING_DISK_LOW')) {
    return t('records.recordingDiskLow');
  }
  return error;
}

export default function RecordingSourceDialog({
  mode,
  initialSelection,
  modelPackUsable,
  error,
  busy = false,
  onConfirm,
  onCancel,
  onOpenSpeechSettings,
}: Props) {
  const { t } = useTranslation('task');
  const [selection, setSelection] =
    useState<RecordingSourceSelection>(initialSelection);
  const [settingsError, setSettingsError] = useState(false);
  const hasSource = selection.microphone || selection.system;
  const platform = useMemo(() => navigator.platform.toLowerCase(), []);
  const microphonePermissionError =
    error?.includes('RECORDING_MICROPHONE_PERMISSION_REQUIRED') ||
    error?.includes('RECORDING_MICROPHONE_UNAVAILABLE') ||
    false;
  const screenPermissionError =
    error?.includes('RECORDING_SCREEN_PERMISSION_REQUIRED') ?? false;
  const hasSpecificPermissionError =
    microphonePermissionError || screenPermissionError;

  useCloseLayer(
    useCallback(() => {
      if (busy) return true;
      onCancel();
      return true;
    }, [busy, onCancel]),
    300,
  );

  const openPrivacySettings = useCallback(
    async (source: 'microphone' | 'system') => {
      let target: string | null = null;
      if (platform.includes('mac')) {
        target =
          source === 'microphone'
            ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
            : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
      } else if (platform.includes('win') && source === 'microphone') {
        target = 'ms-settings:privacy-microphone';
      }
      if (!target) return;
      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(target);
        setSettingsError(false);
      } catch {
        setSettingsError(true);
      }
    },
    [platform],
  );

  const sourceOptions = [
    {
      key: 'microphone' as const,
      icon: <Mic className="h-4 w-4" />,
      title: t('records.microphone'),
      description: t('records.microphoneSourceDescription'),
    },
    {
      key: 'system' as const,
      icon: <MonitorUp className="h-4 w-4" />,
      title: t('records.system'),
      description: t('records.systemSourceDescription'),
    },
  ];

  return createPortal(
    <OverlayBackdrop
      onClose={busy ? undefined : onCancel}
      className="z-[300] px-4"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="recording-source-dialog-title"
        className="glass-panel w-full max-w-md overflow-hidden"
      >
        <header className="border-b border-[var(--line)] px-5 py-4">
          <h2
            id="recording-source-dialog-title"
            className="text-lg font-semibold text-[var(--ink)]"
          >
            {t('records.recordingSources')}
          </h2>
        </header>

        <div className="space-y-3 px-5 py-4">
          {sourceOptions.map((option) => {
            const selected = selection[option.key];
            return (
              <button
                key={option.key}
                type="button"
                role="checkbox"
                aria-checked={selected}
                disabled={busy}
                onClick={() =>
                  setSelection((current) => ({
                    ...current,
                    [option.key]: !current[option.key],
                  }))
                }
                className={`flex w-full items-start gap-3 rounded-[var(--radius-lg)] border px-3 py-3 text-left transition-[background-color,border-color,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60 ${
                  selected
                    ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)]'
                    : 'border-[var(--line)] bg-[var(--paper-inset)] hover:border-[var(--line-strong)]'
                }`}
              >
                <span
                  className={`mt-0.5 shrink-0 ${selected ? 'text-[var(--accent-warm)]' : 'text-[var(--ink-muted)]'}`}
                >
                  {option.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-[var(--ink)]">
                    {option.title}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-[var(--ink-muted)]">
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}

          {!hasSource && (
            <p className="text-xs text-[var(--error)]" role="alert">
              {t('records.recordingSourceRequired')}
            </p>
          )}

          {modelPackUsable === false && (
            <div className="rounded-[var(--radius-md)] bg-[var(--warning-bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--ink-secondary)]">
              {t('records.recordingWithoutTranscript')}{' '}
              <button
                type="button"
                onClick={onOpenSpeechSettings}
                className="font-semibold text-[var(--accent-warm)] hover:underline"
              >
                {t('records.openSpeechTool')}
              </button>
            </div>
          )}

          {error && (
            <div
              className="rounded-[var(--radius-md)] bg-[var(--error-bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--error)]"
              role="alert"
            >
              {sourceErrorMessage(error, t)}
              <div className="mt-2 flex flex-wrap gap-3">
                {platform.includes('mac') &&
                  selection.microphone &&
                  (!hasSpecificPermissionError ||
                    microphonePermissionError) && (
                    <button
                      type="button"
                      onClick={() => void openPrivacySettings('microphone')}
                      className="font-semibold hover:underline"
                    >
                      {t('records.openMicrophoneSettings')}
                    </button>
                  )}
                {platform.includes('mac') &&
                  selection.system &&
                  (!hasSpecificPermissionError || screenPermissionError) && (
                    <button
                      type="button"
                      onClick={() => void openPrivacySettings('system')}
                      className="font-semibold hover:underline"
                    >
                      {t('records.openScreenSettings')}
                    </button>
                  )}
                {platform.includes('win') &&
                  selection.microphone &&
                  (!hasSpecificPermissionError ||
                    microphonePermissionError) && (
                    <button
                      type="button"
                      onClick={() => void openPrivacySettings('microphone')}
                      className="font-semibold hover:underline"
                    >
                      {t('records.openMicrophoneSettings')}
                    </button>
                  )}
              </div>
              {settingsError && (
                <p className="mt-2">{t('records.openPrivacySettingsFailed')}</p>
              )}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-[var(--radius-md)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
          >
            {t('records.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm(selection)}
            disabled={busy || !hasSource}
            className="rounded-[var(--radius-md)] bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
          >
            {busy
              ? t('records.startingRecording')
              : t(
                  mode === 'start'
                    ? 'records.startRecording'
                    : 'records.saveRecordingSources',
                )}
          </button>
        </footer>
      </section>
    </OverlayBackdrop>,
    document.body,
  );
}
