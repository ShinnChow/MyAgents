import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RECORD_ANALYTICS_CONTRACT_V1 } from './recordMilestones';

const RUST_SOURCE = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/record_analytics.rs'),
  'utf-8',
);

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function rustEnumValues(name: string): string[] {
  const body = RUST_SOURCE.match(
    new RegExp(`pub enum ${name} \\{([\\s\\S]*?)^\\}`, 'm'),
  )?.[1];
  if (!body) throw new Error(`Rust enum ${name} not found`);

  const values: string[] = [];
  let explicitName: string | undefined;
  for (const line of body.split('\n')) {
    const rename = line.match(/#\[serde\(rename = "([^"]+)"\)\]/)?.[1];
    if (rename) {
      explicitName = rename;
      continue;
    }
    const variant = line.match(/^ {4}([A-Z][A-Za-z0-9]+)(?:,| \{)/)?.[1];
    if (!variant) continue;
    values.push(explicitName ?? toSnakeCase(variant));
    explicitName = undefined;
  }
  return values;
}

function rustStringArray(name: string): string[] {
  const body = RUST_SOURCE.match(
    new RegExp(`pub const ${name}: &\\[&str\\] =\\s*&\\[([\\s\\S]*?)\\];`),
  )?.[1];
  if (!body) throw new Error(`Rust string array ${name} not found`);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe('Record analytics Rust/TypeScript contract', () => {
  it('keeps event and dimension enums in exact parity', () => {
    const enumMapping = {
      events: 'RecordAnalyticsMilestone',
      recordKinds: 'AnalyticsRecordKind',
      outcomes: 'AnalyticsOutcome',
      recoveryOutcomes: 'RecordingRecoveryOutcome',
      surfaces: 'AnalyticsSurface',
      captureSources: 'CaptureSources',
      transcriptionModes: 'TranscriptionMode',
      resourceStates: 'SpeechResourceState',
      systemAudioCapabilities: 'SystemAudioCapability',
      finishReasons: 'RecordingFinishReason',
      processingStages: 'SpeechProcessingStage',
      resourceOperations: 'SpeechResourceOperation',
      attachmentOperations: 'SpeechAttachmentOperation',
      mediaKinds: 'AnalyticsMediaKind',
      mediaDurationBuckets: 'MediaDurationBucket',
      smallCountBuckets: 'SmallCountBucket',
      segmentCountBuckets: 'SegmentCountBucket',
      speakerCountBuckets: 'SpeakerCountBucket',
      mediaBytesBuckets: 'MediaBytesBucket',
      transcriptCoverageBuckets: 'TranscriptCoverageBucket',
      segmentLatencyBuckets: 'SegmentLatencyBucket',
    } as const;

    for (const [typescriptKey, rustEnum] of Object.entries(enumMapping)) {
      expect(
        rustEnumValues(rustEnum),
        `${typescriptKey} differs from ${rustEnum}`,
      ).toEqual(
        RECORD_ANALYTICS_CONTRACT_V1[typescriptKey as keyof typeof enumMapping],
      );
    }
    expect(rustStringArray('ANALYTICS_SOURCES_V1')).toEqual(
      RECORD_ANALYTICS_CONTRACT_V1.sources,
    );
    expect(rustStringArray('RECORD_USE_OPERATIONS_V1')).toEqual(
      RECORD_ANALYTICS_CONTRACT_V1.recordUseOperations,
    );
  });

  it('keeps schema version and normalized error allowlist in parity', () => {
    const milestoneBody = RUST_SOURCE.match(
      /pub enum RecordAnalyticsMilestone \{([\s\S]*?)^\}/m,
    )?.[1];
    expect(milestoneBody?.match(/event_schema_version: u8,/g)).toHaveLength(
      RECORD_ANALYTICS_CONTRACT_V1.events.length,
    );
    expect(RECORD_ANALYTICS_CONTRACT_V1.eventSchemaVersion).toBe(1);
    expect(rustStringArray('ANALYTICS_ERROR_CODES_V1')).toEqual(
      RECORD_ANALYTICS_CONTRACT_V1.errorCodes,
    );
  });
});
