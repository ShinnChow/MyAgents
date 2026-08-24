import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ListChecks, Mic, Pause, Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { recordingSnapshot, recordMediaUrl } from '@/api/recording';
import { hashPrivateIdentity } from '@/analytics/hash';
import { track as trackAnalytics } from '@/analytics/tracker';
import type {
  RecordSummary,
  RecordingSnapshot,
} from '@/../shared/types/record';
import type { RecordSearchHit } from '@/api/searchClient';

interface Props {
  record: RecordSummary;
  onOpen: (recordId: string, mediaMs?: number) => void;
  onArchive: (recordId: string, archived: boolean) => void | Promise<void>;
  onDelete: (recordId: string) => void | Promise<void>;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onEnterSelectMode?: () => void;
  searchHit?: RecordSearchHit;
}

function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1_000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function AudioRecordCard({
  record,
  onOpen,
  onArchive,
  onDelete,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onEnterSelectMode,
  searchHit,
}: Props) {
  const { t, i18n } = useTranslation('task');
  const [playing, setPlaying] = useState(false);
  const [activeSnapshot, setActiveSnapshot] =
    useState<RecordingSnapshot | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const audioRef = useRef<HTMLAudioElement>(null);
  const playbackSessionTrackedRef = useRef(false);
  const audio = record.audio;
  const active = audio
    ? ['preparing', 'recording', 'paused', 'stopping', 'finalizing'].includes(
        audio.captureStatus,
      )
    : false;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const refresh = () => {
      void recordingSnapshot()
        .then((snapshot) => {
          if (!cancelled) {
            setActiveSnapshot(
              snapshot?.recordId === record.id ? snapshot : null,
            );
          }
        })
        .catch(() => undefined);
    };
    refresh();
    const snapshotTimer = window.setInterval(refresh, 1_500);
    const clockTimer = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => {
      cancelled = true;
      window.clearInterval(snapshotTimer);
      window.clearInterval(clockTimer);
    };
  }, [active, record.id]);
  const displayedDurationMs = useMemo(() => {
    const currentSnapshot = active ? activeSnapshot : null;
    if (!currentSnapshot) return audio?.mediaDurationMs ?? 0;
    if (currentSnapshot.captureStatus !== 'recording') {
      return currentSnapshot.mediaDurationMs;
    }
    return Math.max(
      currentSnapshot.mediaDurationMs,
      clockNow -
        currentSnapshot.startedAtWallTime -
        currentSnapshot.pausedWallMs,
    );
  }, [active, activeSnapshot, audio?.mediaDurationMs, clockNow]);
  if (!audio) return null;
  const track = audio.tracks.includes('mixed') ? 'mixed' : audio.tracks[0];
  const status =
    audio.captureStatus === 'recording'
      ? t('records.recording')
      : audio.captureStatus === 'paused'
        ? t('records.paused')
        : ['queued', 'live', 'lagging', 'recovering', 'finalizing'].includes(
              audio.transcriptionStatus,
            )
          ? t('records.processing')
          : audio.captureStatus === 'failed' ||
              audio.transcriptionStatus === 'failed'
            ? t('records.failed')
            : t('records.complete');
  const summary = (
    <>
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
        <Mic className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--ink)]">
          {record.title || t('records.untitled')}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--ink-muted)]">
          <span>
            {new Intl.DateTimeFormat(i18n.resolvedLanguage, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }).format(record.createdAt)}
          </span>
          <span className="tabular-nums">
            {formatDuration(displayedDurationMs)}
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-[var(--error)]' : 'bg-[var(--success)]'}`}
            />
            {status}
          </span>
        </span>
        <span className="mt-1.5 block truncate text-xs text-[var(--ink-muted)]/75">
          {searchHit?.snippet ||
            audio.tracks.map((item) => t(`records.${item}`)).join(' · ')}
        </span>
      </span>
    </>
  );

  return (
    <article
      role={selectMode ? 'checkbox' : undefined}
      aria-checked={selectMode ? selected : undefined}
      aria-disabled={selectMode && active ? true : undefined}
      tabIndex={selectMode && !active ? 0 : undefined}
      onClick={selectMode && !active ? onToggleSelect : undefined}
      onKeyDown={
        selectMode && !active
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onToggleSelect?.();
            }
          : undefined
      }
      className={`group rounded-[var(--radius-lg)] bg-[var(--paper-elevated)] p-3 shadow-xs transition-shadow hover:shadow-sm ${
        selectMode && !active ? 'cursor-pointer' : ''
      } ${
        selected
          ? 'bg-[var(--accent-warm-subtle)] ring-1 ring-[var(--accent-warm)]'
          : ''
      }`}
    >
      {selectMode ? (
        <div className="flex w-full min-w-0 items-start gap-3 text-left">
          {summary}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(record.id, searchHit?.mediaMs ?? undefined)}
          className="flex w-full min-w-0 items-start gap-3 text-left"
        >
          {summary}
        </button>
      )}

      <div className="mt-2 flex items-center justify-between">
        <div>
          {!active && !selectMode && track && (
            <button
              type="button"
              onClick={() => {
                const element = audioRef.current;
                if (!element) return;
                if (element.paused) void element.play();
                else element.pause();
              }}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--paper-inset)] text-[var(--ink-secondary)] hover:text-[var(--accent-warm)]"
              aria-label={
                playing ? t('records.pausePlayback') : t('records.play')
              }
            >
              {playing ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="ml-0.5 h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
        {!active && !selectMode && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              onClick={onEnterSelectMode}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label={t('thoughts.multiSelect')}
            >
              <ListChecks className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void onArchive(record.id, !record.archived)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label={
                record.archived
                  ? t('thoughts.unarchive')
                  : t('thoughts.archive')
              }
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void onDelete(record.id)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--error-subtle)] hover:text-[var(--error)]"
              aria-label={t('common.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
      {track && (
        <audio
          ref={audioRef}
          src={recordMediaUrl(record.id, track)}
          preload="none"
          onPause={() => setPlaying(false)}
          onPlay={() => {
            setPlaying(true);
            if (playbackSessionTrackedRef.current) return;
            playbackSessionTrackedRef.current = true;
            void hashPrivateIdentity('record', record.id).then((recordHash) => {
              trackAnalytics('record_use', {
                event_schema_version: 1,
                record_hash: recordHash ?? undefined,
                record_kind: 'audio',
                operation: 'play',
                source: 'desktop',
                surface: 'task_center',
              });
            });
          }}
          onEnded={() => {
            setPlaying(false);
            playbackSessionTrackedRef.current = false;
          }}
        />
      )}
    </article>
  );
}

export default AudioRecordCard;
