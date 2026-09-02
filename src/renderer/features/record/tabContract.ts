import type { TabBase } from '@/tab-workspace/contracts';
import type {
  CaptureStatus,
  PreparedRecordingSource,
  RecordingSourceActivity,
  RecordingWarning,
} from '@/../shared/types/record';

export interface RecordTab extends TabBase<'record'> {
  recordId: string;
  recordingStatus?: CaptureStatus;
  recordingMediaDurationMs?: number;
  recordingStartedAtWallTime?: number;
  recordingPausedWallMs?: number;
  recordingRevision?: number;
  recordingGeneration?: number;
  recordingSources?: PreparedRecordingSource[];
  recordingSourceActivity?: RecordingSourceActivity[];
  recordingWarnings?: RecordingWarning[];
  recordSeekMediaMs?: number;
  recordSeekNonce?: number;
}
