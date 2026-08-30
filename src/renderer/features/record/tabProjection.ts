import type { RecordTab } from '@/features/record/tabContract';
import type { RecordingSnapshot } from '@/../shared/types/record';

export type RecordingTabProjection = Pick<
  RecordTab,
  | 'recordingStatus'
  | 'recordingMediaDurationMs'
  | 'recordingStartedAtWallTime'
  | 'recordingPausedWallMs'
  | 'recordingRevision'
  | 'recordingGeneration'
  | 'recordingSources'
  | 'recordingSourceActivity'
  | 'recordingWarnings'
>;

export function recordingTabProjection(snapshot: RecordingSnapshot): RecordingTabProjection {
  return {
    recordingStatus: snapshot.captureStatus,
    recordingMediaDurationMs: snapshot.mediaDurationMs,
    recordingStartedAtWallTime: snapshot.startedAtWallTime,
    recordingPausedWallMs: snapshot.pausedWallMs,
    recordingRevision: snapshot.revision,
    recordingGeneration: snapshot.generation,
    recordingSources: snapshot.sources,
    recordingSourceActivity: snapshot.sourceActivity,
    recordingWarnings: snapshot.warnings,
  };
}

export function sameRecordingTabProjection(tab: RecordTab, snapshot: RecordingSnapshot): boolean {
  const sameSources =
    (tab.recordingSources?.length ?? 0) === snapshot.sources.length &&
    (tab.recordingSources ?? []).every((source, index) => {
      const next = snapshot.sources[index];
      return (
        source.track === next?.track &&
        source.label === next.label &&
        source.format.channels === next.format.channels &&
        source.format.sampleRate === next.format.sampleRate
      );
    });
  const sameSourceStates =
    (tab.recordingSourceActivity?.length ?? 0) === snapshot.sourceActivity.length &&
    (tab.recordingSourceActivity ?? []).every((source, index) => {
      const next = snapshot.sourceActivity[index];
      return source.track === next?.track && source.enabled === next.enabled;
    });
  const sameWarnings =
    (tab.recordingWarnings?.length ?? 0) === snapshot.warnings.length &&
    (tab.recordingWarnings ?? []).every((warning, index) => warning.code === snapshot.warnings[index]?.code);
  return (
    tab.recordingStatus === snapshot.captureStatus &&
    tab.recordingStartedAtWallTime === snapshot.startedAtWallTime &&
    tab.recordingPausedWallMs === snapshot.pausedWallMs &&
    tab.recordingRevision === snapshot.revision &&
    tab.recordingGeneration === snapshot.generation &&
    sameSources &&
    sameSourceStates &&
    sameWarnings &&
    tab.recordingMediaDurationMs === snapshot.mediaDurationMs
  );
}

export function recordingSnapshotFromTab(tab: RecordTab): RecordingSnapshot | null {
  if (!tab.recordingStatus) return null;
  return {
    recordId: tab.recordId,
    revision: tab.recordingRevision ?? 0,
    generation: tab.recordingGeneration ?? 0,
    captureStatus: tab.recordingStatus,
    startedAtWallTime: tab.recordingStartedAtWallTime ?? 0,
    mediaDurationMs: tab.recordingMediaDurationMs ?? 0,
    pausedWallMs: tab.recordingPausedWallMs ?? 0,
    sources: tab.recordingSources ?? [],
    sourceActivity: tab.recordingSourceActivity ?? [],
    warnings: tab.recordingWarnings ?? [],
  };
}

export function isRecordingSnapshotOlder(current: RecordingSnapshot, next: RecordingSnapshot): boolean {
  return (
    next.generation < current.generation ||
    (next.generation === current.generation && next.revision < current.revision) ||
    (next.generation === current.generation &&
      next.revision === current.revision &&
      next.mediaDurationMs < current.mediaDurationMs)
  );
}
