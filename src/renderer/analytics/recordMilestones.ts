import { hashPrivateIdentity } from './hash';
import { track } from './tracker';

export const RECORD_ANALYTICS_CONTRACT_V1 = {
  eventSchemaVersion: 1,
  events: [
    'record_create',
    'recording_start_result',
    'recording_finish',
    'recording_recovery',
    'speech_processing_finish',
    'record_use',
    'speech_resource_mutation',
    'speech_attachment_job',
  ],
  recordKinds: ['text', 'audio'],
  outcomes: [
    'success',
    'partial',
    'failed',
    'canceled',
    'interrupted',
    'rejected',
  ],
  recoveryOutcomes: ['repaired', 'partial', 'unrecoverable'],
  sources: ['desktop', 'floating_ball', 'cli', 'cli_agent', 'cron', 'im'],
  surfaces: [
    'launcher_input',
    'task_center',
    'floating_ball',
    'record_detail',
    'speech_tool_card',
    'unknown',
  ],
  captureSources: ['none', 'microphone', 'system', 'microphone_system'],
  transcriptionModes: ['unavailable', 'live'],
  resourceStates: ['ready', 'not_installed', 'native_unavailable'],
  systemAudioCapabilities: ['available', 'unavailable', 'not_requested'],
  finishReasons: [
    'user_stop',
    'app_exit',
    'device_open_failed',
    'device_fatal',
    'low_disk',
    'recording_state_commit_failed',
    'recording_journal_commit_failed',
    'pause_resume_failed',
    'pause_resume_state_commit_failed',
    'pause_resume_journal_failed',
  ],
  recordUseOperations: [
    'open',
    'play',
    'export_audio',
    'export_transcript',
    'archive',
    'delete',
    'speaker_rename',
    'speaker_merge',
    'speaker_reassign',
  ],
  processingStages: ['backfill', 'diarization'],
  resourceOperations: ['download', 'update', 'retry', 'remove'],
  attachmentOperations: ['submit', 'finish', 'cancel'],
  mediaKinds: [
    'wav',
    'aiff',
    'mp3',
    'flac',
    'ogg',
    'm4a',
    'mp4',
    'mov',
    'unknown',
  ],
  mediaDurationBuckets: [
    'lt_1m',
    '1_5m',
    '5_15m',
    '15_30m',
    '30_60m',
    '1_2h',
    '2_4h',
    '4_8h',
  ],
  smallCountBuckets: ['0', '1', '2_5', '6_20', 'gt_20'],
  segmentCountBuckets: ['0', '1_20', '21_100', '101_500', 'gt_500'],
  speakerCountBuckets: ['0', '1', '2', '3_4', 'gte_5'],
  mediaBytesBuckets: [
    'lt_10mb',
    '10_50mb',
    '50_200mb',
    '200_500mb',
    '500mb_1gb',
    '1_4gb',
    'gte_4gb',
  ],
  transcriptCoverageBuckets: ['none', 'lt_50', '50_90', '90_99', 'complete'],
  segmentLatencyBuckets: ['lt_500ms', '500_1000ms', '1_2s', '2_5s', 'gte_5s'],
  errorCodes: [
    'RECORDING_DEVICE_CHANGED',
    'RECORDING_DISK_LOW',
    'RECORDING_DISK_UNAVAILABLE',
    'RECORDING_DISPLAY_CHANGED',
    'RECORDING_MICROPHONE_UNAVAILABLE',
    'RECORDING_NO_AVAILABLE_SOURCE',
    'RECORDING_PIPEWIRE_MONITOR_UNAVAILABLE',
    'RECORDING_PIPEWIRE_UNAVAILABLE',
    'RECORDING_RECOVERY_FAILED',
    'RECORDING_SCREEN_PERMISSION_REQUIRED',
    'RECORDING_START_FAILED',
    'RECORDING_SYSTEM_AUDIO_UNAVAILABLE',
    'RECORDING_TRACK_RECOVERY_PARTIAL',
    'SPEECH_ANALYSIS_BOUNDARY_INVALID',
    'SPEECH_ANALYSIS_SOURCE_INVALID',
    'SPEECH_ANALYSIS_SOURCE_UNAVAILABLE',
    'SPEECH_CANCELLED',
    'SPEECH_CORRUPT_MEDIA',
    'SPEECH_DEADLINE_EXCEEDED',
    'SPEECH_DEFAULT_AUDIO_TRACK_MISSING',
    'SPEECH_DIARIZATION_QUEUE_FAILED',
    'SPEECH_ENCRYPTED_MEDIA',
    'SPEECH_INFERENCE_FAILED',
    'SPEECH_INTERRUPTED',
    'SPEECH_JOB_STORE_WRITE_FAILED',
    'SPEECH_MANAGER_SHUTTING_DOWN',
    'SPEECH_MANAGER_UNAVAILABLE',
    'SPEECH_MEDIA_LIMIT_EXCEEDED',
    'SPEECH_MODEL_LOAD_FAILED',
    'SPEECH_MODEL_LOAD_TIMEOUT',
    'SPEECH_MODEL_PACK_REVISION_UNAVAILABLE',
    'SPEECH_MODEL_PACK_UNAVAILABLE',
    'SPEECH_NATIVE_RUNTIME_UNAVAILABLE',
    'SPEECH_NO_AUDIO_TRACK',
    'SPEECH_OUTPUT_COLLISION',
    'SPEECH_OUTPUT_PATH_UNSAFE',
    'SPEECH_PATH_ENCODING_UNSUPPORTED',
    'SPEECH_PIPELINE_REVISION_UNAVAILABLE',
    'SPEECH_PRIVATE_INPUT_UNAVAILABLE',
    'SPEECH_PRIVATE_STORAGE_UNAVAILABLE',
    'SPEECH_PUBLISH_FAILED',
    'SPEECH_QUEUE_FULL',
    'SPEECH_RECORD_AUDIO_UNAVAILABLE',
    'SPEECH_RECORD_UPDATE_FAILED',
    'SPEECH_RESOURCE_ACTIVATION_DURABILITY_UNCONFIRMED',
    'SPEECH_RESOURCE_ACTIVATION_FAILED',
    'SPEECH_RESOURCE_ARCHIVE_INVALID',
    'SPEECH_RESOURCE_BUSY',
    'SPEECH_RESOURCE_CHANGED',
    'SPEECH_RESOURCE_CORRUPT',
    'SPEECH_RESOURCE_DOWNLOAD_INVALID',
    'SPEECH_RESOURCE_INSTALL_INTERRUPTED',
    'SPEECH_RESOURCE_LIMIT',
    'SPEECH_RESOURCE_MANIFEST_INVALID',
    'SPEECH_RESOURCE_NETWORK',
    'SPEECH_RESOURCE_PACK_INVALID',
    'SPEECH_RESOURCE_REMOVE_FAILED',
    'SPEECH_RESOURCE_REQUIRED',
    'SPEECH_RESOURCE_SIGNATURE_INVALID',
    'SPEECH_RESOURCE_SOURCE_LOCK_INVALID',
    'SPEECH_RESOURCE_STORE_WRITE_FAILED',
    'SPEECH_SESSION_REQUIRED',
    'SPEECH_SOURCE_CHANGED',
    'SPEECH_SOURCE_READ_FAILED',
    'SPEECH_SOURCE_UNAVAILABLE',
    'SPEECH_SOURCE_UNSAFE',
    'SPEECH_UNSUPPORTED_CODEC',
    'SPEECH_WORKER_CRASHED',
    'SPEECH_WORKER_DISCONNECTED',
    'SPEECH_WORKER_IO_ERROR',
    'SPEECH_WORKER_PROTOCOL_ERROR',
    'SPEECH_WORKER_START_FAILED',
    'SPEECH_WORKER_TIMEOUT',
    'SPEECH_WORKLOAD_NOT_READY',
    'SPEECH_WORKSPACE_UNSAFE',
  ],
} as const;

type ContractValue<K extends keyof typeof RECORD_ANALYTICS_CONTRACT_V1> =
  (typeof RECORD_ANALYTICS_CONTRACT_V1)[K] extends readonly (infer Value)[]
    ? Value
    : never;
type AnalyticsRecordKind = ContractValue<'recordKinds'>;
type AnalyticsOutcome = ContractValue<'outcomes'>;
type AnalyticsSource = ContractValue<'sources'>;
type AnalyticsSurface = ContractValue<'surfaces'>;
type CaptureSources = ContractValue<'captureSources'>;
type TranscriptionMode = ContractValue<'transcriptionModes'>;
type ResourceState = ContractValue<'resourceStates'>;
type SystemAudioCapability = ContractValue<'systemAudioCapabilities'>;
type RecordingFinishReason = ContractValue<'finishReasons'>;
type RecordUseOperation = ContractValue<'recordUseOperations'>;
type ProcessingStage = ContractValue<'processingStages'>;
type ResourceOperation = ContractValue<'resourceOperations'>;
type AttachmentOperation = ContractValue<'attachmentOperations'>;
type MediaKind = ContractValue<'mediaKinds'>;
type MediaDurationBucket = ContractValue<'mediaDurationBuckets'>;
type SmallCountBucket = ContractValue<'smallCountBuckets'>;
type SegmentCountBucket = ContractValue<'segmentCountBuckets'>;
type SpeakerCountBucket = ContractValue<'speakerCountBuckets'>;
type MediaBytesBucket = ContractValue<'mediaBytesBuckets'>;
type TranscriptCoverageBucket = ContractValue<'transcriptCoverageBuckets'>;
type SegmentLatencyBucket = ContractValue<'segmentLatencyBuckets'>;

const ERROR_CODES_V1 = new Set<string>(RECORD_ANALYTICS_CONTRACT_V1.errorCodes);

interface MilestoneBase {
  eventSchemaVersion: 1;
}

export type RecordAnalyticsMilestone =
  | (MilestoneBase & {
      event: 'record_create';
      recordId: string;
      recordKind: AnalyticsRecordKind;
      source: AnalyticsSource;
      surface: AnalyticsSurface;
    })
  | (MilestoneBase & {
      event: 'recording_start_result';
      recordId?: string;
      ok: boolean;
      captureSources: CaptureSources;
      transcriptionMode: TranscriptionMode;
      resourceState: ResourceState;
      systemAudioCapability: SystemAudioCapability;
      errorCode?: string;
    })
  | (MilestoneBase & {
      event: 'recording_finish';
      recordId: string;
      outcome: AnalyticsOutcome;
      finishReason: RecordingFinishReason;
      mediaDurationBucket: MediaDurationBucket;
      pauseCountBucket: SmallCountBucket;
      noteCountBucket: SmallCountBucket;
      markCountBucket: SmallCountBucket;
      audioBytesBucket: MediaBytesBucket;
      liveTranscriptCoverage: TranscriptCoverageBucket;
      segmentLatencyP50Bucket?: SegmentLatencyBucket;
      segmentLatencyP95Bucket?: SegmentLatencyBucket;
    })
  | (MilestoneBase & {
      event: 'recording_recovery';
      recordId: string;
      outcome: ContractValue<'recoveryOutcomes'>;
      errorCode?: string;
    })
  | (MilestoneBase & {
      event: 'speech_processing_finish';
      recordId: string;
      stage: ProcessingStage;
      outcome: AnalyticsOutcome;
      provider: string;
      modelRevision: string;
      durationMs: number;
      mediaDurationBucket: MediaDurationBucket;
      segmentCountBucket: SegmentCountBucket;
      speakerCountBucket: SpeakerCountBucket;
      errorCode?: string;
    })
  | (MilestoneBase & {
      event: 'record_use';
      recordId: string;
      recordKind: AnalyticsRecordKind;
      operation: RecordUseOperation;
      source: AnalyticsSource;
      surface: AnalyticsSurface;
    })
  | (MilestoneBase & {
      event: 'speech_resource_mutation';
      operation: ResourceOperation;
      outcome: AnalyticsOutcome;
      packRevision: string;
      resourceBytes: number;
      durationMs: number;
      errorCode?: string;
    })
  | (MilestoneBase & {
      event: 'speech_attachment_job';
      jobId?: string;
      operation: AttachmentOperation;
      source: AnalyticsSource;
      mediaKind: MediaKind;
      outcome: AnalyticsOutcome;
      fileBytesBucket?: MediaBytesBucket;
      mediaDurationBucket?: MediaDurationBucket;
      provider?: string;
      modelRevision?: string;
      durationMs: number;
      errorCode?: string;
    });

function normalizedErrorCode(code: string | undefined): string | undefined {
  return code && ERROR_CODES_V1.has(code) ? code : undefined;
}

async function privateHash(
  domain: 'record' | 'speech-job',
  identity: string,
): Promise<string | undefined> {
  return (await hashPrivateIdentity(domain, identity)) ?? undefined;
}

/**
 * Converts a local Rust receipt into the existing analytics transport shape.
 * Every field is copied explicitly so raw Record/job identity and future
 * business payload additions cannot accidentally cross the network boundary.
 */
export async function forwardRecordAnalyticsMilestone(
  milestone: RecordAnalyticsMilestone,
): Promise<void> {
  const event_schema_version = milestone.eventSchemaVersion;
  switch (milestone.event) {
    case 'record_create':
      track('record_create', {
        event_schema_version,
        record_hash: await privateHash('record', milestone.recordId),
        record_kind: milestone.recordKind,
        source: milestone.source,
        surface: milestone.surface,
      });
      return;
    case 'recording_start_result':
      track('recording_start_result', {
        event_schema_version,
        record_hash: milestone.recordId
          ? await privateHash('record', milestone.recordId)
          : undefined,
        ok: milestone.ok,
        capture_sources: milestone.captureSources,
        transcription_mode: milestone.transcriptionMode,
        resource_state: milestone.resourceState,
        system_audio_capability: milestone.systemAudioCapability,
        error_code: normalizedErrorCode(milestone.errorCode),
      });
      return;
    case 'recording_finish':
      track('recording_finish', {
        event_schema_version,
        record_hash: await privateHash('record', milestone.recordId),
        outcome: milestone.outcome,
        finish_reason: milestone.finishReason,
        media_duration_bucket: milestone.mediaDurationBucket,
        pause_count_bucket: milestone.pauseCountBucket,
        note_count_bucket: milestone.noteCountBucket,
        mark_count_bucket: milestone.markCountBucket,
        audio_bytes_bucket: milestone.audioBytesBucket,
        live_transcript_coverage: milestone.liveTranscriptCoverage,
        segment_latency_p50_bucket: milestone.segmentLatencyP50Bucket,
        segment_latency_p95_bucket: milestone.segmentLatencyP95Bucket,
      });
      return;
    case 'recording_recovery':
      track('recording_recovery', {
        event_schema_version,
        record_hash: await privateHash('record', milestone.recordId),
        outcome: milestone.outcome,
        error_code: normalizedErrorCode(milestone.errorCode),
      });
      return;
    case 'speech_processing_finish':
      track('speech_processing_finish', {
        event_schema_version,
        record_hash: await privateHash('record', milestone.recordId),
        stage: milestone.stage,
        outcome: milestone.outcome,
        provider: milestone.provider,
        model_revision: milestone.modelRevision,
        duration_ms: milestone.durationMs,
        media_duration_bucket: milestone.mediaDurationBucket,
        segment_count_bucket: milestone.segmentCountBucket,
        speaker_count_bucket: milestone.speakerCountBucket,
        error_code: normalizedErrorCode(milestone.errorCode),
      });
      return;
    case 'record_use':
      track('record_use', {
        event_schema_version,
        record_hash: await privateHash('record', milestone.recordId),
        record_kind: milestone.recordKind,
        operation: milestone.operation,
        source: milestone.source,
        surface: milestone.surface,
      });
      return;
    case 'speech_resource_mutation':
      track('speech_resource_mutation', {
        event_schema_version,
        operation: milestone.operation,
        outcome: milestone.outcome,
        pack_revision: milestone.packRevision,
        resource_bytes: milestone.resourceBytes,
        duration_ms: milestone.durationMs,
        error_code: normalizedErrorCode(milestone.errorCode),
      });
      return;
    case 'speech_attachment_job':
      track('speech_attachment_job', {
        event_schema_version,
        job_hash: milestone.jobId
          ? await privateHash('speech-job', milestone.jobId)
          : undefined,
        operation: milestone.operation,
        source: milestone.source,
        media_kind: milestone.mediaKind,
        outcome: milestone.outcome,
        file_bytes_bucket: milestone.fileBytesBucket,
        media_duration_bucket: milestone.mediaDurationBucket,
        provider: milestone.provider,
        model_revision: milestone.modelRevision,
        duration_ms: milestone.durationMs,
        error_code: normalizedErrorCode(milestone.errorCode),
      });
  }
}
