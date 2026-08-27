import { describe, expect, it } from 'vitest';

import type {
  RecordTranscriptDelta,
  RecordTranscriptSnapshot,
} from '@/../shared/types/record';
import {
  applyRecordTranscriptDelta,
  reconcileRecordTranscriptSnapshot,
} from './recordTranscript';

const BASE: RecordTranscriptSnapshot = {
  schemaVersion: 1,
  recordId: 'record-1',
  projectionRevision: 2,
  state: 'live',
  sampleRate: 16_000,
  provenance: {
    provider: 'local',
    modelPackRevision: 'v1',
    onnxRuntimeVersion: '1.28',
  },
  segments: [
    {
      segmentId: 'later',
      track: 'microphone',
      startSample: 32_000,
      endSample: 48_000,
      text: 'later',
      revision: 1,
    },
  ],
};

function delta(
  overrides: Partial<RecordTranscriptDelta>,
): RecordTranscriptDelta {
  return {
    recordId: 'record-1',
    projectionRevision: 3,
    state: 'live',
    upserts: [],
    cursor: { journalBytes: 100, projectionRevision: 3 },
    ...overrides,
  };
}

describe('applyRecordTranscriptDelta', () => {
  it('merges newer upserts and keeps timeline order', () => {
    const result = applyRecordTranscriptDelta(
      BASE,
      delta({
        upserts: [
          {
            segmentId: 'earlier',
            track: 'microphone',
            startSample: 1_000,
            endSample: 2_000,
            text: 'earlier',
            revision: 1,
          },
        ],
      }),
    );
    expect(result?.segments.map((segment) => segment.segmentId)).toEqual([
      'earlier',
      'later',
    ]);
    expect(result?.projectionRevision).toBe(3);
  });

  it('ignores stale deltas and accepts authoritative resets', () => {
    expect(
      applyRecordTranscriptDelta(
        BASE,
        delta({ projectionRevision: 1, state: 'recovering' }),
      ),
    ).toBe(BASE);
    const reset = { ...BASE, projectionRevision: 8, segments: [] };
    expect(
      applyRecordTranscriptDelta(
        BASE,
        delta({ projectionRevision: 8, resetSnapshot: reset }),
      ),
    ).toBe(reset);
  });

  it('reuses the segment projection for state-only deltas', () => {
    const result = applyRecordTranscriptDelta(
      BASE,
      delta({ state: 'finalizing', upserts: [] }),
    );

    expect(result?.segments).toBe(BASE.segments);
    expect(result?.state).toBe('finalizing');
  });

  it('adopts the finalized projection across the live revision boundary', () => {
    const live = { ...BASE, projectionRevision: 42, state: 'live' as const };
    const finalized = {
      ...BASE,
      projectionRevision: 1,
      state: 'recording_final' as const,
      segments: [{ ...BASE.segments[0], text: 'final text' }],
    };

    expect(reconcileRecordTranscriptSnapshot(live, finalized)).toBe(finalized);
    expect(reconcileRecordTranscriptSnapshot(finalized, live)).toBe(finalized);
  });
});
