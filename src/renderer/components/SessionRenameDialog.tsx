import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';

interface SessionRenameDialogProps {
  currentTitle: string;
  onConfirm: (title: string) => Promise<void>;
  onCancel: () => void;
}

export default function SessionRenameDialog({
  currentTitle,
  onConfirm,
  onCancel,
}: SessionRenameDialogProps) {
  const { t } = useTranslation('launcher');
  const { t: tCommon } = useTranslation('common');
  const [title, setTitle] = useState(currentTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const normalizedTitle = title.trim();
  const canSave = normalizedTitle.length > 0 && !saving;

  useCloseLayer(() => {
    if (saving) return true;
    onCancel();
    return true;
  }, 100);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(normalizedTitle);
    } catch (cause) {
      console.error('[SessionRenameDialog] Failed to rename Session:', cause);
      setError(t('rightRail.renameFailedRetry'));
      setSaving(false);
    }
  };

  return (
    <OverlayBackdrop
      portal
      className="z-[210] px-4"
      onClose={saving ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-rename-dialog-title"
        className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!saving) onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ) ?? []);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="session-rename-dialog-title" className="text-lg font-semibold text-[var(--ink)]">
            {t('rightRail.renameDialogTitle')}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
            aria-label={tCommon('actions.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label htmlFor="session-rename-input" className="mb-2 block text-sm font-medium text-[var(--ink)]">
          {t('rightRail.renameDialogLabel')}
        </label>
        <input
          ref={inputRef}
          id="session-rename-input"
          type="text"
          maxLength={100}
          value={title}
          disabled={saving}
          onChange={(event) => {
            setTitle(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 disabled:opacity-60"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'session-rename-error' : undefined}
        />
        {error && (
          <p id="session-rename-error" role="alert" className="mt-2 flex items-center gap-1.5 text-xs text-[var(--danger)]">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
          >
            {tCommon('actions.cancel')}
          </button>
          <button
            type="button"
            onClick={() => { void submit(); }}
            disabled={!canSave}
            className="action-button inline-flex min-w-20 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
            {tCommon('actions.save')}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
