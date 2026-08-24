import { invoke } from '@tauri-apps/api/core';

import type {
  AudioRecordMetadataUpdateInput,
  RecordDetail,
  RecordDiarizationProjection,
  RecordAudioExportInput,
  RecordExportResult,
  RecordMarkCreateInput,
  RecordNoteCreateInput,
  RecordNoteUpdateInput,
  RecordSegmentSpeakerReassignInput,
  RecordSpeakerMergeInput,
  RecordSpeakerRenameInput,
  RecordingSnapshot,
  RecordingSourceSelection,
  RecordingStartResult,
  RecordTimelineDeleteInput,
  RecordTimelineProjection,
  RecordTextExportInput,
  RecordTranscriptSnapshot,
  SpeechModelPackStatus,
} from '@/../shared/types/record';
import { isTauriEnvironment } from '@/utils/browserMock';

function requireDesktop(): void {
  if (!isTauriEnvironment()) {
    throw new Error('Recording commands require the MyAgents desktop app');
  }
}

async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  requireDesktop();
  return invoke<T>(name, args);
}

export function recordingSnapshot(): Promise<RecordingSnapshot | null> {
  return command('cmd_recording_snapshot');
}

export function recordingStart(
  selection: RecordingSourceSelection = { microphone: true, system: true },
): Promise<RecordingStartResult> {
  return command('cmd_recording_start', {
    input: { operationId: crypto.randomUUID(), selection },
  });
}

function recordingMutation(
  name: 'cmd_recording_pause' | 'cmd_recording_resume' | 'cmd_recording_stop',
  snapshot: RecordingSnapshot,
): Promise<RecordingSnapshot> {
  return command(name, {
    input: {
      recordId: snapshot.recordId,
      expectedRevision: snapshot.revision,
      operationId: crypto.randomUUID(),
    },
  });
}

export function recordingPause(
  snapshot: RecordingSnapshot,
): Promise<RecordingSnapshot> {
  return recordingMutation('cmd_recording_pause', snapshot);
}

export function recordingResume(
  snapshot: RecordingSnapshot,
): Promise<RecordingSnapshot> {
  return recordingMutation('cmd_recording_resume', snapshot);
}

export function recordingStop(
  snapshot: RecordingSnapshot,
): Promise<RecordingSnapshot> {
  return recordingMutation('cmd_recording_stop', snapshot);
}

export function recordTranscript(
  id: string,
): Promise<RecordTranscriptSnapshot | null> {
  return command('cmd_record_transcript', { id });
}

export function recordDiarization(
  id: string,
): Promise<RecordDiarizationProjection | null> {
  return command('cmd_record_diarization', { id });
}

export function recordRenameSpeaker(
  input: RecordSpeakerRenameInput,
): Promise<RecordDiarizationProjection> {
  return command('cmd_record_rename_speaker', { input });
}

export function recordMergeSpeakers(
  input: RecordSpeakerMergeInput,
): Promise<RecordDiarizationProjection> {
  return command('cmd_record_merge_speakers', { input });
}

export function recordReassignSegmentSpeaker(
  input: RecordSegmentSpeakerReassignInput,
): Promise<RecordDiarizationProjection> {
  return command('cmd_record_reassign_segment_speaker', { input });
}

export function recordTimeline(id: string): Promise<RecordTimelineProjection> {
  return command('cmd_record_timeline', { id });
}

export function recordAddNote(
  input: RecordNoteCreateInput,
): Promise<RecordTimelineProjection> {
  return command('cmd_record_add_note', { input });
}

export function recordAddMark(
  input: RecordMarkCreateInput,
): Promise<RecordTimelineProjection> {
  return command('cmd_record_add_mark', { input });
}

export function recordUpdateNote(
  input: RecordNoteUpdateInput,
): Promise<RecordTimelineProjection> {
  return command('cmd_record_update_note', { input });
}

export function recordDeleteTimelineItem(
  input: RecordTimelineDeleteInput,
): Promise<RecordTimelineProjection> {
  return command('cmd_record_delete_timeline_item', { input });
}

export function recordUpdateAudioMetadata(
  input: AudioRecordMetadataUpdateInput,
): Promise<RecordDetail> {
  return command('cmd_record_update_audio_metadata', { input });
}

export function recordExportAudio(
  input: RecordAudioExportInput,
): Promise<RecordExportResult> {
  return command('cmd_record_export_audio', { input });
}

export function recordExportText(
  input: RecordTextExportInput,
): Promise<RecordExportResult> {
  return command('cmd_record_export_text', { input });
}

export function recordStartTranscription(recordId: string): Promise<void> {
  return command('cmd_speech_record_transcribe', { recordId }).then(
    () => undefined,
  );
}

export function speechModelPackStatus(): Promise<SpeechModelPackStatus> {
  return command('cmd_speech_model_pack_status');
}

export function speechModelPackInstall(): Promise<SpeechModelPackStatus> {
  return command('cmd_speech_model_pack_install');
}

export function speechModelPackRemove(): Promise<SpeechModelPackStatus> {
  return command('cmd_speech_model_pack_remove');
}

export function recordMediaUrl(
  recordId: string,
  track: 'microphone' | 'system' | 'mixed',
): string {
  const path = `record-media/${encodeURIComponent(recordId)}/${track}.opus`;
  return navigator.platform.toLowerCase().includes('win')
    ? `http://myagents-resource.localhost/${path}`
    : `myagents-resource://${path}`;
}
