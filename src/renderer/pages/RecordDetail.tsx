import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Download,
  FileText,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import CustomSelect from '@/components/CustomSelect';

import {
  recordAddMark,
  recordAddNote,
  recordDeleteTimelineItem,
  recordDiarization,
  recordExportAudio,
  recordExportText,
  recordMediaUrl,
  recordMergeSpeakers,
  recordingPause,
  recordingResume,
  recordingSetSourceEnabled,
  recordingSnapshot,
  recordingStop,
  recordStartTranscription,
  recordTimeline,
  recordTranscript,
  recordTranscriptDelta,
  recordReassignSegmentSpeaker,
  recordRenameSpeaker,
  recordUpdateAudioMetadata,
  recordUpdateNote,
  speechModelPackStatus,
} from '@/api/recording';
import { recordDelete, recordGet, recordSetArchived } from '@/api/taskCenter';
import ConfirmDialog from '@/components/ConfirmDialog';
import RecordingSourceDialog from '@/components/task-center/RecordingSourceDialog';
import { RecordWorkspacePicker } from '@/components/task-center/RecordWorkspacePicker';
import { useToast } from '@/components/Toast';
import DropdownMenu, {
  type DropdownMenuSection,
} from '@/components/ui/DropdownMenu';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import type {
  RecordChange,
  RecordDetail as RecordDetailData,
  RecordDiarizationProjection,
  RecordingChange,
  RecordingSnapshot,
  RecordTimelineItem,
  RecordTimelineProjection,
  RecordTranscriptCursor,
  RecordTranscriptSegment,
  RecordTranscriptSnapshot,
  SpeechModelPackStatus,
} from '@/../shared/types/record';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import { useConfig } from '@/hooks/useConfig';
import { hashPrivateIdentity, track } from '@/analytics';
import { copyPlainText } from '@/utils/clipboard';
import {
  applyRecordTranscriptDelta,
  reconcileRecordTranscriptSnapshot,
} from '@/utils/recordTranscript';

interface Props {
  recordId: string;
  isActive: boolean;
  seekMediaMs?: number;
  seekNonce?: number;
  initialRecordingSnapshot?: RecordingSnapshot;
  onRecordingSnapshotChange?: (snapshot: RecordingSnapshot | null) => void;
  registerPendingNoteSubmitter?: (
    recordId: string,
    submit: () => Promise<boolean>,
  ) => () => void;
  onTitleChange?: (title: string) => void;
  onDeleted?: () => void;
}

const EMPTY_TIMELINE: RecordTimelineProjection = {
  recordId: '',
  revision: 0,
  items: [],
};

const TRANSCRIPT_VIRTUALIZE_THRESHOLD = 100;
const TIMELINE_VIRTUALIZE_THRESHOLD = 100;

function formatDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function safeRecordExportBaseName(
  title: string,
  fallback: string,
): string {
  const normalized = Array.from(title.normalize('NFKC'), (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('');
  const sanitized = normalized
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '');
  const bounded = Array.from(sanitized || fallback)
    .slice(0, 80)
    .join('');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(bounded)
    ? `${bounded}-record`
    : bounded;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  if (value < 1_024 * 1_024 * 1_024)
    return `${(value / 1_024 / 1_024).toFixed(1)} MB`;
  return `${(value / 1_024 / 1_024 / 1_024).toFixed(1)} GB`;
}

function speakerLetter(index: number): string {
  let value = Math.max(0, index);
  let label = '';
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function parseTagDraft(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\s,，]+/)
        .map((tag) => tag.trim().replace(/^#+/, ''))
        .filter(Boolean),
    ),
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export default function RecordDetail({
  recordId,
  isActive,
  seekMediaMs,
  seekNonce,
  initialRecordingSnapshot,
  onRecordingSnapshotChange,
  registerPendingNoteSubmitter,
  onTitleChange,
  onDeleted,
}: Props) {
  const { t, i18n } = useTranslation('task');
  const toast = useToast();
  const { config, updateConfig } = useConfig();
  const [record, setRecord] = useState<RecordDetailData | null>(null);
  const [snapshot, setSnapshot] = useState<RecordingSnapshot | null>(
    initialRecordingSnapshot?.recordId === recordId
      ? initialRecordingSnapshot
      : null,
  );
  const [transcript, setTranscript] = useState<RecordTranscriptSnapshot | null>(
    null,
  );
  const [diarization, setDiarization] =
    useState<RecordDiarizationProjection | null>(null);
  const [timeline, setTimeline] =
    useState<RecordTimelineProjection>(EMPTY_TIMELINE);
  const [modelPack, setModelPack] = useState<SpeechModelPackStatus | null>(
    null,
  );
  const [noteDraft, setNoteDraft] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectionError, setProjectionError] = useState<string | null>(null);
  const [recordLoading, setRecordLoading] = useState(true);
  const [titleDraft, setTitleDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState('');
  const [pendingTimelineFocus, setPendingTimelineFocus] = useState<
    string | null
  >(null);
  const [highlightedItem, setHighlightedItem] = useState<string | null>(null);
  const [speakerNameDrafts, setSpeakerNameDrafts] = useState<
    Record<number, string>
  >({});
  const [speakerMergeTargets, setSpeakerMergeTargets] = useState<
    Record<number, string>
  >({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showSourceSettings, setShowSourceSettings] = useState(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [copiedSegmentId, setCopiedSegmentId] = useState<string | null>(null);
  const [playbackTrack, setPlaybackTrack] = useState<
    'microphone' | 'system' | 'mixed'
  >('mixed');
  const [playing, setPlaying] = useState(false);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [playbackVolume, setPlaybackVolume] = useState(1);
  const [playbackError, setPlaybackError] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const secondaryAudioRef = useRef<HTMLAudioElement>(null);
  const snapshotRef = useRef(snapshot);
  const noteAnchorRef = useRef<number | null>(null);
  const noteStartedWallRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  const metadataSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const titleDraftRef = useRef('');
  const tagDraftRef = useRef('');
  const titleDirtyRef = useRef(false);
  const tagDirtyRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const playbackSessionTrackedRef = useRef(false);
  const playbackErrorShownRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  const snapshotEpochRef = useRef(0);
  const recordingChangeSequenceRef = useRef(0);
  const transcriptPollEpochRef = useRef(0);
  const transcriptCursorRef = useRef<RecordTranscriptCursor | undefined>(
    undefined,
  );
  const transcriptDeltaQueueRef = useRef<Promise<void> | null>(null);
  const noteSubmitInFlightRef = useRef<Promise<boolean> | null>(null);
  const noteDraftRef = useRef('');
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineVirtuosoRef = useRef<VirtuosoHandle>(null);
  const timelineItemRefs = useRef(new Map<string, HTMLDivElement>());
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const transcriptItemRefs = useRef(new Map<string, HTMLElement>());
  const transcriptVirtuosoRef = useRef<VirtuosoHandle>(null);
  const recordActionsAnchorRef = useRef<HTMLSpanElement>(null);
  const pendingTranscriptFocusRef = useRef<string | null>(null);
  const pendingTimelineVirtualFocusRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const copyResetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(
    () => () => {
      if (highlightTimerRef.current !== undefined) {
        window.clearTimeout(highlightTimerRef.current);
      }
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  const applySnapshot = useCallback(
    (next: RecordingSnapshot | null) => {
      const owned = next?.recordId === recordId ? next : null;
      const current = snapshotRef.current;
      if (
        current &&
        owned &&
        (owned.generation < current.generation ||
          (owned.generation === current.generation &&
            owned.revision < current.revision) ||
          (owned.generation === current.generation &&
            owned.revision === current.revision &&
            owned.mediaDurationMs < current.mediaDurationMs))
      ) {
        return;
      }
      snapshotEpochRef.current += 1;
      snapshotRef.current = owned;
      setSnapshot(owned);
      onRecordingSnapshotChange?.(owned);
    },
    [onRecordingSnapshotChange, recordId],
  );

  const requestSnapshot = useCallback(async () => {
    const epoch = snapshotEpochRef.current;
    const active = await recordingSnapshot();
    if (snapshotEpochRef.current !== epoch) return;
    applySnapshot(active?.recordId === recordId ? active : null);
  }, [applySnapshot, recordId]);

  const refresh = useCallback(
    async (includeTranscript = true) => {
      const generation = refreshGenerationRef.current + 1;
      refreshGenerationRef.current = generation;
      setRecordLoading(true);
      const [
        recordResult,
        transcriptResult,
        diarizationResult,
        timelineResult,
        modelResult,
      ] = await Promise.allSettled([
        recordGet(recordId),
        includeTranscript
          ? recordTranscript(recordId)
          : Promise.resolve(undefined),
        recordDiarization(recordId),
        recordTimeline(recordId),
        speechModelPackStatus(),
      ]);
      if (refreshGenerationRef.current !== generation) return;

      if (
        recordResult.status === 'fulfilled' &&
        recordResult.value?.kind === 'audio'
      ) {
        const nextRecord = recordResult.value;
        setRecord(nextRecord);
        if (!titleDirtyRef.current) {
          titleDraftRef.current = nextRecord.title;
          setTitleDraft(nextRecord.title);
        }
        if (!tagDirtyRef.current) {
          const nextTagDraft = nextRecord.tags
            .map((tag) => `#${tag}`)
            .join(' ');
          tagDraftRef.current = nextTagDraft;
          setTagDraft(nextTagDraft);
        }
        setLoadError(null);
        onTitleChange?.(nextRecord.title || t('records.untitled'));
      } else {
        const error =
          recordResult.status === 'rejected'
            ? recordResult.reason
            : new Error('Record is not available');
        setLoadError(error instanceof Error ? error.message : String(error));
      }

      const projectionFailures: unknown[] = [];
      if (includeTranscript) {
        if (transcriptResult.status === 'fulfilled') {
          transcriptPollEpochRef.current += 1;
          transcriptCursorRef.current = undefined;
          setTranscript((current) =>
            reconcileRecordTranscriptSnapshot(
              current,
              transcriptResult.value ?? null,
            ),
          );
        } else {
          projectionFailures.push(transcriptResult.reason);
        }
      }
      if (diarizationResult.status === 'fulfilled') {
        const nextDiarization = diarizationResult.value;
        setDiarization((current) =>
          current &&
          nextDiarization &&
          current.projectionRevision > nextDiarization.projectionRevision
            ? current
            : nextDiarization,
        );
        setSpeakerNameDrafts(
          Object.fromEntries(
            (nextDiarization?.speakers ?? []).map((speaker) => [
              speaker.speakerId,
              speaker.customName ?? '',
            ]),
          ),
        );
      } else {
        projectionFailures.push(diarizationResult.reason);
      }
      if (timelineResult.status === 'fulfilled') {
        setTimeline((current) =>
          current.revision > timelineResult.value.revision
            ? current
            : timelineResult.value,
        );
      } else {
        projectionFailures.push(timelineResult.reason);
      }
      if (modelResult.status === 'fulfilled') {
        setModelPack(modelResult.value);
      } else {
        projectionFailures.push(modelResult.reason);
      }
      setProjectionError(
        projectionFailures.length > 0
          ? projectionFailures[0] instanceof Error
            ? projectionFailures[0].message
            : String(projectionFailures[0])
          : null,
      );
      setRecordLoading(false);
    },
    [onTitleChange, recordId, t],
  );

  useEffect(() => {
    void refresh();
    void requestSnapshot().catch(() => undefined);
  }, [refresh, requestSnapshot]);

  const pullTranscriptDelta = useCallback(() => {
    const epoch = transcriptPollEpochRef.current;
    const previous = transcriptDeltaQueueRef.current ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (transcriptPollEpochRef.current !== epoch) return;
        try {
          const delta = await recordTranscriptDelta(
            recordId,
            transcriptCursorRef.current,
          );
          if (transcriptPollEpochRef.current !== epoch || !delta) return;
          transcriptCursorRef.current = delta.cursor;
          setTranscript((current) =>
            applyRecordTranscriptDelta(current, delta),
          );
        } catch {
          // The 1.5 s recovery poll retries missed or failed notifications.
        }
      });
    transcriptDeltaQueueRef.current = next;
    void next.finally(() => {
      if (transcriptDeltaQueueRef.current === next) {
        transcriptDeltaQueueRef.current = null;
      }
    });
    return next;
  }, [recordId]);

  useEffect(() => {
    const next = initialRecordingSnapshot;
    if (!next || next.recordId !== recordId) return;
    const current = snapshotRef.current;
    if (
      current &&
      (next.generation < current.generation ||
        (next.generation === current.generation &&
          next.revision < current.revision) ||
        (next.generation === current.generation &&
          next.revision === current.revision &&
          next.mediaDurationMs < current.mediaDurationMs))
    ) {
      return;
    }
    applySnapshot(next);
  }, [applySnapshot, initialRecordingSnapshot, recordId]);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const controller = new AbortController();
    void listenWithCleanup<RecordingChange>(
      'recording:changed',
      ({ payload }) => {
        if (payload.recordId !== recordId) return;
        if (payload.sequence <= recordingChangeSequenceRef.current) return;
        recordingChangeSequenceRef.current = payload.sequence;
        const next = payload.snapshot ?? null;
        applySnapshot(next);
        if (!next) void refresh();
      },
      controller.signal,
    );
    void listenWithCleanup<RecordChange>(
      'record:changed',
      ({ payload }) => {
        if (payload.id !== recordId) return;
        if (payload.kind === 'transcript') {
          void pullTranscriptDelta();
          return;
        }
        // Notes and marks emit record:changed too. While capture is active,
        // refresh metadata/timeline without resetting the incremental
        // transcript cursor back to a full-journal read.
        void refresh(!snapshotRef.current);
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [applySnapshot, pullTranscriptDelta, recordId, refresh]);

  const isPaused = snapshot?.captureStatus === 'paused';
  const ownsCaptureSlot =
    !!snapshot &&
    ['preparing', 'recording', 'paused', 'stopping', 'finalizing'].includes(
      snapshot.captureStatus,
    );

  useEffect(() => {
    if (!isActive || !ownsCaptureSlot) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await pullTranscriptDelta();
      if (!cancelled) timer = window.setTimeout(poll, 1_500);
    };
    void poll();
    return () => {
      cancelled = true;
      transcriptPollEpochRef.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isActive, ownsCaptureSlot, pullTranscriptDelta]);

  const mediaDurationMs =
    snapshot?.mediaDurationMs ?? record?.audio?.mediaDurationMs ?? 0;

  const currentMediaMs = useCallback(
    () => (ownsCaptureSlot ? mediaDurationMs : playbackMs),
    [mediaDurationMs, ownsCaptureSlot, playbackMs],
  );

  const runControl = useCallback(
    async (action: 'pause' | 'resume') => {
      const current = snapshotRef.current;
      if (!current) return;
      setBusyAction(action);
      try {
        const next =
          action === 'pause'
            ? await recordingPause(current)
            : await recordingResume(current);
        applySnapshot(next);
      } catch (error) {
        toast.error(
          t('records.controlFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [applySnapshot, t, toast],
  );

  const runSourceControl = useCallback(
    async (track: 'microphone' | 'system', enabled: boolean) => {
      const current = snapshotRef.current;
      if (!current) return;
      setBusyAction(`source-${track}`);
      try {
        const next = await recordingSetSourceEnabled(current, track, enabled);
        applySnapshot(next);
      } catch (error) {
        toast.error(
          t('records.controlFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [applySnapshot, t, toast],
  );

  const submitNote = useCallback((): Promise<boolean> => {
    if (noteSubmitInFlightRef.current) return noteSubmitInFlightRef.current;
    const text = noteDraftRef.current.trim();
    if (!text) return Promise.resolve(true);
    const now = Date.now();
    const anchorMediaMs = noteAnchorRef.current ?? currentMediaMs();
    const startedAtWallTime = noteStartedWallRef.current ?? now;
    setBusyAction('note');
    const operation = recordAddNote({
      recordId,
      operationId: crypto.randomUUID(),
      anchorMediaMs,
      startedAtWallTime,
      submittedAtWallTime: now,
      text,
    })
      .then((next) => {
        setTimeline(next);
        if (noteDraftRef.current.trim() === text) {
          noteDraftRef.current = '';
          setNoteDraft('');
          noteAnchorRef.current = null;
          noteStartedWallRef.current = null;
        }
        return true;
      })
      .catch((error) => {
        toast.error(
          t('records.noteSaveFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return false;
      })
      .finally(() => {
        if (noteSubmitInFlightRef.current === operation) {
          noteSubmitInFlightRef.current = null;
        }
        setBusyAction(null);
      });
    noteSubmitInFlightRef.current = operation;
    return operation;
  }, [currentMediaMs, recordId, t, toast]);

  const flushPendingNote = useCallback(async (): Promise<boolean> => {
    // Closing/stopping may begin while note A is in flight and the user has
    // already typed note B. Drain the current save, then persist whatever
    // draft remains; the normal Enter path stays single-submit.
    for (;;) {
      const pending = noteSubmitInFlightRef.current;
      if (pending && !(await pending)) return false;
      if (!noteDraftRef.current.trim()) return true;
      if (!(await submitNote())) return false;
    }
  }, [submitNote]);

  useEffect(() => {
    if (!registerPendingNoteSubmitter) return;
    return registerPendingNoteSubmitter(recordId, flushPendingNote);
  }, [flushPendingNote, recordId, registerPendingNoteSubmitter]);

  const handleStop = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current) return;
    if (!(await flushPendingNote())) return;
    setBusyAction('stop');
    try {
      const next = await recordingStop(current);
      applySnapshot(next);
      await refresh();
    } catch (error) {
      toast.error(
        t('records.controlFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }, [applySnapshot, flushPendingNote, refresh, t, toast]);

  const handleMark = useCallback(async () => {
    setBusyAction('mark');
    try {
      const now = Date.now();
      const previousIds = new Set(
        timeline.items.map((item) =>
          item.type === 'note' ? item.noteId : item.markId,
        ),
      );
      const next = await recordAddMark({
        recordId,
        operationId: crypto.randomUUID(),
        mediaMs: currentMediaMs(),
        wallTime: now,
      });
      setTimeline(next);
      const created = next.items.find(
        (item) => item.type === 'mark' && !previousIds.has(item.markId),
      );
      if (created?.type === 'mark') {
        setPendingTimelineFocus(`mark-${created.markId}`);
      }
    } catch (error) {
      toast.error(
        t('records.markFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }, [currentMediaMs, recordId, t, timeline.items, toast]);

  const handleUpdateNote = useCallback(async () => {
    if (!editingNoteId || !editingNoteDraft.trim()) return;
    setBusyAction('timeline');
    try {
      setTimeline(
        await recordUpdateNote({
          recordId,
          operationId: crypto.randomUUID(),
          noteId: editingNoteId,
          updatedAtWallTime: Date.now(),
          text: editingNoteDraft.trim(),
        }),
      );
      setEditingNoteId(null);
      setEditingNoteDraft('');
    } catch (error) {
      toast.error(
        t('records.timelineMutationFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }, [editingNoteDraft, editingNoteId, recordId, t, toast]);

  const handleDeleteTimelineItem = useCallback(
    async (itemType: 'note' | 'mark', itemId: string) => {
      setBusyAction('timeline');
      try {
        setTimeline(
          await recordDeleteTimelineItem({
            recordId,
            operationId: crypto.randomUUID(),
            itemId,
            itemType,
            deletedAtWallTime: Date.now(),
          }),
        );
        if (editingNoteId === itemId) {
          setEditingNoteId(null);
          setEditingNoteDraft('');
        }
      } catch (error) {
        toast.error(
          t('records.timelineMutationFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [editingNoteId, recordId, t, toast],
  );

  const handleStartTranscription = useCallback(async () => {
    setBusyAction('transcribe');
    try {
      await recordStartTranscription(recordId);
      await refresh();
    } catch (error) {
      toast.error(
        t('records.controlFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }, [recordId, refresh, t, toast]);

  const queueMetadataSave = useCallback(
    (title: string, tags: string[]) => {
      const run = metadataSaveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const current = await recordGet(recordId);
          if (!current || current.kind !== 'audio') {
            throw new Error('Record is not available');
          }
          const normalizedTitle = title.trim();
          if (
            current.title === normalizedTitle &&
            sameStrings(current.tags, tags)
          ) {
            if (titleDraftRef.current.trim() === current.title) {
              titleDirtyRef.current = false;
            }
            if (sameStrings(parseTagDraft(tagDraftRef.current), current.tags)) {
              tagDirtyRef.current = false;
            }
            return;
          }
          const updated = await recordUpdateAudioMetadata({
            id: current.id,
            expectedRevision: current.revision,
            title: normalizedTitle,
            tags,
          });
          setRecord(updated);
          if (titleDraftRef.current.trim() === updated.title) {
            titleDirtyRef.current = false;
          }
          if (sameStrings(parseTagDraft(tagDraftRef.current), updated.tags)) {
            tagDirtyRef.current = false;
          }
          onTitleChange?.(updated.title);
        });
      metadataSaveQueueRef.current = run.catch((error) => {
        toast.error(
          t('records.metadataSaveFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        void refresh();
      });
    },
    [onTitleChange, recordId, refresh, t, toast],
  );

  const handleExportAudio = useCallback(
    async (track: 'microphone' | 'system' | 'mixed') => {
      if (!record) return;
      setBusyAction('export');
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const baseName = safeRecordExportBaseName(
          record.title,
          t('records.untitled'),
        );
        const destinationPath = await save({
          defaultPath: `${baseName}-${track}.opus`,
          filters: [{ name: t('records.opusAudio'), extensions: ['opus'] }],
        });
        if (!destinationPath) return;
        await recordExportAudio({ recordId, track, destinationPath });
        toast.success(t('records.exportSuccess'));
      } catch (error) {
        toast.error(
          t('records.exportFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [record, recordId, t, toast],
  );

  const handleExportText = useCallback(
    async (format: 'markdown' | 'text') => {
      if (!record) return;
      setBusyAction('export');
      try {
        const extension = format === 'markdown' ? 'md' : 'txt';
        const { save } = await import('@tauri-apps/plugin-dialog');
        const baseName = safeRecordExportBaseName(
          record.title,
          t('records.untitled'),
        );
        const destinationPath = await save({
          defaultPath: `${baseName}.${extension}`,
          filters: [
            {
              name:
                format === 'markdown'
                  ? t('records.markdownDocument')
                  : t('records.textDocument'),
              extensions: [extension],
            },
          ],
        });
        if (!destinationPath) return;
        await recordExportText({
          recordId,
          format,
          destinationPath,
          locale: i18n.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en-US',
        });
        toast.success(t('records.exportSuccess'));
      } catch (error) {
        toast.error(
          t('records.exportFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [i18n.resolvedLanguage, record, recordId, t, toast],
  );

  const handleArchive = useCallback(async () => {
    if (!record) return;
    setBusyAction('archive');
    try {
      const updated = await recordSetArchived(
        record.id,
        !record.archived,
        'record_detail',
      );
      setRecord(updated);
      toast.success(
        t(
          updated.archived
            ? 'records.archiveSuccess'
            : 'records.unarchiveSuccess',
        ),
      );
    } catch (error) {
      toast.error(
        t('records.mutationFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }, [record, t, toast]);

  const handleDiscuss = useCallback(
    (workspaceId: string) => {
      track('task_align_discuss', {});
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, {
          detail: {
            sourceRecordId: recordId,
            sourceRecordKind: 'audio',
            workspaceId,
          },
        }),
      );
    },
    [recordId],
  );

  const handleDelete = useCallback(async () => {
    if (!record) return;
    setBusyAction('delete');
    try {
      await recordDelete(record.id, 'record_detail');
      setShowDeleteConfirm(false);
      toast.success(t('records.deleteSuccess'));
      onDeleted?.();
    } catch (error) {
      toast.error(
        t('records.mutationFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }, [onDeleted, record, t, toast]);

  const handleSaveRecordingSources = useCallback(
    async (selection: { microphone: boolean; system: boolean }) => {
      setBusyAction('sources');
      try {
        await updateConfig({ recordingSourceSelection: selection });
        setShowSourceSettings(false);
        toast.success(t('records.recordingSourcesSaved'));
      } catch (error) {
        toast.error(
          t('records.mutationFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [t, toast, updateConfig],
  );

  const tracks = useMemo(
    () => record?.audio?.tracks ?? [],
    [record?.audio?.tracks],
  );
  const canMixPhysicalTracks =
    tracks.includes('microphone') && tracks.includes('system');
  const playbackTracks = useMemo<Array<typeof playbackTrack>>(() => {
    const available = [...tracks];
    if (canMixPhysicalTracks && !available.includes('mixed')) {
      available.unshift('mixed');
    }
    return available;
  }, [canMixPhysicalTracks, tracks]);
  const selectedTrack = playbackTracks.includes(playbackTrack)
    ? playbackTrack
    : playbackTracks[0];
  const selectedPhysicalTracks = useMemo<Array<typeof playbackTrack>>(() => {
    if (selectedTrack !== 'mixed') return selectedTrack ? [selectedTrack] : [];
    if (tracks.includes('mixed')) return ['mixed'];
    if (canMixPhysicalTracks) return ['microphone', 'system'];
    return tracks[0] ? [tracks[0]] : [];
  }, [canMixPhysicalTracks, selectedTrack, tracks]);
  // `audio.tracks` describes admitted capture sources before permanent media
  // exists. Keep browser media ownership behind the native capture lifecycle
  // so a finalized URL is first attached only after its artifact is published.
  const recordCaptureOwnsArtifacts = [
    'preparing',
    'recording',
    'paused',
    'stopping',
    'finalizing',
  ].includes(record?.audio?.captureStatus ?? '');
  const playbackMediaReady = !ownsCaptureSlot && !recordCaptureOwnsArtifacts;
  const audioSrc =
    playbackMediaReady && selectedPhysicalTracks[0]
      ? recordMediaUrl(recordId, selectedPhysicalTracks[0])
      : undefined;
  const secondaryAudioSrc =
    playbackMediaReady && selectedPhysicalTracks[1]
      ? recordMediaUrl(recordId, selectedPhysicalTracks[1])
      : undefined;
  useEffect(() => {
    playbackSessionTrackedRef.current = false;
    playbackErrorShownRef.current = false;
  }, [audioSrc, secondaryAudioSrc]);
  useEffect(() => {
    const audio = audioRef.current;
    const secondary = secondaryAudioRef.current;
    if (audio) audio.volume = playbackVolume;
    if (secondary) secondary.volume = playbackVolume;
  }, [audioSrc, playbackVolume, secondaryAudioSrc]);

  const trackPlaybackSession = useCallback(() => {
    if (playbackSessionTrackedRef.current) return;
    playbackSessionTrackedRef.current = true;
    void hashPrivateIdentity('record', recordId).then((recordHash) => {
      track('record_use', {
        event_schema_version: 1,
        record_hash: recordHash ?? undefined,
        record_kind: 'audio',
        operation: 'play',
        source: 'desktop',
        surface: 'record_detail',
      });
    });
  }, [recordId]);
  useEffect(() => {
    if (seekMediaMs === undefined || !Number.isFinite(seekMediaMs)) return;
    const mediaMs = Math.max(0, seekMediaMs);
    setPlaybackMs(mediaMs);
    const audio = audioRef.current;
    const secondaryAudio = secondaryAudioRef.current;
    if (audio && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      audio.currentTime = mediaMs / 1_000;
      if (secondaryAudio) secondaryAudio.currentTime = mediaMs / 1_000;
      pendingSeekRef.current = null;
    } else {
      pendingSeekRef.current = mediaMs;
    }
  }, [seekMediaMs, seekNonce]);

  const seekTo = useCallback((mediaMs: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = mediaMs / 1_000;
    if (secondaryAudioRef.current) {
      secondaryAudioRef.current.currentTime = mediaMs / 1_000;
    }
    setPlaybackMs(mediaMs);
  }, []);

  const focusPendingVirtualItem = useCallback(
    (kind: 'transcript' | 'timeline') => {
      window.requestAnimationFrame(() => {
        const pendingRef =
          kind === 'transcript'
            ? pendingTranscriptFocusRef
            : pendingTimelineVirtualFocusRef;
        const itemRefs =
          kind === 'transcript' ? transcriptItemRefs : timelineItemRefs;
        const itemKey = pendingRef.current;
        if (!itemKey) return;
        const element = itemRefs.current.get(itemKey);
        if (!element) return;
        element.focus({ preventScroll: true });
        pendingRef.current = null;
      });
    },
    [],
  );

  const highlightAndFocus = useCallback(
    (itemKey: string, mediaMs: number) => {
      seekTo(mediaMs);
      setHighlightedItem(itemKey);
      if (highlightTimerRef.current !== undefined) {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedItem((current) => (current === itemKey ? null : current));
      }, 1_200);

      if (itemKey.startsWith('transcript-')) {
        const segmentId = itemKey.slice('transcript-'.length);
        const segmentIndex = transcript?.segments.findIndex(
          (segment) => segment.segmentId === segmentId,
        );
        if (
          segmentIndex !== undefined &&
          segmentIndex >= 0 &&
          (transcript?.segments.length ?? 0) >= TRANSCRIPT_VIRTUALIZE_THRESHOLD
        ) {
          pendingTranscriptFocusRef.current = itemKey;
          transcriptVirtuosoRef.current?.scrollToIndex({
            index: segmentIndex,
            align: 'center',
          });
          focusPendingVirtualItem('transcript');
          return;
        }
        const container = transcriptScrollRef.current;
        const element = transcriptItemRefs.current.get(itemKey);
        if (container && element) {
          container.scrollTo({
            top: Math.max(0, element.offsetTop - container.clientHeight / 3),
          });
          element.focus({ preventScroll: true });
        }
        return;
      }

      const timelineIndex = timeline.items.findIndex((item) => {
        const key =
          item.type === 'note' ? `note-${item.noteId}` : `mark-${item.markId}`;
        return key === itemKey;
      });
      if (
        timelineIndex >= 0 &&
        timeline.items.length >= TIMELINE_VIRTUALIZE_THRESHOLD
      ) {
        pendingTimelineVirtualFocusRef.current = itemKey;
        timelineVirtuosoRef.current?.scrollToIndex({
          index: timelineIndex,
          align: 'center',
        });
        focusPendingVirtualItem('timeline');
        return;
      }

      const container = timelineScrollRef.current;
      const element = timelineItemRefs.current.get(itemKey);
      if (container && element) {
        container.scrollTo({
          top: Math.max(0, element.offsetTop - 12),
        });
        element.focus({ preventScroll: true });
      }
    },
    [focusPendingVirtualItem, seekTo, timeline.items, transcript?.segments],
  );

  useEffect(() => {
    if (!pendingTimelineFocus) return;
    const item = timeline.items.find((candidate) => {
      const key =
        candidate.type === 'note'
          ? `note-${candidate.noteId}`
          : `mark-${candidate.markId}`;
      return key === pendingTimelineFocus;
    });
    if (!item) return;
    const frame = window.requestAnimationFrame(() => {
      highlightAndFocus(
        pendingTimelineFocus,
        item.type === 'note' ? item.anchorMediaMs : item.mediaMs,
      );
      setPendingTimelineFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightAndFocus, pendingTimelineFocus, timeline.items]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    const secondaryAudio = secondaryAudioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      secondaryAudio?.pause();
      return;
    }
    if (secondaryAudio) secondaryAudio.currentTime = audio.currentTime;
    const plays = [audio.play()];
    if (secondaryAudio) plays.push(secondaryAudio.play());
    void Promise.all(plays).catch(() => {
      audio.pause();
      secondaryAudio?.pause();
      setPlaying(false);
      setPlaybackError(true);
      if (!playbackErrorShownRef.current) {
        playbackErrorShownRef.current = true;
        toast.error(t('records.playbackFailed'));
      }
    });
  }, [t, toast]);

  const switchPlaybackTrack = useCallback(
    (nextTrack: typeof playbackTrack) => {
      const audio = audioRef.current;
      const nextPrimaryTrack =
        nextTrack === 'mixed'
          ? tracks.includes('mixed')
            ? 'mixed'
            : canMixPhysicalTracks
              ? 'microphone'
              : tracks[0]
          : nextTrack;
      const primaryWillReload = selectedPhysicalTracks[0] !== nextPrimaryTrack;
      const primaryReady =
        audio?.readyState !== undefined &&
        audio.readyState >= HTMLMediaElement.HAVE_METADATA;
      const mediaMs =
        pendingSeekRef.current ??
        (audio && primaryReady
          ? Math.max(0, audio.currentTime * 1_000)
          : playbackMs);
      audio?.pause();
      secondaryAudioRef.current?.pause();
      playbackErrorShownRef.current = false;
      setPlaybackError(false);
      pendingSeekRef.current =
        primaryWillReload || !primaryReady ? mediaMs : null;
      if (!primaryWillReload && primaryReady && audio) {
        audio.currentTime = mediaMs / 1_000;
      }
      setPlaying(false);
      setPlaybackTrack(nextTrack);
    },
    [canMixPhysicalTracks, playbackMs, selectedPhysicalTracks, tracks],
  );

  const speakerIdFor = useCallback(
    (segment: RecordTranscriptSegment): number => {
      const middle =
        segment.startSample +
        Math.floor((segment.endSample - segment.startSample) / 2);
      const turn = diarization?.turns.find(
        (candidate) =>
          candidate.startSample <= middle && candidate.endSample >= middle,
      );
      let speakerId =
        diarization?.segmentSpeakerOverrides[segment.segmentId] ??
        turn?.globalSpeaker ??
        0;
      const visited = new Set<number>();
      while (!visited.has(speakerId)) {
        visited.add(speakerId);
        const mergedInto = diarization?.speakers.find(
          (speaker) => speaker.speakerId === speakerId,
        )?.mergedInto;
        if (mergedInto === undefined) break;
        speakerId = mergedInto;
      }
      return speakerId;
    },
    [diarization],
  );

  const speakerFor = useCallback(
    (segment: RecordTranscriptSegment): string => {
      const speakerId = speakerIdFor(segment);
      const customName = diarization?.speakers.find(
        (speaker) => speaker.speakerId === speakerId,
      )?.customName;
      if (customName) return customName;
      return t('records.speakerUnknown', {
        name: speakerLetter(speakerId),
      });
    },
    [diarization?.speakers, speakerIdFor, t],
  );

  const activeSpeakers = useMemo(
    () =>
      diarization?.speakers.filter(
        (speaker) => speaker.mergedInto === undefined,
      ) ?? [],
    [diarization?.speakers],
  );

  const speakerLabel = useCallback(
    (speakerId: number) => {
      const customName = diarization?.speakers.find(
        (speaker) => speaker.speakerId === speakerId,
      )?.customName;
      return (
        customName ||
        t('records.speakerUnknown', { name: speakerLetter(speakerId) })
      );
    },
    [diarization?.speakers, t],
  );
  const speakerOptions = useMemo(
    () =>
      activeSpeakers.map((speaker) => ({
        value: String(speaker.speakerId),
        label: speakerLabel(speaker.speakerId),
      })),
    [activeSpeakers, speakerLabel],
  );
  const playbackTrackOptions = useMemo(
    () =>
      playbackTracks.map((track) => ({
        value: track,
        label: t(`records.${track}`),
      })),
    [playbackTracks, t],
  );

  const handleRenameSpeaker = useCallback(
    async (speakerId: number) => {
      if (!diarization) return;
      const name = speakerNameDrafts[speakerId]?.trim() ?? '';
      if (
        !name ||
        name ===
          diarization.speakers.find(
            (speaker) => speaker.speakerId === speakerId,
          )?.customName
      )
        return;
      setBusyAction('speaker');
      try {
        setDiarization(
          await recordRenameSpeaker({
            recordId,
            expectedOverrideRevision: diarization.overrideRevision,
            speakerId,
            name,
            updatedAtWallTime: Date.now(),
          }),
        );
      } catch (error) {
        toast.error(
          t('records.speakerCorrectionFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        await refresh();
      } finally {
        setBusyAction(null);
      }
    },
    [diarization, recordId, refresh, speakerNameDrafts, t, toast],
  );

  const handleMergeSpeaker = useCallback(
    async (sourceSpeakerId: number) => {
      if (!diarization) return;
      const targetSpeakerId = Number(speakerMergeTargets[sourceSpeakerId]);
      if (
        !Number.isInteger(targetSpeakerId) ||
        targetSpeakerId === sourceSpeakerId
      )
        return;
      setBusyAction('speaker');
      try {
        const next = await recordMergeSpeakers({
          recordId,
          expectedOverrideRevision: diarization.overrideRevision,
          sourceSpeakerId,
          targetSpeakerId,
          updatedAtWallTime: Date.now(),
        });
        setDiarization(next);
        setSpeakerMergeTargets((current) => ({
          ...current,
          [sourceSpeakerId]: '',
        }));
      } catch (error) {
        toast.error(
          t('records.speakerCorrectionFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        await refresh();
      } finally {
        setBusyAction(null);
      }
    },
    [diarization, recordId, refresh, speakerMergeTargets, t, toast],
  );

  const handleReassignSegment = useCallback(
    async (segmentId: string, speakerId: number) => {
      if (!diarization) return;
      setBusyAction('speaker');
      try {
        setDiarization(
          await recordReassignSegmentSpeaker({
            recordId,
            expectedOverrideRevision: diarization.overrideRevision,
            segmentId,
            speakerId,
            updatedAtWallTime: Date.now(),
          }),
        );
      } catch (error) {
        toast.error(
          t('records.speakerCorrectionFailed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        await refresh();
      } finally {
        setBusyAction(null);
      }
    },
    [diarization, recordId, refresh, t, toast],
  );

  const handleCopyTranscriptSegment = useCallback(
    async (segment: RecordTranscriptSegment) => {
      try {
        await copyPlainText(segment.text);
        setCopiedSegmentId(segment.segmentId);
        if (copyResetTimerRef.current !== undefined) {
          window.clearTimeout(copyResetTimerRef.current);
        }
        copyResetTimerRef.current = window.setTimeout(() => {
          setCopiedSegmentId(null);
          copyResetTimerRef.current = undefined;
        }, 3_000);
      } catch {
        toast.error(t('records.copyFailed'));
      }
    },
    [t, toast],
  );

  const renderTranscriptSegment = useCallback(
    (segment: RecordTranscriptSegment) => {
      if (!transcript) return null;
      const currentSpeakerId = speakerIdFor(segment);
      const mediaMs = (segment.startSample * 1_000) / transcript.sampleRate;
      const itemKey = `transcript-${segment.segmentId}`;
      return (
        <article
          key={segment.segmentId}
          tabIndex={-1}
          ref={(element) => {
            if (element) transcriptItemRefs.current.set(itemKey, element);
            else transcriptItemRefs.current.delete(itemKey);
          }}
          className={`group relative mb-1.5 grid grid-cols-[52px_minmax(0,1fr)] items-start gap-2 rounded-[var(--radius-md)] px-2 py-2 transition-colors hover:bg-[var(--hover-bg)] ${highlightedItem === itemKey ? 'bg-[var(--accent-warm-subtle)]' : ''}`}
        >
          <button
            type="button"
            onClick={() => void handleCopyTranscriptSegment(segment)}
            className="isolate absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-full bg-[var(--paper-elevated)] px-2 py-1 text-xs font-medium text-[var(--ink-secondary)] opacity-0 shadow-xs transition-[opacity,color,background-color] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-warm)]"
            aria-label={
              copiedSegmentId === segment.segmentId
                ? t('records.copied')
                : t('records.copy')
            }
          >
            <span
              aria-hidden="true"
              data-testid="transcript-copy-mask"
              className="pointer-events-none absolute -bottom-2 -left-12 -right-2 -top-2 -z-10 bg-gradient-to-r from-[var(--paper-elevated-a0)] to-[var(--paper-elevated)]"
            />
            {copiedSegmentId === segment.segmentId ? (
              <Check className="h-3 w-3" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            {copiedSegmentId === segment.segmentId
              ? t('records.copied')
              : t('records.copy')}
          </button>
          <button
            type="button"
            onClick={() => highlightAndFocus(itemKey, mediaMs)}
            className="self-start pt-1 text-left text-xs tabular-nums text-[var(--ink-muted)] hover:text-[var(--accent-warm)]"
          >
            {formatDuration(mediaMs)}
          </button>
          <div
            data-testid="transcript-speaker-line"
            className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1"
          >
            {activeSpeakers.length > 0 ? (
              <CustomSelect
                value={String(currentSpeakerId)}
                options={speakerOptions}
                onChange={(value) =>
                  void handleReassignSegment(segment.segmentId, Number(value))
                }
                disabled={busyAction !== null}
                compact
                className="w-fit min-w-24 shrink-0 self-start [&>button]:border-0 [&>button]:bg-[var(--paper-inset)] [&>button]:py-0.5"
                ariaLabel={t('records.reassignSegmentSpeaker')}
              />
            ) : (
              <span className="inline-flex shrink-0 rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-secondary)]">
                {speakerFor(segment)}
              </span>
            )}
            <button
              type="button"
              onClick={() => highlightAndFocus(itemKey, mediaMs)}
              className="min-w-0 flex-1 text-left text-sm leading-relaxed text-[var(--ink)]"
            >
              {segment.text}
            </button>
          </div>
        </article>
      );
    },
    [
      activeSpeakers,
      busyAction,
      copiedSegmentId,
      handleCopyTranscriptSegment,
      handleReassignSegment,
      highlightAndFocus,
      highlightedItem,
      speakerFor,
      speakerIdFor,
      speakerOptions,
      t,
      transcript,
    ],
  );

  const renderTimelineItem = useCallback(
    (item: RecordTimelineItem) => {
      const mediaMs = item.type === 'note' ? item.anchorMediaMs : item.mediaMs;
      const itemId = item.type === 'note' ? item.noteId : item.markId;
      const isEditing = item.type === 'note' && editingNoteId === item.noteId;
      const itemKey = `${item.type}-${itemId}`;
      return (
        <div key={itemKey} className="px-4 pb-3">
          <div
            ref={(element) => {
              if (element) timelineItemRefs.current.set(itemKey, element);
              else timelineItemRefs.current.delete(itemKey);
            }}
            tabIndex={-1}
            data-testid={`recording-timeline-${itemKey}`}
            className={`group relative grid w-full grid-cols-[48px_minmax(0,1fr)] items-start gap-2 rounded-[var(--radius-sm)] px-1 py-1 text-left text-sm leading-relaxed transition-colors ${item.type === 'mark' ? 'text-[var(--accent-warm)]' : 'text-[var(--ink)]'} ${highlightedItem === itemKey ? 'bg-[var(--accent-warm-subtle)]' : ''}`}
          >
            <button
              type="button"
              onClick={() => highlightAndFocus(itemKey, mediaMs)}
              className="text-left text-xs tabular-nums text-[var(--ink-muted)] hover:text-[var(--accent-warm)]"
              aria-label={t('records.seekTimeline', {
                time: formatDuration(mediaMs),
              })}
            >
              {formatDuration(mediaMs)}
            </button>
            {isEditing ? (
              <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-2 pb-1.5 pt-2 focus-within:border-[var(--accent-warm)]">
                <textarea
                  autoFocus
                  value={editingNoteDraft}
                  onChange={(event) => setEditingNoteDraft(event.target.value)}
                  className="min-h-20 w-full resize-y bg-transparent text-sm text-[var(--ink)] outline-none"
                  aria-label={t('records.editNote')}
                />
                <div className="mt-2 flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => void handleUpdateNote()}
                    disabled={busyAction !== null || !editingNoteDraft.trim()}
                    className="rounded p-1 text-[var(--success)] hover:bg-[var(--paper-inset)] disabled:opacity-40"
                    aria-label={t('records.saveNoteEdit')}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingNoteId(null);
                      setEditingNoteDraft('');
                    }}
                    disabled={busyAction !== null}
                    className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                    aria-label={t('records.cancelNoteEdit')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => highlightAndFocus(itemKey, mediaMs)}
                className="whitespace-pre-wrap break-words text-left"
              >
                {item.type === 'note' ? item.text : t('records.mark')}
              </button>
            )}
            {!isEditing && (
              <div className="pointer-events-none absolute right-0 top-0 flex items-center bg-gradient-to-r from-[var(--paper-elevated-a0)] via-[var(--paper-elevated)] to-[var(--paper-elevated)] pb-1 pl-7 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                <DropdownMenu
                  size="sm"
                  disabled={busyAction !== null}
                  minWidth={112}
                  sections={[
                    {
                      items: [
                        ...(item.type === 'note'
                          ? [
                              {
                                icon: <Pencil className="h-3.5 w-3.5" />,
                                label: t('records.editNote'),
                                onClick: () => {
                                  setEditingNoteId(item.noteId);
                                  setEditingNoteDraft(item.text);
                                },
                              },
                            ]
                          : []),
                        {
                          icon: <Trash2 className="h-3.5 w-3.5" />,
                          label:
                            item.type === 'note'
                              ? t('records.deleteNote')
                              : t('records.deleteMark'),
                          onClick: () =>
                            void handleDeleteTimelineItem(item.type, itemId),
                          danger: true,
                        },
                      ],
                    },
                  ]}
                />
              </div>
            )}
          </div>
        </div>
      );
    },
    [
      busyAction,
      editingNoteDraft,
      editingNoteId,
      handleDeleteTimelineItem,
      handleUpdateNote,
      highlightAndFocus,
      highlightedItem,
      t,
    ],
  );

  const captureStatus = snapshot?.captureStatus ?? record?.audio?.captureStatus;
  const transcriptionStatus = record?.audio?.transcriptionStatus;
  const liveTranscriptionFailed =
    ownsCaptureSlot && transcriptionStatus === 'failed';
  const completedTranscriptionFailed =
    !ownsCaptureSlot && transcriptionStatus === 'failed';
  const systemAudioDowngraded = snapshot?.warnings.some(
    (warning) => warning.code === 'RECORDING_SYSTEM_AUDIO_UNAVAILABLE',
  );
  const wakeLockUnavailable = snapshot?.warnings.some(
    (warning) => warning.code === 'RECORDING_WAKE_LOCK_UNAVAILABLE',
  );
  const statusLabel =
    !captureStatus && !transcriptionStatus && recordLoading
      ? t('records.loadingRecord')
      : captureStatus === 'recording'
        ? t('records.recording')
        : captureStatus === 'paused'
          ? t('records.paused')
          : captureStatus === 'interrupted'
            ? t('records.interrupted')
            : captureStatus === 'failed' || transcriptionStatus === 'failed'
              ? t('records.failed')
              : transcriptionStatus &&
                  [
                    'queued',
                    'live',
                    'lagging',
                    'recovering',
                    'finalizing',
                  ].includes(transcriptionStatus)
                ? t('records.processing')
                : t('records.complete');
  const statusDotClass =
    !captureStatus && !transcriptionStatus && recordLoading
      ? 'bg-[var(--ink-muted)]'
      : captureStatus === 'recording'
        ? 'bg-[var(--error)]'
        : captureStatus === 'interrupted' ||
            captureStatus === 'failed' ||
            transcriptionStatus === 'failed'
          ? 'bg-[var(--error)]'
          : ownsCaptureSlot
            ? 'bg-[var(--warning)]'
            : 'bg-[var(--success)]';
  const playbackDurationMs = record?.audio?.mediaDurationMs ?? 0;
  const playbackPercent = Math.min(
    100,
    Math.max(0, (playbackMs / Math.max(1, playbackDurationMs)) * 100),
  );
  const showManualTranscription =
    !transcript &&
    !ownsCaptureSlot &&
    (transcriptionStatus === 'not_started' || modelPack?.usable === true);
  const canDiscuss =
    !ownsCaptureSlot &&
    ['ready', 'interrupted'].includes(captureStatus ?? '') &&
    (record?.audio?.sizeBytes ?? 0) > 0;
  const recordActionSections = useMemo<DropdownMenuSection[]>(
    () => [
      {
        items: [
          {
            icon: <MessageSquare className="h-3.5 w-3.5" />,
            label: t('thoughts.aiDiscuss'),
            onClick: () => setShowWorkspacePicker(true),
            disabled: !canDiscuss,
          },
        ],
      },
      {
        items: tracks.map((track) => ({
          icon: <Download className="h-3.5 w-3.5" />,
          label: t('records.exportAudioTrack', {
            track: t(`records.${track}`),
          }),
          onClick: () => void handleExportAudio(track),
          disabled: ownsCaptureSlot,
        })),
      },
      {
        items: [
          {
            icon: <FileText className="h-3.5 w-3.5" />,
            label: t('records.exportTranscriptAndNotes'),
            onClick: () => void handleExportText('markdown'),
            disabled: ownsCaptureSlot,
          },
        ],
      },
      {
        items: record
          ? [
              {
                icon: record.archived ? (
                  <ArchiveRestore className="h-3.5 w-3.5" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                ),
                label: t(
                  record.archived ? 'records.unarchive' : 'records.archive',
                ),
                onClick: () => void handleArchive(),
                disabled: ownsCaptureSlot,
              },
            ]
          : [],
      },
      {
        items: [
          {
            icon: <Trash2 className="h-3.5 w-3.5" />,
            label: t('records.delete'),
            danger: true,
            disabled: ownsCaptureSlot,
            onClick: () => setShowDeleteConfirm(true),
          },
        ],
      },
    ],
    [
      canDiscuss,
      handleArchive,
      handleExportAudio,
      handleExportText,
      ownsCaptureSlot,
      record,
      t,
      tracks,
    ],
  );

  if (loadError && !record && !snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--paper)] p-8 text-sm text-[var(--error)]">
        <span>{t('records.loadFailed', { message: loadError })}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="font-semibold text-[var(--accent-warm)] hover:underline"
        >
          {t('records.retryLoad')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(320px,2fr)] grid-rows-[52px_84px_minmax(0,1fr)] gap-x-5 px-5 pb-5 max-lg:grid-cols-1 max-lg:grid-rows-[52px_auto_minmax(300px,55vh)_minmax(320px,65vh)] max-lg:gap-y-4 max-lg:overflow-y-auto">
        <header className="col-start-1 row-start-1 flex min-w-0 items-center gap-3">
          <div
            data-testid="record-title-status"
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <input
              value={titleDraft}
              onChange={(event) => {
                titleDraftRef.current = event.target.value;
                titleDirtyRef.current = true;
                setTitleDraft(event.target.value);
              }}
              onBlur={() =>
                queueMetadataSave(titleDraft, parseTagDraft(tagDraft))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              aria-label={t('records.titleLabel')}
              className="min-w-20 max-w-[calc(100%_-_88px)] truncate rounded-[var(--radius-sm)] bg-transparent px-1.5 py-1 text-base font-semibold text-[var(--ink)] outline-none transition-colors hover:bg-[var(--paper-inset)] focus:bg-[var(--paper-inset)]"
              style={{
                width: `${Math.min(48, Math.max(8, Array.from(titleDraft).length + 1))}ch`,
              }}
            />
            <span
              className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-[var(--ink-muted)]"
              role="status"
              aria-live="polite"
              data-status={captureStatus ?? transcriptionStatus}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
              {statusLabel}
            </span>
          </div>
        </header>

        <section className="col-start-1 row-start-2 flex h-[84px] items-center gap-5 overflow-hidden rounded-[var(--radius-lg)] bg-[var(--ink)] px-5 text-[var(--paper)] shadow-sm max-lg:grid max-lg:h-auto max-lg:min-h-[132px] max-lg:grid-cols-[92px_minmax(0,1fr)] max-lg:grid-rows-[auto_auto] max-lg:gap-x-4 max-lg:gap-y-2 max-lg:overflow-visible max-lg:py-3">
          {ownsCaptureSlot ? (
            <>
              <div className="min-w-[92px] max-lg:col-start-1 max-lg:row-start-1">
                <div
                  className="font-mono text-2xl font-semibold tabular-nums"
                  data-testid="recording-media-duration"
                >
                  {formatDuration(mediaDurationMs)}
                </div>
                <div className="mt-1 text-xs opacity-65">
                  {isPaused ? t('records.paused') : statusLabel}
                </div>
              </div>
              <div
                className="flex min-w-0 flex-1 flex-col justify-center gap-2 overflow-hidden max-lg:col-start-2 max-lg:row-start-1"
                data-testid="recording-source-meters"
              >
                {(snapshot?.sources ?? []).map((source) => {
                  const activity = snapshot?.sourceActivity.find(
                    (candidate) => candidate.track === source.track,
                  );
                  const enabled = activity?.enabled ?? true;
                  const level = enabled ? (activity?.levelPercent ?? 0) : 0;
                  const sourceLabel = t(`records.${source.track}`);
                  return (
                    <button
                      type="button"
                      key={source.track}
                      data-testid="recording-source-meter"
                      aria-pressed={enabled}
                      aria-label={t(
                        enabled
                          ? 'records.sourceEnabledLabel'
                          : 'records.sourceDisabledLabel',
                        { source: sourceLabel },
                      )}
                      title={t(
                        enabled
                          ? 'records.sourceEnabledHint'
                          : 'records.sourceDisabledHint',
                        { source: sourceLabel },
                      )}
                      disabled={
                        busyAction !== null ||
                        !['recording', 'paused'].includes(
                          snapshot?.captureStatus ?? '',
                        ) ||
                        source.track === 'mixed'
                      }
                      onClick={() => {
                        if (
                          source.track === 'microphone' ||
                          source.track === 'system'
                        ) {
                          void runSourceControl(source.track, !enabled);
                        }
                      }}
                      className={`grid min-w-0 grid-cols-[72px_minmax(48px,1fr)_16px] items-center gap-2 rounded-[var(--radius-sm)] px-1 py-0.5 text-left text-xs transition-colors hover:bg-[var(--paper)]/10 disabled:cursor-default ${enabled ? '' : 'opacity-45'}`}
                    >
                      <span
                        className={`truncate ${enabled ? 'opacity-80' : 'line-through'}`}
                      >
                        {sourceLabel}
                      </span>
                      <span className="h-1.5 min-w-0 overflow-hidden rounded-full bg-[var(--paper)]/20">
                        <span
                          className="block h-full origin-left rounded-full bg-[var(--success)] transition-transform duration-300 ease-out"
                          style={{ transform: `scaleX(${level / 100})` }}
                        />
                      </span>
                      <span
                        aria-hidden="true"
                        className="flex justify-end opacity-70"
                      >
                        {!enabled && <X className="h-3 w-3" />}
                      </span>
                    </button>
                  );
                })}
                {systemAudioDowngraded && (
                  <span className="truncate text-xs text-[var(--warning)]">
                    {t('records.systemAudioDowngraded')}
                  </span>
                )}
                {wakeLockUnavailable && (
                  <span
                    role="status"
                    className="truncate text-xs text-[var(--warning)]"
                    title={t('records.wakeLockUnavailable')}
                  >
                    {t('records.wakeLockUnavailable')}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 max-lg:col-span-2 max-lg:row-start-2 max-lg:justify-end">
                <button
                  type="button"
                  onClick={() => void runControl(isPaused ? 'resume' : 'pause')}
                  disabled={
                    busyAction !== null ||
                    !['recording', 'paused'].includes(
                      snapshot?.captureStatus ?? '',
                    )
                  }
                  className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper)]/12 px-3 text-sm font-medium transition-colors hover:bg-[var(--paper)]/20 disabled:opacity-40"
                >
                  {isPaused ? (
                    <Play className="h-4 w-4" />
                  ) : (
                    <Pause className="h-4 w-4" />
                  )}
                  {isPaused ? t('records.resume') : t('records.pause')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleStop()}
                  disabled={busyAction !== null || !snapshot}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--error)] px-3 text-sm font-semibold text-[var(--on-error)] transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                  {t('records.stop')}
                </button>
              </div>
            </>
          ) : (
            <div className="grid min-w-0 flex-1 grid-cols-[36px_minmax(140px,1fr)_116px] items-center gap-4 max-lg:col-span-2">
              <button
                type="button"
                disabled={!audioSrc}
                onClick={() => {
                  togglePlayback();
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--paper)] text-[var(--ink)] disabled:opacity-40"
                aria-label={
                  playing ? t('records.pausePlayback') : t('records.play')
                }
              >
                {playing ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="ml-0.5 h-4 w-4" />
                )}
              </button>
              <div
                className="flex min-w-0 flex-col gap-1"
                data-testid="recording-playback-timeline"
              >
                <div
                  className="relative h-5 min-w-[120px]"
                  data-testid="recording-playback-progress"
                >
                  <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--paper)]/20">
                    <span
                      className="block h-full rounded-full bg-[var(--accent-warm)]"
                      style={{ width: `${playbackPercent}%` }}
                    />
                  </div>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--paper)] shadow-sm"
                    style={{ left: `${playbackPercent}%` }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, playbackDurationMs)}
                    value={Math.min(playbackMs, playbackDurationMs)}
                    onChange={(event) => seekTo(Number(event.target.value))}
                    className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                    aria-label={t('records.duration')}
                  />
                </div>
                <span className="text-center font-mono text-xs tabular-nums text-[var(--paper)]/70">
                  {formatDuration(playbackMs)} /{' '}
                  {formatDuration(playbackDurationMs)}
                </span>
              </div>
              <div
                className="flex min-w-0 flex-col gap-1.5"
                data-testid="recording-playback-tools"
              >
                {playbackTracks.length > 1 && (
                  <CustomSelect
                    value={selectedTrack}
                    options={playbackTrackOptions}
                    onChange={(value) =>
                      switchPlaybackTrack(value as typeof playbackTrack)
                    }
                    compact
                    className="w-full [&>button]:border-[var(--paper)]/20 [&>button]:bg-[var(--paper)] [&>button]:text-[var(--ink)] [&>button>span]:text-[var(--ink)] [&>button>svg]:text-[var(--ink-muted)]"
                    popoverMinWidth={120}
                    ariaLabel={t('records.tracks')}
                  />
                )}
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setPlaybackVolume((current) => (current > 0 ? 0 : 1))
                    }
                    className="shrink-0 text-[var(--paper)]/75 transition-colors hover:text-[var(--paper)]"
                    aria-label={
                      playbackVolume > 0
                        ? t('records.mutePlayback')
                        : t('records.unmutePlayback')
                    }
                  >
                    {playbackVolume > 0 ? (
                      <Volume2 className="h-4 w-4" />
                    ) : (
                      <VolumeX className="h-4 w-4" />
                    )}
                  </button>
                  <div className="relative h-5 min-w-0 flex-1">
                    <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-[var(--paper)]/20">
                      <span
                        className="block h-full rounded-full bg-[var(--paper)]/75"
                        style={{ width: `${playbackVolume * 100}%` }}
                      />
                    </div>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--paper)]"
                      style={{ left: `${playbackVolume * 100}%` }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={playbackVolume}
                      onChange={(event) =>
                        setPlaybackVolume(Number(event.target.value))
                      }
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      aria-label={t('records.volume')}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          {audioSrc && (
            <audio
              ref={audioRef}
              src={audioSrc}
              data-testid="recording-primary-audio"
              preload="metadata"
              onLoadedMetadata={(event) => {
                const pending = pendingSeekRef.current;
                if (pending === null) return;
                event.currentTarget.currentTime = pending / 1_000;
                setPlaybackMs(pending);
                pendingSeekRef.current = null;
              }}
              onPlay={() => {
                setPlaying(true);
                trackPlaybackSession();
              }}
              onPause={() => setPlaying(false)}
              onError={() => {
                audioRef.current?.pause();
                secondaryAudioRef.current?.pause();
                setPlaying(false);
                setPlaybackError(true);
                if (!playbackErrorShownRef.current) {
                  playbackErrorShownRef.current = true;
                  toast.error(t('records.playbackFailed'));
                }
              }}
              onEnded={() => {
                secondaryAudioRef.current?.pause();
                setPlaying(false);
                playbackSessionTrackedRef.current = false;
              }}
              onTimeUpdate={(event) => {
                const currentTime = event.currentTarget.currentTime;
                const secondaryAudio = secondaryAudioRef.current;
                if (
                  secondaryAudio &&
                  Math.abs(secondaryAudio.currentTime - currentTime) > 0.12
                ) {
                  secondaryAudio.currentTime = currentTime;
                }
                setPlaybackMs(currentTime * 1_000);
              }}
            />
          )}
          {secondaryAudioSrc && (
            <audio
              ref={secondaryAudioRef}
              src={secondaryAudioSrc}
              data-testid="recording-secondary-audio"
              preload="metadata"
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime =
                  audioRef.current?.currentTime ?? playbackMs / 1_000;
              }}
              onError={() => {
                audioRef.current?.pause();
                secondaryAudioRef.current?.pause();
                setPlaying(false);
                setPlaybackError(true);
                if (!playbackErrorShownRef.current) {
                  playbackErrorShownRef.current = true;
                  toast.error(t('records.playbackFailed'));
                }
              }}
            />
          )}
          {playbackError && (
            <span className="sr-only" role="alert">
              {t('records.playbackFailed')}
            </span>
          )}
        </section>

        <section className="col-start-1 row-start-3 flex min-h-0 flex-col py-4 pr-2 max-lg:row-start-3">
          <div className="mb-3 flex min-h-6 items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--ink)]">
              {t('records.transcript')}
            </h2>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="truncate text-xs text-[var(--ink-muted)]"
                role="status"
                aria-live="polite"
              >
                {liveTranscriptionFailed
                  ? t('records.transcriptLiveFailed')
                  : transcriptionStatus === 'lagging' ||
                      transcript?.state === 'lagging'
                    ? t('records.transcriptLagging')
                    : transcriptionStatus === 'recovering' ||
                        transcript?.state === 'recovering'
                      ? t('records.transcriptRecovering')
                      : ownsCaptureSlot
                        ? t('records.transcriptLive')
                        : transcriptionStatus &&
                            [
                              'queued',
                              'live',
                              'lagging',
                              'recovering',
                              'finalizing',
                            ].includes(transcriptionStatus)
                          ? t('records.transcriptPending')
                          : null}
              </span>
              <span ref={recordActionsAnchorRef} className="flex shrink-0">
                <DropdownMenu
                  sections={recordActionSections}
                  size="sm"
                  minWidth={220}
                  disabled={busyAction !== null}
                  title={t('records.moreActions')}
                />
              </span>
              <RecordWorkspacePicker
                open={showWorkspacePicker}
                onClose={() => setShowWorkspacePicker(false)}
                anchorRef={recordActionsAnchorRef}
                tags={record?.tags ?? []}
                onSelect={handleDiscuss}
              />
            </div>
          </div>
          {(loadError || projectionError) && (
            <div
              role="alert"
              className="mb-3 flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--ink-secondary)]"
            >
              <span>
                {t('records.loadFailed', {
                  message: loadError ?? projectionError,
                })}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="shrink-0 font-semibold text-[var(--accent-warm)] hover:underline"
              >
                {t('records.retryLoad')}
              </button>
            </div>
          )}
          {liveTranscriptionFailed && (
            <div
              role="status"
              className="mb-3 rounded-[var(--radius-md)] bg-[var(--warning)]/10 px-3 py-2 text-sm text-[var(--ink-secondary)]"
            >
              {t('records.transcriptLiveFailedHint')}
            </div>
          )}
          {completedTranscriptionFailed && (
            <div
              role="status"
              className="mb-3 flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--warning)]/10 px-3 py-2 text-sm text-[var(--ink-secondary)]"
            >
              <span>{t('records.transcriptFailedHint')}</span>
              <button
                type="button"
                onClick={() => {
                  if (modelPack?.usable) {
                    void handleStartTranscription();
                    return;
                  }
                  window.dispatchEvent(
                    new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
                      detail: {
                        section: 'mcp',
                        officialToolId: 'speech-recognition',
                      },
                    }),
                  );
                }}
                disabled={busyAction !== null}
                className="shrink-0 font-semibold text-[var(--accent-warm)] hover:underline disabled:opacity-50"
              >
                {modelPack?.usable
                  ? t('records.retryTranscription')
                  : t('records.openSpeechTool')}
              </button>
            </div>
          )}
          {transcript?.segments.length ? (
            <div
              className="min-h-0 flex-1"
              aria-label={t('records.transcript')}
            >
              {transcript.segments.length < TRANSCRIPT_VIRTUALIZE_THRESHOLD ? (
                <div
                  ref={transcriptScrollRef}
                  className="h-full overflow-y-auto"
                >
                  {transcript.segments.map(renderTranscriptSegment)}
                </div>
              ) : (
                <Virtuoso
                  ref={transcriptVirtuosoRef}
                  data={transcript.segments}
                  computeItemKey={(_index, segment) => segment.segmentId}
                  itemContent={(_index, segment) =>
                    renderTranscriptSegment(segment)
                  }
                  increaseViewportBy={300}
                  rangeChanged={() => focusPendingVirtualItem('transcript')}
                  className="h-full"
                />
              )}
            </div>
          ) : liveTranscriptionFailed ? null : showManualTranscription ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-[var(--radius-lg)] bg-[var(--paper-inset)] p-6 text-center">
              <p className="text-sm text-[var(--ink-secondary)]">
                {t('records.transcriptEmpty')}
              </p>
              <button
                type="button"
                onClick={() => void handleStartTranscription()}
                disabled={busyAction !== null}
                className="mt-3 rounded-[var(--radius-md)] bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
              >
                {busyAction === 'transcribe'
                  ? t('records.startingTranscription')
                  : t('records.startTranscription')}
              </button>
            </div>
          ) : transcriptionStatus === 'unavailable' ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-[var(--radius-lg)] bg-[var(--paper-inset)] p-6 text-center">
              <p className="max-w-sm text-sm text-[var(--ink-secondary)]">
                {t('records.resourceRequired')}
              </p>
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
                      detail: {
                        section: 'mcp',
                        officialToolId: 'speech-recognition',
                      },
                    }),
                  )
                }
                className="mt-3 text-sm font-medium text-[var(--accent-warm)] hover:underline"
              >
                {t('records.openSpeechTool')}
              </button>
            </div>
          ) : (
            <div className="flex min-h-48 items-center justify-center text-sm text-[var(--ink-muted)]">
              {t('records.transcriptEmpty')}
            </div>
          )}
        </section>

        <aside
          data-testid="record-notes-panel"
          className="col-start-2 row-span-3 row-start-1 flex min-h-0 flex-col rounded-[var(--radius-lg)] bg-[var(--paper-elevated)] shadow-xs max-lg:col-start-1 max-lg:row-span-1 max-lg:row-start-4"
        >
          <div className="flex min-h-0 flex-1 flex-col pt-4">
            <h2 className="mb-3 px-4 text-sm font-semibold">
              {t('records.notes')}
            </h2>
            {timeline.items.length ? (
              timeline.items.length < TIMELINE_VIRTUALIZE_THRESHOLD ? (
                <div
                  ref={timelineScrollRef}
                  className="min-h-0 flex-1 overflow-y-auto"
                >
                  {timeline.items.map(renderTimelineItem)}
                </div>
              ) : (
                <Virtuoso
                  ref={timelineVirtuosoRef}
                  data={timeline.items}
                  computeItemKey={(_index, item) =>
                    item.type === 'note'
                      ? `note-${item.noteId}`
                      : `mark-${item.markId}`
                  }
                  itemContent={(_index, item) => renderTimelineItem(item)}
                  increaseViewportBy={240}
                  rangeChanged={() => focusPendingVirtualItem('timeline')}
                  className="min-h-0 flex-1"
                />
              )
            ) : (
              <p className="min-h-0 flex-1 px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                {t('records.noNotes')}
              </p>
            )}

            {!ownsCaptureSlot &&
              ((diarization && activeSpeakers.length > 0) || record?.audio) && (
                <div className="max-h-[45%] shrink-0 overflow-y-auto px-4">
                  {diarization && activeSpeakers.length > 0 && (
                    <div className="border-t border-[var(--line-subtle)] py-4">
                      <h2 className="mb-1 text-sm font-semibold">
                        {t('records.speakerCorrection')}
                      </h2>
                      <p className="mb-3 text-xs text-[var(--ink-muted)]">
                        {t('records.speakerCorrectionHint')}
                      </p>
                      <div className="space-y-3">
                        {activeSpeakers.map((speaker) => (
                          <div key={speaker.speakerId} className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <span className="w-20 shrink-0 truncate text-xs font-medium text-[var(--ink-secondary)]">
                                {t('records.speakerUnknown', {
                                  name: speakerLetter(speaker.speakerId),
                                })}
                              </span>
                              <input
                                value={
                                  speakerNameDrafts[speaker.speakerId] ?? ''
                                }
                                onChange={(event) =>
                                  setSpeakerNameDrafts((current) => ({
                                    ...current,
                                    [speaker.speakerId]: event.target.value,
                                  }))
                                }
                                onBlur={() =>
                                  void handleRenameSpeaker(speaker.speakerId)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.currentTarget.blur();
                                  }
                                }}
                                placeholder={t(
                                  'records.speakerNamePlaceholder',
                                )}
                                disabled={busyAction !== null}
                                className="min-w-0 flex-1 rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-2 py-1.5 text-xs text-[var(--ink)] outline-none focus:ring-1 focus:ring-[var(--accent-warm)] disabled:opacity-50"
                                aria-label={t('records.renameSpeaker', {
                                  speaker: speakerLabel(speaker.speakerId),
                                })}
                              />
                            </div>
                            {activeSpeakers.length > 1 && (
                              <div className="flex items-center gap-2 pl-[88px]">
                                <CustomSelect
                                  value={
                                    speakerMergeTargets[speaker.speakerId] ?? ''
                                  }
                                  options={speakerOptions.filter(
                                    (candidate) =>
                                      candidate.value !==
                                      String(speaker.speakerId),
                                  )}
                                  onChange={(value) =>
                                    setSpeakerMergeTargets((current) => ({
                                      ...current,
                                      [speaker.speakerId]: value,
                                    }))
                                  }
                                  disabled={busyAction !== null}
                                  compact
                                  className="min-w-0 flex-1 [&>button]:bg-[var(--paper-inset)]"
                                  placeholder={t('records.mergeInto')}
                                  ariaLabel={t('records.mergeSpeakerTarget', {
                                    speaker: speakerLabel(speaker.speakerId),
                                  })}
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleMergeSpeaker(speaker.speakerId)
                                  }
                                  disabled={
                                    busyAction !== null ||
                                    !speakerMergeTargets[speaker.speakerId]
                                  }
                                  className="rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)] disabled:opacity-40"
                                >
                                  {t('records.merge')}
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      {diarization.conflicts.length > 0 && (
                        <p
                          className="mt-3 text-xs text-[var(--warning)]"
                          role="status"
                        >
                          {t('records.speakerOverrideConflicts', {
                            count: diarization.conflicts.length,
                          })}
                        </p>
                      )}
                    </div>
                  )}

                  {record?.audio && (
                    <div className="border-t border-[var(--line-subtle)] py-4">
                      <h2 className="mb-3 text-sm font-semibold">
                        {t('records.recordInfo')}
                      </h2>
                      <dl className="space-y-2 text-xs">
                        <div className="flex items-start justify-between gap-4">
                          <dt className="pt-1.5 text-[var(--ink-muted)]">
                            {t('records.tags')}
                          </dt>
                          <dd className="min-w-0 flex-1">
                            <input
                              value={tagDraft}
                              onChange={(event) => {
                                tagDraftRef.current = event.target.value;
                                tagDirtyRef.current = true;
                                setTagDraft(event.target.value);
                              }}
                              onBlur={() =>
                                queueMetadataSave(
                                  titleDraft,
                                  parseTagDraft(tagDraft),
                                )
                              }
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.currentTarget.blur();
                                }
                              }}
                              placeholder={t('records.tagsPlaceholder')}
                              aria-label={t('records.tags')}
                              className="w-full rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-2 py-1.5 text-xs text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)] focus:ring-1 focus:ring-[var(--accent-warm)]"
                            />
                          </dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-[var(--ink-muted)]">
                            {t('records.duration')}
                          </dt>
                          <dd>
                            {formatDuration(record.audio.mediaDurationMs)}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-[var(--ink-muted)]">
                            {t('records.tracks')}
                          </dt>
                          <dd>
                            {record.audio.tracks
                              .map((track) => t(`records.${track}`))
                              .join(' · ')}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-4">
                          <dt className="text-[var(--ink-muted)]">
                            {t('records.size')}
                          </dt>
                          <dd>{formatBytes(record.audio.sizeBytes)}</dd>
                        </div>
                        {transcript?.provenance.modelPackRevision && (
                          <div className="flex justify-between gap-4">
                            <dt className="text-[var(--ink-muted)]">
                              {t('records.model')}
                            </dt>
                            <dd className="truncate">
                              {transcript.provenance.modelPackRevision}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  )}
                </div>
              )}
          </div>

          {ownsCaptureSlot && (
            <div className="shrink-0 p-3 pt-2">
              <div
                data-testid="recording-note-composer"
                className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-transparent px-3 pb-2 pt-3 focus-within:border-[var(--accent-warm)]"
              >
                <textarea
                  value={noteDraft}
                  aria-label={t('records.notePlaceholder')}
                  onChange={(event) => {
                    const next = event.target.value;
                    noteDraftRef.current = next;
                    if (next.trim() && noteAnchorRef.current === null) {
                      noteAnchorRef.current = currentMediaMs();
                      noteStartedWallRef.current = Date.now();
                    } else if (!next.trim()) {
                      noteAnchorRef.current = null;
                      noteStartedWallRef.current = null;
                    }
                    setNoteDraft(next);
                  }}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false;
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !composingRef.current &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault();
                      if (busyAction === 'note') return;
                      void submitNote();
                    }
                  }}
                  placeholder={t('records.notePlaceholder')}
                  className="min-h-20 w-full resize-none bg-transparent text-sm leading-relaxed text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
                />
                <div className="mt-2 flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => void handleMark()}
                    disabled={busyAction !== null}
                    className="rounded-[var(--radius-md)] px-3 py-1.5 text-sm font-medium text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)] disabled:opacity-50"
                  >
                    {t('records.mark')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitNote()}
                    disabled={!noteDraft.trim() || busyAction !== null}
                    className="rounded-[var(--radius-md)] bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-40"
                  >
                    {t('records.addNote')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </aside>
      </main>
      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('records.deleteConfirmTitle')}
          message={t('records.deleteConfirmMessage')}
          confirmText={t('records.delete')}
          confirmVariant="danger"
          loading={busyAction === 'delete'}
          onConfirm={() => void handleDelete()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
      {showSourceSettings && (
        <RecordingSourceDialog
          mode="settings"
          initialSelection={
            config.recordingSourceSelection ?? {
              microphone: true,
              system: true,
            }
          }
          modelPackUsable={modelPack?.usable}
          busy={busyAction === 'sources'}
          onConfirm={handleSaveRecordingSources}
          onCancel={() => setShowSourceSettings(false)}
          onOpenSpeechSettings={() => {
            setShowSourceSettings(false);
            window.dispatchEvent(
              new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
                detail: {
                  section: 'mcp',
                  officialToolId: 'speech-recognition',
                },
              }),
            );
          }}
        />
      )}
    </div>
  );
}
