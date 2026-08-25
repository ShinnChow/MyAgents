export type RecordKind = 'text' | 'audio';

export type CaptureStatus =
  | 'none'
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'finalizing'
  | 'ready'
  | 'interrupted'
  | 'failed';

export type TranscriptionStatus =
  | 'not_applicable'
  | 'unavailable'
  | 'not_started'
  | 'queued'
  | 'live'
  | 'lagging'
  | 'recovering'
  | 'finalizing'
  | 'ready'
  | 'failed';

export type DiarizationStatus =
  | 'not_applicable'
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed';

export interface AudioRecordSummary {
  mediaDurationMs: number;
  captureStatus: CaptureStatus;
  transcriptionStatus: TranscriptionStatus;
  diarizationStatus: DiarizationStatus;
  tracks: Array<'microphone' | 'system' | 'mixed'>;
  sizeBytes: number;
}

export interface RecordArtifact {
  kind: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface RecordSummary {
  id: string;
  kind: RecordKind;
  title: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  convertedTaskIds: string[];
  revision: number;
  audio?: AudioRecordSummary;
}

export interface RecordDetail extends RecordSummary {
  content?: string;
  images?: string[];
  artifacts?: RecordArtifact[];
}

export interface CaptureFormat {
  sampleRate: number;
  channels: number;
}

export interface PreparedRecordingSource {
  track: 'microphone' | 'system' | 'mixed';
  label: string;
  format: CaptureFormat;
}

export interface RecordingWarning {
  code: string;
}

export interface RecordingSourceActivity {
  track: 'microphone' | 'system' | 'mixed';
  levelPercent: number;
}

export interface RecordingSnapshot {
  recordId: string;
  revision: number;
  generation: number;
  captureStatus: CaptureStatus;
  startedAtWallTime: number;
  mediaDurationMs: number;
  pausedWallMs: number;
  sources: PreparedRecordingSource[];
  sourceActivity: RecordingSourceActivity[];
  warnings: RecordingWarning[];
}

export interface RecordingStartResult {
  snapshot: RecordingSnapshot;
  attachedToExisting: boolean;
}

export interface RecordingSourceSelection {
  microphone: boolean;
  system: boolean;
}

export interface RecordingChange {
  sequence: number;
  recordId: string;
  revision: number;
  captureStatus: CaptureStatus;
  snapshot?: RecordingSnapshot;
}

export interface RecordChange {
  sequence: number;
  id: string;
  kind: 'upsert' | 'delete';
}

export interface RecordSpeechProvenance {
  provider: string;
  modelPackRevision: string;
  onnxRuntimeVersion: string;
}

export interface RecordTranscriptSegment {
  segmentId: string;
  track: 'microphone' | 'system' | 'mixed';
  startSample: number;
  endSample: number;
  text: string;
  language?: string;
  revision: number;
}

export interface RecordTranscriptSnapshot {
  schemaVersion: number;
  recordId: string;
  projectionRevision: number;
  state: string;
  sampleRate: number;
  provenance: RecordSpeechProvenance;
  segments: RecordTranscriptSegment[];
}

export interface RecordSpeakerTurn {
  startSample: number;
  endSample: number;
  globalSpeaker: number;
}

export interface RecordDiarizationResult {
  schemaVersion: number;
  recordId: string;
  projectionRevision: number;
  sampleRate: number;
  provenance: RecordSpeechProvenance;
  turns: RecordSpeakerTurn[];
}

export interface RecordSpeakerProjection {
  speakerId: number;
  customName?: string;
  mergedInto?: number;
}

export interface RecordSpeakerOverrideConflict {
  kind: 'rename' | 'merge' | 'reassign';
  targetId: string;
}

export interface RecordDiarizationProjection extends RecordDiarizationResult {
  overrideRevision: number;
  speakers: RecordSpeakerProjection[];
  segmentSpeakerOverrides: Record<string, number>;
  conflicts: RecordSpeakerOverrideConflict[];
}

export interface RecordSpeakerRenameInput {
  recordId: string;
  expectedOverrideRevision: number;
  speakerId: number;
  name: string;
  updatedAtWallTime: number;
}

export interface RecordSpeakerMergeInput {
  recordId: string;
  expectedOverrideRevision: number;
  sourceSpeakerId: number;
  targetSpeakerId: number;
  updatedAtWallTime: number;
}

export interface RecordSegmentSpeakerReassignInput {
  recordId: string;
  expectedOverrideRevision: number;
  segmentId: string;
  speakerId: number;
  updatedAtWallTime: number;
}

export type RecordTimelineItem =
  | {
      type: 'note';
      seq: number;
      noteId: string;
      anchorMediaMs: number;
      startedAtWallTime: number;
      submittedAtWallTime: number;
      text: string;
    }
  | {
      type: 'mark';
      seq: number;
      markId: string;
      mediaMs: number;
      wallTime: number;
      kind: 'highlight';
    };

export interface RecordTimelineProjection {
  recordId: string;
  revision: number;
  items: RecordTimelineItem[];
}

export interface RecordNoteCreateInput {
  recordId: string;
  operationId: string;
  anchorMediaMs: number;
  startedAtWallTime: number;
  submittedAtWallTime: number;
  text: string;
}

export interface RecordMarkCreateInput {
  recordId: string;
  operationId: string;
  mediaMs: number;
  wallTime: number;
}

export interface RecordNoteUpdateInput {
  recordId: string;
  operationId: string;
  noteId: string;
  updatedAtWallTime: number;
  text: string;
}

export interface RecordTimelineDeleteInput {
  recordId: string;
  operationId: string;
  itemId: string;
  itemType: 'note' | 'mark';
  deletedAtWallTime: number;
}

export interface AudioRecordMetadataUpdateInput {
  id: string;
  expectedRevision: number;
  title: string;
  tags: string[];
}

export interface RecordAudioExportInput {
  recordId: string;
  track: 'microphone' | 'system' | 'mixed';
  destinationPath: string;
}

export interface RecordTextExportInput {
  recordId: string;
  format: 'markdown' | 'text';
  destinationPath: string;
  locale: 'zh-CN' | 'en-US';
}

export interface RecordExportResult {
  destinationPath: string;
  bytes: number;
}

export type SpeechModelPackStatusKind =
  | 'not_installed'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'removing'
  | 'ready'
  | 'update_available'
  | 'error';

export interface SpeechModelPackStatus {
  status: SpeechModelPackStatusKind;
  usable: boolean;
  activeRevision?: string;
  availableRevision: string;
  downloadedBytes: number;
  totalDownloadBytes: number;
  installedModelBytes: number;
  lastErrorCode?: string;
}

export type RecordArchiveFilter = 'active' | 'archived' | 'all';

export interface RecordListFilter {
  kind?: RecordKind;
  tag?: string;
  query?: string;
  limit?: number;
  archived?: RecordArchiveFilter;
}

export interface TextRecordCreateInput {
  content: string;
  images?: string[];
}

export interface TextRecordUpdateInput {
  id: string;
  content?: string;
  images?: string[];
  convertedTaskIds?: string[];
}

export interface RecordDeleteFailure {
  id: string;
  error: string;
}

export interface RecordMergeResult {
  merged: RecordDetail;
  failedSourceDeletes: RecordDeleteFailure[];
}
