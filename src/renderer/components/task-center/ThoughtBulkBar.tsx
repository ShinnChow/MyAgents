// ThoughtBulkBar — bottom-of-panel floating action bar for multi-select
// mode in the Task Center 想法 panel. Shows when `selectMode` is true.
//
// Positioned `absolute` (NOT `fixed`) so it docks to the bottom of the
// thought panel rather than the viewport. Its parent (ThoughtPanel root)
// is `relative` for that anchoring. This keeps the bar over the thought
// list only — without overlapping the right-hand task list — and follows
// the panel when it scrolls into view, instead of always sitting at the
// screen center where it would crowd unrelated UI.
//
// Sits at z-40 so it floats above the card list but below full-screen
// overlays (e.g. DispatchTaskDialog at z-[200]) and the global toast/modal
// stack at z-[300]. The container uses `pointer-events-none` so the
// surrounding gutter doesn't swallow clicks targeted at the cards behind
// it; the inner pill takes pointer events back on for its buttons.

import { Archive, ArchiveRestore, Layers, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  /** Number of currently selected thoughts. Drives merge/delete enable state. */
  count: number;
  /** Click 「合并」 — only fires when `count >= 2`. */
  onMerge: () => void;
  /** Click 「归档」/「取消归档」 — flips archive flag for every selected thought. */
  onArchive: () => void;
  /** Click 「删除」 — opens a confirm dialog at the panel level. Only fires
   *  when `count >= 1`. */
  onDelete: () => void;
  /** Click 「取消」 — exit selectMode and clear selection. */
  onCancel: () => void;
  /** Current panel view mode — drives archive button label / icon. */
  viewMode: 'active' | 'archived';
  /** When true, action buttons are disabled (e.g. during merge/delete RPC). */
  busy?: boolean;
  /** Product reason that makes merge invalid even when two rows are selected. */
  mergeDisabledReason?: string;
}

export function ThoughtBulkBar({
  count,
  onMerge,
  onArchive,
  onDelete,
  onCancel,
  viewMode,
  busy,
  mergeDisabledReason,
}: Props) {
  const { t } = useTranslation('task');
  const canMerge = count >= 2 && !busy && !mergeDisabledReason;
  const canArchive = count >= 1 && !busy;
  const canDelete = count >= 1 && !busy;
  const archiveLabel =
    viewMode === 'archived' ? t('thoughts.unarchive') : t('thoughts.archive');
  const ArchiveIcon = viewMode === 'archived' ? ArchiveRestore : Archive;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center">
      <div
        className="pointer-events-auto flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1.5 shadow-lg"
        role="toolbar"
        aria-label={t('thoughts.bulkToolbar')}
      >
        <span className="px-3 text-xs tabular-nums text-[var(--ink-muted)]">
          {t('thoughts.selectedCount', { count })}
        </span>
        {mergeDisabledReason && (
          <span className="max-w-48 truncate px-1 text-xs text-[var(--ink-muted)]">
            {mergeDisabledReason}
          </span>
        )}
        <div className="h-5 w-px bg-[var(--line)]" />
        <button
          type="button"
          onClick={onMerge}
          disabled={!canMerge}
          title={
            mergeDisabledReason ??
            (count < 2
              ? t('thoughts.mergeNeedsTwo')
              : t('thoughts.mergeTooltip'))
          }
          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-sm text-[var(--ink-secondary)] transition-colors hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--ink-secondary)]"
        >
          <Layers className="h-3.5 w-3.5" strokeWidth={1.75} />
          {t('thoughts.merge')}
        </button>
        <button
          type="button"
          onClick={onArchive}
          disabled={!canArchive}
          title={
            viewMode === 'archived'
              ? t('thoughts.unarchiveSelected')
              : t('thoughts.archiveSelected')
          }
          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-sm text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--ink-secondary)]"
        >
          <ArchiveIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
          {archiveLabel}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          title={t('thoughts.deleteSelected')}
          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-sm text-[var(--ink-secondary)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--ink-secondary)]"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          {t('common.delete')}
        </button>
        <div className="h-5 w-px bg-[var(--line)]" />
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          title={t('thoughts.exitSelect')}
          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

export default ThoughtBulkBar;
