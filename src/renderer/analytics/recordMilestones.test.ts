import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hashPrivateIdentity: vi.fn(),
  track: vi.fn(),
}));

vi.mock('./hash', () => ({ hashPrivateIdentity: mocks.hashPrivateIdentity }));
vi.mock('./tracker', () => ({ track: mocks.track }));

import { forwardRecordAnalyticsMilestone } from './recordMilestones';
import type { SpeechAttachmentJobParams } from './types';

describe('Record analytics milestone bridge', () => {
  beforeEach(() => {
    mocks.hashPrivateIdentity.mockReset();
    mocks.track.mockReset();
    mocks.hashPrivateIdentity.mockImplementation(
      async (domain: string, identity: string) =>
        `${domain}-hash-${identity.length}`,
    );
  });

  it('domain-separates and removes the raw Record identity', async () => {
    await forwardRecordAnalyticsMilestone({
      event: 'record_use',
      eventSchemaVersion: 1,
      recordId: 'private-record-id',
      recordKind: 'audio',
      operation: 'speaker_merge',
      source: 'desktop',
      surface: 'record_detail',
    });

    expect(mocks.hashPrivateIdentity).toHaveBeenCalledWith(
      'record',
      'private-record-id',
    );
    expect(mocks.track).toHaveBeenCalledWith('record_use', {
      event_schema_version: 1,
      record_hash: 'record-hash-17',
      record_kind: 'audio',
      operation: 'speaker_merge',
      source: 'desktop',
      surface: 'record_detail',
    });
    expect(JSON.stringify(mocks.track.mock.calls)).not.toContain(
      'private-record-id',
    );
  });

  it('uses the speech-job domain and drops a non-allowlisted error string', async () => {
    await forwardRecordAnalyticsMilestone({
      event: 'speech_attachment_job',
      eventSchemaVersion: 1,
      jobId: 'private-job-id',
      operation: 'finish',
      source: 'cli_agent',
      mediaKind: 'mp4',
      outcome: 'failed',
      fileBytesBucket: '10_50mb',
      mediaDurationBucket: '5_15m',
      provider: 'local',
      modelRevision: 'speech-v1',
      durationMs: 123,
      errorCode: '/Users/private/source.mp4 failed',
    });

    expect(mocks.hashPrivateIdentity).toHaveBeenCalledWith(
      'speech-job',
      'private-job-id',
    );
    const params = mocks.track.mock.calls[0]?.[1];
    expect(params).toMatchObject({
      job_hash: 'speech-job-hash-14',
      media_kind: 'mp4',
      error_code: undefined,
    });
    expect(JSON.stringify(mocks.track.mock.calls)).not.toContain(
      'private-job-id',
    );
    expect(JSON.stringify(mocks.track.mock.calls)).not.toContain(
      '/Users/private',
    );
  });

  it('forwards rejected attachment admission without inventing a job identity', async () => {
    const rejectedParams = {
      event_schema_version: 1,
      operation: 'submit',
      source: 'cli_agent',
      media_kind: 'unknown',
      outcome: 'rejected',
      provider: 'local',
      duration_ms: 4,
      error_code: 'SPEECH_QUEUE_FULL',
    } satisfies SpeechAttachmentJobParams;
    await forwardRecordAnalyticsMilestone({
      event: 'speech_attachment_job',
      eventSchemaVersion: 1,
      operation: rejectedParams.operation,
      source: rejectedParams.source,
      mediaKind: rejectedParams.media_kind,
      outcome: rejectedParams.outcome,
      provider: rejectedParams.provider,
      durationMs: rejectedParams.duration_ms,
      errorCode: rejectedParams.error_code,
    });

    expect(mocks.hashPrivateIdentity).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith('speech_attachment_job', {
      event_schema_version: 1,
      job_hash: undefined,
      operation: 'submit',
      source: 'cli_agent',
      media_kind: 'unknown',
      outcome: 'rejected',
      file_bytes_bucket: undefined,
      media_duration_bucket: undefined,
      provider: 'local',
      model_revision: undefined,
      duration_ms: 4,
      error_code: 'SPEECH_QUEUE_FULL',
    });
  });
});
