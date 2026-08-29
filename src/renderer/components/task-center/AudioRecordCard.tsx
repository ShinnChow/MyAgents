import { useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  CheckSquare,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { RecordSummary, RecordingSnapshot } from '@/../shared/types/record';
import type { RecordSearchHit } from '@/api/searchClient';
import { Popover } from '@/components/ui/Popover';
import { relativeTime } from '@/utils/taskCenterUtils';
import { isSupportedLocale } from '@/../shared/i18n';
import { RecordWorkspacePicker } from './RecordWorkspacePicker';

interface Props {
  record: RecordSummary;
  onOpen: (recordId: string, mediaMs?: number, activeRecording?: boolean) => void;
  onArchive: (recordId: string, archived: boolean) => void | Promise<void>;
  onDelete: (recordId: string) => void | Promise<void>;
  onDiscuss?: (record: RecordSummary, workspaceId: string) => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onEnterSelectMode?: () => void;
  searchHit?: RecordSearchHit;
  activeRecordingSnapshot?: RecordingSnapshot | null;
}

function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1_000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function isCardControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a, input, textarea, select, [role="menuitem"]') !==
      null
  );
}

export function AudioRecordCard({
  record,
  onOpen,
  onArchive,
  onDelete,
  onDiscuss,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onEnterSelectMode,
  searchHit,
  activeRecordingSnapshot,
}: Props) {
  const { t, i18n } = useTranslation('task');
  const [showMenu, setShowMenu] = useState(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const discussAnchorRef = useRef<HTMLButtonElement>(null);
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const audio = record.audio;
  const activeSnapshot = activeRecordingSnapshot?.recordId === record.id ? activeRecordingSnapshot : null;
  const effectiveCaptureStatus = activeSnapshot?.captureStatus ?? audio?.captureStatus;
  const active = effectiveCaptureStatus
    ? ['preparing', 'recording', 'paused', 'stopping', 'finalizing'].includes(effectiveCaptureStatus)
    : false;
  const displayedDurationMs = activeSnapshot?.mediaDurationMs ?? audio?.mediaDurationMs ?? 0;
  if (!audio) return null;
  const status =
    effectiveCaptureStatus === 'recording'
      ? t('records.recording')
      : effectiveCaptureStatus === 'paused'
        ? t('records.paused')
        : ['queued', 'live', 'lagging', 'recovering', 'finalizing'].includes(audio.transcriptionStatus)
          ? t('records.processing')
          : effectiveCaptureStatus === 'failed' ||
              audio.transcriptionStatus === 'failed' ||
              audio.diarizationStatus === 'failed'
            ? t('records.failed')
            : t('records.complete');
  const dateLabel = relativeTime(record.createdAt, locale);
  const openRecord = () =>
    onOpen(record.id, searchHit?.mediaMs ?? undefined, active);
  const handleCardClick = (event: React.MouseEvent<HTMLElement>) => {
    if (selectMode) {
      if (!active) onToggleSelect?.();
      return;
    }
    if (isCardControl(event.target)) return;
    openRecord();
  };
  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (selectMode) {
      if (!active) onToggleSelect?.();
      return;
    }
    openRecord();
  };
  const summary = (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
        <Mic className="h-3.5 w-3.5" strokeWidth={1.5} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ink)]">
        {record.title || t('records.untitled')}
      </span>
      <span className="shrink-0 tabular-nums text-xs text-[var(--ink-muted)]">
        {formatDuration(displayedDurationMs)}
      </span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
          active ? 'bg-[var(--error-subtle)] text-[var(--error)]' : 'bg-[var(--success-bg)] text-[var(--success)]'
        }`}
      >
        {status}
      </span>
    </>
  );

  return (
    <article
      role={selectMode ? 'checkbox' : 'button'}
      aria-label={selectMode ? undefined : record.title || t('records.untitled')}
      aria-checked={selectMode ? selected : undefined}
      aria-disabled={selectMode && active ? true : undefined}
      tabIndex={selectMode && active ? undefined : 0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      className={`group relative w-full min-w-0 max-w-full overflow-hidden rounded-[var(--radius-lg)] bg-[var(--paper-elevated)] p-4 outline-none transition-shadow hover:shadow-sm focus-visible:ring-1 focus-visible:ring-[var(--accent-warm)] ${
        !selectMode || !active ? 'cursor-pointer' : ''
      } ${selected ? 'bg-[var(--accent-warm-subtle)] ring-1 ring-[var(--accent-warm)]' : ''}`}
    >
      <div className="mb-2 flex h-5 min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--ink-muted)]/60">
          {dateLabel}
        </span>
        {!selectMode && (
          <div className="flex shrink-0 items-center gap-1">
            {!active && onDiscuss && (
              <button
                ref={discussAnchorRef}
                type="button"
                onClick={() => setShowWorkspacePicker((value) => !value)}
                className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-sm text-[var(--ink-muted)] opacity-0 transition-opacity hover:bg-[var(--paper-inset)] hover:text-[var(--accent-cool)] group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t('thoughts.aiDiscuss')}
              </button>
            )}
            <button
              ref={menuAnchorRef}
              type="button"
              onClick={() => setShowMenu((value) => !value)}
              disabled={active}
              title={t('thoughts.moreActions')}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--ink-muted)]/70 transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40"
            >
              <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
            <Popover
              open={showMenu}
              onClose={() => setShowMenu(false)}
              anchorRef={menuAnchorRef}
              placement="bottom-end"
              className="min-w-[140px] py-1"
            >
              {onEnterSelectMode && (
                <button
                  type="button"
                  onClick={() => {
                    setShowMenu(false);
                    onEnterSelectMode();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <CheckSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {t('thoughts.multiSelect')}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  void onArchive(record.id, !record.archived);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                {record.archived ? (
                  <ArchiveRestore className="h-3.5 w-3.5" strokeWidth={1.5} />
                ) : (
                  <Archive className="h-3.5 w-3.5" strokeWidth={1.5} />
                )}
                {record.archived ? t('thoughts.unarchive') : t('thoughts.archive')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  void onDelete(record.id);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--error)] hover:bg-[var(--error-bg)]"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t('common.delete')}
              </button>
            </Popover>
          </div>
        )}
      </div>

      {selectMode ? (
        <div className="flex w-full min-w-0 max-w-full items-center gap-2.5 text-left">{summary}</div>
      ) : (
        <div className="flex w-full min-w-0 max-w-full items-center gap-2.5 text-left">
          {summary}
        </div>
      )}

      {onDiscuss && (
        <RecordWorkspacePicker
          open={showWorkspacePicker}
          onClose={() => setShowWorkspacePicker(false)}
          anchorRef={discussAnchorRef}
          tags={record.tags}
          onSelect={(workspaceId) => onDiscuss(record, workspaceId)}
        />
      )}
    </article>
  );
}

export default AudioRecordCard;
