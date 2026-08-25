import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SpeechModelPackStatus } from '@/../shared/types/record';

interface SpeechModelResourceControlsProps {
  status: SpeechModelPackStatus | null;
  onInstall?: () => void;
  onRemove?: () => void;
}

const ACTIVATION_DURABILITY_WARNING =
  'SPEECH_RESOURCE_ACTIVATION_DURABILITY_UNCONFIRMED';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MiB';
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MiB`;
}

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

  return (
    <div className="mt-3 border-t border-[var(--line)] pt-3">
      <div
        className="flex flex-wrap items-center gap-1.5"
        aria-label={t('toolbox.speechResource.capabilities')}
      >
        {['ASR', 'VAD', t('toolbox.speechResource.diarization')].map(
          (capability) => (
            <span
              key={capability}
              className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]"
            >
              {capability}
            </span>
          ),
        )}
      </div>

      <div className="mt-2 flex items-start justify-between gap-3 text-xs">
        <div className="min-w-0">
          <p
            className="font-medium text-[var(--ink)]"
            role="status"
            aria-live="polite"
          >
            {status
              ? t(`toolbox.speechResource.states.${status.status}`)
              : t('toolbox.speechResource.loading')}
          </p>
          <p
            className="mt-0.5 truncate text-[var(--ink-muted)]"
            title={
              status?.status === 'update_available'
                ? `${status.activeRevision ?? '—'} → ${status.availableRevision}`
                : (status?.activeRevision ?? status?.availableRevision)
            }
          >
            sherpa-onnx · SenseVoice
            {status?.status === 'update_available'
              ? ` · ${status.activeRevision ?? '—'} → ${status.availableRevision}`
              : status?.activeRevision
                ? ` · ${status.activeRevision}`
                : ''}
          </p>
        </div>

        {status?.status === 'ready' || removeError ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--danger)] disabled:cursor-wait disabled:opacity-60"
          >
            {removeError ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {removeError
              ? t('toolbox.speechResource.retryRemove')
              : t('toolbox.speechResource.remove')}
          </button>
        ) : !busy && status ? (
          <button
            type="button"
            onClick={onInstall}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--line)] px-2 py-1 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
          >
            {error ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {error
              ? t('toolbox.speechResource.retry')
              : status.status === 'update_available'
                ? t('toolbox.speechResource.update')
                : t('toolbox.speechResource.install')}
          </button>
        ) : null}
      </div>

      {busy && status && (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-xs text-[var(--ink-muted)]">
            <span>
              {downloading
                ? t('toolbox.speechResource.downloadProgress', {
                    downloaded: formatBytes(status.downloadedBytes),
                    total: formatBytes(status.totalDownloadBytes),
                  })
                : t(`toolbox.speechResource.progress.${status.status}`)}
            </span>
            {downloading && (
              <span className="font-mono">{downloadPercent}%</span>
            )}
          </div>
          {downloading && (
            <div
              className="h-1.5 overflow-hidden rounded-full bg-[var(--paper-inset)]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={downloadPercent}
            >
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                style={{ width: `${Math.max(2, downloadPercent)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-[var(--danger)]">{error}</p>}
      {hasActivationWarning && (
        <p className="mt-2 text-xs text-[var(--warning)]">
          {t('toolbox.speechResource.activationWarning')}
        </p>
      )}
      {status && (
        <p className="mt-2 text-xs text-[var(--ink-muted)]">
          {t('toolbox.speechResource.size', {
            download: formatBytes(status.totalDownloadBytes),
            installed: formatBytes(status.installedModelBytes),
          })}
        </p>
      )}
      <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
        {t('toolbox.speechResource.authorizationHint')}
      </p>
    </div>
  );
}
