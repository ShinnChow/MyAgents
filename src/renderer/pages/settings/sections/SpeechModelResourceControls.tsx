import { Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SpeechModelPackStatus } from '@/../shared/types/record';

interface SpeechModelResourceControlsProps {
  status: SpeechModelPackStatus | null;
  onInstall?: () => void;
  onRemove?: () => void;
}

const ACTIVATION_DURABILITY_WARNING =
  'SPEECH_RESOURCE_ACTIVATION_DURABILITY_UNCONFIRMED';

export function SpeechModelResourceControls({
  status,
  onInstall,
  onRemove,
}: SpeechModelResourceControlsProps) {
  const { t } = useTranslation('settings');
  const busy = [
    'checking',
    'downloading',
    'verifying',
    'installing',
    'removing',
  ].includes(status?.status ?? '');
  const downloading = status?.status === 'downloading';
  const downloadPercent =
    status && status.totalDownloadBytes > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(
              (status.downloadedBytes / status.totalDownloadBytes) * 100,
            ),
          ),
        )
      : 0;
  const hasActivationWarning =
    status?.lastErrorCode === ACTIVATION_DURABILITY_WARNING;
  const error =
    status?.status === 'error' && !hasActivationWarning
      ? status.lastErrorCode
        ? t(`toolbox.speechResource.errors.${status.lastErrorCode}`, {
            defaultValue: t('toolbox.speechResource.errors.default'),
          })
        : t('toolbox.speechResource.errors.default')
      : null;
  const removeError =
    status?.status === 'error' &&
    ['SPEECH_RESOURCE_CHANGED', 'SPEECH_RESOURCE_REMOVE_FAILED'].includes(
      status.lastErrorCode ?? '',
    );

  if (!status || (status.status === 'ready' && !hasActivationWarning)) {
    return null;
  }

  if (busy) {
    const progressLabel = t(`toolbox.speechResource.states.${status.status}`);

    return (
      <div className="mt-3 border-t border-[var(--line)] pt-3">
        <div className="flex items-center gap-3">
          <div
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--paper-inset)]"
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={downloading ? 0 : undefined}
            aria-valuemax={downloading ? 100 : undefined}
            aria-valuenow={downloading ? downloadPercent : undefined}
          >
            {downloading ? (
              <div
                className="h-full w-full origin-left rounded-full bg-[var(--accent)] transition-transform duration-300"
                style={{ transform: `scaleX(${downloadPercent / 100})` }}
              />
            ) : (
              <div className="animate-indeterminate h-full w-1/3 rounded-full bg-[var(--accent)]" />
            )}
          </div>
          <button
            type="button"
            disabled
            className="inline-flex shrink-0 cursor-wait items-center rounded-lg border border-[var(--line)] px-2 py-1 text-xs font-medium text-[var(--ink-muted)] opacity-70"
          >
            {status.status === 'removing'
              ? t('toolbox.speechResource.removingAction')
              : t('toolbox.speechResource.installingAction')}
          </button>
        </div>
      </div>
    );
  }

  const message = hasActivationWarning
    ? t('toolbox.speechResource.activationWarning')
    : (error ?? t(`toolbox.speechResource.states.${status.status}`));

  return (
    <div className="mt-3 border-t border-[var(--line)] pt-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <p
          className={`min-w-0 leading-relaxed ${error || hasActivationWarning ? 'text-[var(--danger)]' : 'font-medium text-[var(--ink)]'}`}
          role="status"
          aria-live="polite"
        >
          {message}
        </p>

        {removeError ? (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--danger)] disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('toolbox.speechResource.retryRemove')}
          </button>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
          >
            {error || hasActivationWarning ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {hasActivationWarning
              ? t('toolbox.speechResource.reinstall')
              : error
                ? t('toolbox.speechResource.retry')
                : status.status === 'update_available'
                  ? t('toolbox.speechResource.update')
                  : t('toolbox.speechResource.install')}
          </button>
        )}
      </div>
    </div>
  );
}
