import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertExpectedMediaWorkerBatch,
  runMediaWorkerBatch,
  summarizeMediaWorkerBatch,
} from "./media-worker-batch-client.mjs";
import {
  assertExpectedMediaWorkerLive,
  runMediaWorkerLive,
} from "./media-worker-live-client.mjs";
import {
  assertRedactedLongReport,
  buildLongRunEvidence,
  createProcessRssSampler,
  validateLongCorpusManifest,
} from "./speech-long-benchmark.mjs";
import {
  spawnSpeechQualityProcess,
  terminateSpeechQualityProcessTree,
  waitForSpeechQualityProcess,
} from "./speech-quality-process-tree.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const sourceLock = JSON.parse(
  readFileSync(
    join(repoRoot, "scripts/speech-quality-corpus-source-lock.json"),
    "utf8",
  ),
);
const longSourceLock = JSON.parse(
  readFileSync(
    join(repoRoot, "scripts/speech-long-corpus-source-lock.json"),
    "utf8",
  ),
);
const preparationLock = readFileSync(
  join(repoRoot, "scripts/speech-quality-corpus-prepare.py.lock"),
  "utf8",
);
const metricsLock = readFileSync(
  join(repoRoot, "scripts/speech-quality-metrics.py.lock"),
  "utf8",
);

function identity() {
  return { workloadId: "quality_fixture", workerGeneration: 1 };
}

function response(type, fields = {}) {
  return { type, protocolVersion: 1, identity: identity(), ...fields };
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return predicate();
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("speech quality source lock pins licensed, bounded corpus bytes", () => {
  assert.equal(sourceLock.schemaVersion, 1);
  assert.equal(sourceLock.corpusVersion, "myagents-speech-quality-v1");
  assert.match(sourceLock.preparedManifestSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(sourceLock.tools, {
    python: "3.12",
    pyarrow: "21.0.0",
    praatio: "6.2.0",
    jiwer: "4.0.0",
    meeteval: "0.4.3",
    wetext: "0.1.6",
    ffmpeg: "8.0.1",
  });
  assert.deepEqual(Object.keys(sourceLock.sources).sort(), [
    "aishell1Audio",
    "aishell1Transcript",
    "aishell4Audio",
    "aishell4Rttm",
    "aishell4TextGrid",
    "amiAnnotations",
    "amiAudio",
    "ascendTest",
  ]);
  let totalBytes = 0;
  const licenses = new Set();
  for (const source of Object.values(sourceLock.sources)) {
    assert.match(source.url, /^https:\/\//);
    assert.doesNotMatch(source.url, /\/resolve\/(?:main|master)\//);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(source.size) && source.size > 0);
    assert.match(source.licenseUrl, /^https:\/\//);
    assert.ok(source.upstreamRevision.length > 0);
    licenses.add(source.license);
    totalBytes += source.size;
  }
  assert.ok(totalBytes < 768 * 1024 * 1024);
  assert.deepEqual([...licenses].sort(), [
    "Apache-2.0",
    "CC-BY-4.0",
    "CC-BY-SA-4.0",
  ]);
  assert.equal(new Set(sourceLock.selections.aishell1Utterances).size, 16);
  assert.equal(new Set(sourceLock.selections.ascendUtterances).size, 8);
  assert.equal(sourceLock.selections.amiLiveLatencyWindows.length, 3);
  assert.deepEqual(sourceLock.liveLatencyBenchmark, {
    sampleRate: 16_000,
    frameSamples: 320,
    warmRepeats: 5,
    trailingSilenceSeconds: 3,
    vadParameters: {
      threshold: 0.25,
      minSilenceSeconds: 0.5,
      minSpeechSeconds: 0.25,
      maxSpeechSeconds: 30,
      windowSamples: 512,
    },
  });
});

test("speech long source lock pins the 30 second, 2 hour, and 8 hour corpus", () => {
  assert.equal(longSourceLock.schemaVersion, 1);
  assert.equal(longSourceLock.corpusVersion, "myagents-speech-long-v1");
  assert.match(longSourceLock.preparedManifestSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(longSourceLock.preparedManifestSha256, "0".repeat(64));
  assert.equal(longSourceLock.tools.ffmpeg, "8.0.1");
  assert.equal(longSourceLock.source.license, "CC-BY-4.0");
  assert.equal(longSourceLock.source.speakerCount, 4);
  assert.deepEqual(
    longSourceLock.cases.map((entry) => entry.durationSeconds),
    [30, 2 * 60 * 60, 8 * 60 * 60],
  );

  const manifest = {
    schemaVersion: 1,
    corpusVersion: longSourceLock.corpusVersion,
    source: {
      caseId: longSourceLock.source.caseId,
      sourceSha256: longSourceLock.source.sourceSha256,
      license: longSourceLock.source.license,
      upstreamRevision: longSourceLock.source.upstreamRevision,
    },
    cases: longSourceLock.cases.map((entry) => ({
      ...entry,
      sourcePath: `audio/${entry.id}.ogg`,
      sourceBytes: 1,
      sourceSha256: "1".repeat(64),
      expectedSamples16k: entry.durationSeconds * 16_000,
    })),
  };
  assert.doesNotThrow(() =>
    validateLongCorpusManifest(manifest, longSourceLock),
  );
  manifest.cases[2].expectedSamples16k -= 1;
  assert.throws(
    () => validateLongCorpusManifest(manifest, longSourceLock),
    /case is invalid/,
  );
});

test("speech long RSS sampler attributes validated Worker stages", async () => {
  let nextRssBytes = 100 * 1024 * 1024;
  const sampler = createProcessRssSampler({
    intervalMs: 10_000,
    readRss: async () => {
      nextRssBytes += 1024;
      return nextRssBytes;
    },
  });
  sampler.start(42);
  sampler.observeResponse(response("ready"));
  sampler.observeResponse(
    response("heartbeat", {
      stage: "decoding",
      checkpoint: { streams: [], analysisSample: 0 },
    }),
  );
  const evidence = await sampler.stop();
  assert.equal(evidence.sampleCount, 3);
  assert.deepEqual(evidence.seenStages, ["decoding", "ready", "spawned"]);
  assert.ok(evidence.stagePeakRssBytes.decoding > 0);
  assert.ok(evidence.peakRssBytes >= evidence.stagePeakRssBytes.decoding);
});

test("speech long evidence validates multi-batch timelines without content", () => {
  const result = {
    exitCode: 0,
    signal: null,
    stderrBytes: 0,
    responses: [
      response("ready"),
      response("pong", { nonce: 42 }),
      response("speaker_turn_batch", {
        revision: 1,
        batchIndex: 0,
        isLast: false,
        turns: [{ startSample: 0, endSample: 20_000, globalSpeaker: 0 }],
      }),
      response("speaker_turn_batch", {
        revision: 1,
        batchIndex: 1,
        isLast: true,
        turns: [{ startSample: 16_000, endSample: 32_000, globalSpeaker: 1 }],
      }),
      response("completed", {
        metrics: {
          sourceSamples: 32_000,
          segments: 2,
          speakers: 2,
          elapsedMs: 10,
          peakWorkingBytes: null,
        },
      }),
    ],
  };
  const evidence = buildLongRunEvidence(
    "diarization",
    result,
    { expectedSamples16k: 32_000, expectedSpeakerCount: 2 },
    {
      sampleIntervalMs: 500,
      sampleCount: 10,
      missedSampleCount: 0,
      peakRssBytes: 256 * 1024 * 1024,
      stagePeakRssBytes: {},
      seenStages: [
        "decoding",
        "segmenting_speakers",
        "embedding_speakers",
        "clustering_speakers",
        "reconciling_speakers",
      ],
    },
    20,
  );
  assert.equal(evidence.timeline.itemCount, 2);
  assert.equal(JSON.stringify(evidence).includes("text"), false);
  assert.doesNotThrow(() => assertRedactedLongReport(evidence));
  assert.throws(
    () => assertRedactedLongReport({ text: "must not persist" }),
    /contains text/,
  );

  result.responses.splice(
    -1,
    0,
    response("completed", {
      metrics: result.responses.at(-1).metrics,
    }),
  );
  assert.throws(
    () =>
      buildLongRunEvidence(
        "diarization",
        result,
        { expectedSamples16k: 32_000, expectedSpeakerCount: 2 },
        {
          sampleIntervalMs: 500,
          sampleCount: 10,
          missedSampleCount: 0,
          peakRssBytes: 256 * 1024 * 1024,
          stagePeakRssBytes: {},
          seenStages: [
            "decoding",
            "segmenting_speakers",
            "embedding_speakers",
            "clustering_speakers",
            "reconciling_speakers",
          ],
        },
        20,
      ),
    /expected terminal state/,
  );
  result.responses.splice(-2, 1);
  result.responses[2].turns[0].globalSpeaker = 1;
  result.responses[3].turns[0].globalSpeaker = 3;
  assert.throws(
    () =>
      buildLongRunEvidence(
        "diarization",
        result,
        { expectedSamples16k: 32_000, expectedSpeakerCount: 2 },
        {
          sampleIntervalMs: 500,
          sampleCount: 10,
          missedSampleCount: 0,
          peakRssBytes: 256 * 1024 * 1024,
          stagePeakRssBytes: {},
          seenStages: [
            "decoding",
            "segmenting_speakers",
            "embedding_speakers",
            "clustering_speakers",
            "reconciling_speakers",
          ],
        },
        20,
      ),
    /non-compact speaker labels/,
  );
});

test("live latency lock matches the production VAD configuration", () => {
  const rustSource = readFileSync(
    join(repoRoot, "src-tauri/media-worker/src/native_adapter.rs"),
    "utf8",
  );
  const nativeSource = readFileSync(
    join(repoRoot, "src-tauri/media-worker/native/myagents_speech_adapter.cc"),
    "utf8",
  );
  const vad = sourceLock.liveLatencyBenchmark.vadParameters;
  assert.ok(rustSource.includes(`threshold: ${vad.threshold},`));
  assert.ok(
    rustSource.includes(`min_silence_seconds: ${vad.minSilenceSeconds},`),
  );
  assert.ok(
    rustSource.includes(`min_speech_seconds: ${vad.minSpeechSeconds},`),
  );
  assert.ok(
    rustSource.includes(`max_speech_seconds: ${vad.maxSpeechSeconds}.0,`),
  );
  assert.ok(
    nativeSource.includes(
      `constexpr uint32_t kVadWindowSamples = ${vad.windowSamples};`,
    ),
  );
});

test("speech quality Python locks pin direct and transitive artifacts", () => {
  for (const [lock, directPackages] of [
    [preparationLock, ["praatio", "pyarrow"]],
    [metricsLock, ["jiwer", "meeteval", "wetext"]],
  ]) {
    assert.match(lock, /^version = 1$/m);
    assert.match(lock, /^requires-python = "==3\.12\.\*"$/m);
    assert.match(lock, /hash = "sha256:[0-9a-f]{64}"/);
    for (const packageName of directPackages) {
      assert.match(lock, new RegExp(`name = "${packageName}"`));
      assert.match(
        lock,
        new RegExp(
          `name = "${packageName}", specifier = "==${sourceLock.tools[packageName]}"`,
        ),
      );
    }
  }
});

test("shared batch client preserves attachment smoke evidence", () => {
  const result = {
    exitCode: 0,
    signal: null,
    stderrBytes: 0,
    responses: [
      response("ready"),
      response("media_probed", {
        mediaKind: "wave",
        codec: "pcm_s16le",
        durationMs: 2_000,
        usedDefaultTrack: false,
      }),
      response("pong", { nonce: 42 }),
      response("transcript_segment", {
        startSample: 0,
        endSample: 16_000,
        revision: 1,
        text: "redacted fixture",
        language: "en",
      }),
      response("completed", {
        metrics: {
          sourceSamples: 32_000,
          segments: 1,
          speakers: 0,
          elapsedMs: 10,
          peakWorkingBytes: null,
        },
      }),
    ],
  };
  const summary = assertExpectedMediaWorkerBatch("attachment", result);
  assert.equal(summary.transcriptBytes, 16);
  assert.equal(summary.media.durationMs, 2_000);
  assert.equal(summary.counts.completed, 1);
});

test("shared batch client summarizes diarization without transcript content", () => {
  const result = {
    exitCode: 0,
    signal: null,
    stderrBytes: 0,
    responses: [
      response("ready"),
      response("pong", { nonce: 42 }),
      response("speaker_turn_batch", {
        batchIndex: 0,
        isLast: false,
        turns: [{ startSample: 0, endSample: 16_000, globalSpeaker: 0 }],
      }),
      response("speaker_turn_batch", {
        batchIndex: 1,
        isLast: true,
        turns: [{ startSample: 16_000, endSample: 32_000, globalSpeaker: 1 }],
      }),
      response("completed", {
        metrics: {
          sourceSamples: 32_000,
          segments: 2,
          speakers: 2,
          elapsedMs: 10,
          peakWorkingBytes: null,
        },
      }),
    ],
  };
  const summary = assertExpectedMediaWorkerBatch("diarization", result);
  assert.equal(summary.speakerTurnCount, 2);
  assert.equal(summary.transcriptBytes, 0);
  assert.equal(
    JSON.stringify(summarizeMediaWorkerBatch("diarization", result)).includes(
      "redacted fixture",
    ),
    false,
  );
});

test("shared batch client rejects a broken diarization batch sequence", () => {
  assert.throws(
    () =>
      assertExpectedMediaWorkerBatch("diarization", {
        exitCode: 0,
        signal: null,
        stderrBytes: 0,
        responses: [
          response("ready"),
          response("pong", { nonce: 42 }),
          response("speaker_turn_batch", {
            batchIndex: 1,
            isLast: true,
            turns: [{ startSample: 0, endSample: 16_000, globalSpeaker: 0 }],
          }),
          response("completed", {
            metrics: {
              sourceSamples: 16_000,
              segments: 1,
              speakers: 1,
              elapsedMs: 10,
              peakWorkingBytes: null,
            },
          }),
        ],
      }),
    /did not reach the expected terminal state/,
  );
});

test("shared batch client rejects a false successful terminal", () => {
  assert.throws(
    () =>
      assertExpectedMediaWorkerBatch("attachment", {
        exitCode: 0,
        signal: null,
        stderrBytes: 0,
        responses: [
          response("ready"),
          response("failed", {
            code: "SPEECH_INFERENCE_FAILED",
          }),
        ],
      }),
    /did not reach the expected terminal state/,
  );
});

test(
  "shared live client measures the triggering ACK before stable final",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-live-client-"));
    const worker = join(root, "fixture-worker.mjs");
    writeFileSync(
      worker,
      `#!/usr/bin/env node
let buffered = Buffer.alloc(0);
let identity;
let sourceSamples = 0;
let emitted = false;
function send(value) {
  const json = Buffer.from(JSON.stringify(value));
  const payload = Buffer.concat([Buffer.from([1]), json]);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([prefix, payload]));
}
process.stdin.on("data", chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < 4 + length) break;
    const payload = buffered.subarray(4, 4 + length);
    buffered = buffered.subarray(4 + length);
    if (payload[0] === 1) {
      const command = JSON.parse(payload.subarray(1));
      identity = command.identity;
      if (command.type === "start") {
        setTimeout(() => send({type:"ready", protocolVersion:1, identity}), 100);
      } else if (command.type === "finalize") {
        send({type:"completed", protocolVersion:1, identity, metrics:{sourceSamples,segments:1,speakers:0,elapsedMs:1,peakWorkingBytes:null}});
      }
      continue;
    }
    const sequence = Number(payload.readBigUInt64BE(14));
    const startSample = Number(payload.readBigUInt64BE(22));
    const sampleCount = payload.readUInt32BE(30);
    const endSample = startSample + sampleCount;
    sourceSamples += sampleCount;
    send({type:"input_ack", protocolVersion:1, identity, track:"microphone", sequence, endSample});
    if (!emitted && endSample >= 320) {
      emitted = true;
      const segmentEndSample = identity.workloadId.endsWith("_invalid") ? 300 : 320;
      send({type:"transcript_segment", protocolVersion:1, identity, segmentId:"segment-1", track:"microphone", startSample:0, endSample:segmentEndSample, text:"fixture transcript", language:"en", revision:1});
    }
    send({type:"heartbeat", protocolVersion:1, identity, stage:"vad", checkpoint:{streams:[{track:"microphone",lastAckSequence:sequence,analysisSample:endSample}],analysisSample:endSample}});
  }
});
process.stdin.on("end", () => process.exit(0));
`,
    );
    chmodSync(worker, 0o700);
    const options = {
      workerPath: worker,
      nativeManifestPath: "fixture-native",
      onnxRuntimePath: "fixture-ort",
      modelManifestPath: "fixture-model",
      samples: new Int16Array(640),
      measurementWindows: [
        {
          id: "fixture-r1",
          startSample: 0,
          endSample: 640,
          lastValidSpeechSample: 320,
        },
      ],
      frameSamples: 320,
      realtime: true,
      timeoutMs: 2_000,
    };
    await assert.rejects(
      runMediaWorkerLive({
        ...options,
        workloadId: "quality_fixture_invalid",
      }),
      /did not produce one stable segment/,
    );
    const result = await runMediaWorkerLive({
      ...options,
      workloadId: "quality_fixture",
    });
    const summary = assertExpectedMediaWorkerLive(result, 1);
    assert.equal(summary.measurements.length, 1);
    assert.equal(summary.measurements[0].cold, true);
    assert.ok(summary.workerReadyMs >= 75);
    assert.ok(summary.measurements[0].lastSpeechToVadMs >= 50);
    assert.ok(summary.measurements[0].vadToSegmentFinalMs >= 0);
    assert.equal(JSON.stringify(summary).includes("fixture transcript"), false);
    rmSync(root, { recursive: true, force: true });
  },
);

test(
  "shared live client bounds a SIGTERM-resistant Worker",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-live-timeout-"));
    const worker = join(root, "stubborn-worker.mjs");
    writeFileSync(
      worker,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n",
    );
    chmodSync(worker, 0o700);
    const startedAt = performance.now();
    await assert.rejects(
      runMediaWorkerLive({
        workerPath: worker,
        nativeManifestPath: "fixture-native",
        onnxRuntimePath: "fixture-ort",
        modelManifestPath: "fixture-model",
        samples: new Int16Array(320),
        timeoutMs: 100,
        terminationGraceMs: 100,
      }),
      /timed out after 100 ms/,
    );
    assert.ok(performance.now() - startedAt < 2_000);
    rmSync(root, { recursive: true, force: true });
  },
);

test("quality runner rejects a prepared manifest that self-attests easier cases", () => {
  const root = mkdtempSync(join(tmpdir(), "myagents-quality-lock-drift-"));
  const manifest = join(root, "prepared-corpus.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      corpusVersion: sourceLock.corpusVersion,
      cases: [
        {
          id: "fixture",
          kind: "asr",
          group: "mandarin-near",
          language: "zh",
          metric: "cer",
          sourcePath: "fixture.wav",
          sourceBytes: 1,
          sourceSha256: "1".repeat(64),
          timeoutMs: 1_000,
          reference: "fixture",
        },
      ],
      liveLatencyCases: [
        {
          id: "fixture-live",
          sourcePath: "fixture-live.wav",
          sourceBytes: 1,
          sourceSha256: "2".repeat(64),
          sampleRate: 16_000,
          lastValidSpeechSample: 16_000,
          totalSamples: 32_000,
        },
      ],
    }),
  );
  const outcome = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts/speech-quality-benchmark.mjs"),
      "missing-worker",
      "missing-native-manifest",
      "missing-onnx-runtime",
      "missing-model-manifest",
      manifest,
      join(root, "report.json"),
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /does not match the current source lock/);
  rmSync(root, { recursive: true, force: true });
});

test(
  "shared batch client escalates and bounds a SIGTERM-resistant Worker",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-quality-timeout-"));
    const worker = join(root, "stubborn-worker.mjs");
    writeFileSync(
      worker,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n",
    );
    chmodSync(worker, 0o700);
    const startedAt = performance.now();
    await assert.rejects(
      runMediaWorkerBatch({
        workerPath: worker,
        nativeManifestPath: "fixture-native",
        onnxRuntimePath: "fixture-ort",
        modelManifestPath: "fixture-model",
        sourcePath: "fixture-audio",
        timeoutMs: 100,
        terminationGraceMs: 100,
      }),
      /timed out after 100 ms/,
    );
    assert.ok(performance.now() - startedAt < 2_000);
    rmSync(root, { recursive: true, force: true });
  },
);

test(
  "shared batch client rejects a response from another workload identity",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-quality-identity-"));
    const worker = join(root, "wrong-identity-worker.mjs");
    writeFileSync(
      worker,
      `#!/usr/bin/env node
const response = {type:"ready",protocolVersion:1,identity:{workloadId:"wrong",workerGeneration:1}};
const json = Buffer.from(JSON.stringify(response));
const payload = Buffer.concat([Buffer.from([1]), json]);
const prefix = Buffer.alloc(4);
prefix.writeUInt32BE(payload.length);
process.stdin.once("data", () => { process.stdout.write(Buffer.concat([prefix, payload])); });
setInterval(() => {}, 1000);
`,
    );
    chmodSync(worker, 0o700);
    await assert.rejects(
      runMediaWorkerBatch({
        workerPath: worker,
        nativeManifestPath: "fixture-native",
        onnxRuntimePath: "fixture-ort",
        modelManifestPath: "fixture-model",
        sourcePath: "fixture-audio",
        timeoutMs: 1_000,
        terminationGraceMs: 100,
      }),
      /response identity does not match/,
    );
    rmSync(root, { recursive: true, force: true });
  },
);

test(
  "shared batch client exposes the spawned process and validated responses",
  { skip: process.platform === "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-batch-observer-"));
    const worker = join(root, "fixture-worker.mjs");
    writeFileSync(
      worker,
      `#!/usr/bin/env node
let buffered = Buffer.alloc(0);
let identity;
function send(value) {
  const json = Buffer.from(JSON.stringify(value));
  const payload = Buffer.concat([Buffer.from([1]), json]);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([prefix, payload]));
}
process.stdin.on("data", chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < 4 + length) break;
    const payload = buffered.subarray(4, 4 + length);
    buffered = buffered.subarray(4 + length);
    const command = JSON.parse(payload.subarray(1));
    identity = command.identity;
    if (command.type === "start") {
      send({type:"ready",protocolVersion:1,identity});
      send({type:"heartbeat",protocolVersion:1,identity,stage:"decoding",checkpoint:{streams:[],analysisSample:0}});
    } else if (command.type === "ping") {
      send({type:"pong",protocolVersion:1,identity,nonce:command.nonce});
      send({type:"speaker_turn_batch",protocolVersion:1,identity,revision:1,batchIndex:0,isLast:true,turns:[]});
      send({type:"completed",protocolVersion:1,identity,metrics:{sourceSamples:1,segments:0,speakers:0,elapsedMs:1,peakWorkingBytes:null}});
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`,
    );
    chmodSync(worker, 0o700);
    const spawned = [];
    const responseTypes = [];
    const result = await runMediaWorkerBatch({
      workerPath: worker,
      nativeManifestPath: "fixture-native",
      onnxRuntimePath: "fixture-ort",
      modelManifestPath: "fixture-model",
      sourcePath: "fixture-audio",
      mode: "diarization",
      timeoutMs: 2_000,
      onSpawn: (pid) => spawned.push(pid),
      onResponse: (responseValue) => responseTypes.push(responseValue.type),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(spawned.length, 1);
    assert.ok(Number.isSafeInteger(spawned[0]) && spawned[0] > 0);
    assert.deepEqual(responseTypes, [
      "ready",
      "heartbeat",
      "pong",
      "speaker_turn_batch",
      "completed",
    ]);
    rmSync(root, { recursive: true, force: true });
  },
);

test("bounded quality subprocess cleanup settles a resistant descendant tree", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "myagents-quality-tree-"));
  const descendantPidPath = join(root, "descendant.pid");
  const parentSource = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:"ignore"});
writeFileSync(process.argv[1], String(descendant.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;
  const contained = spawnSpeechQualityProcess(
    process.execPath,
    ["-e", parentSource, descendantPidPath],
    { stdio: "ignore" },
  );
  context.after(async () => {
    try {
      await terminateSpeechQualityProcessTree(contained, {
        graceMs: 500,
        label: "Fixture",
      });
    } catch {
      // The assertion below owns the diagnostic; this is only best-effort cleanup.
    }
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(
    await waitUntil(() => existsSync(descendantPidPath), 2_000),
    true,
  );
  const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  await assert.rejects(
    waitForSpeechQualityProcess(contained, {
      timeoutMs: 100,
      graceMs: 1_000,
      label: "Fixture quality process",
    }),
    /timed out after 100 ms/,
  );
  assert.equal(
    await waitUntil(() => !processExists(descendantPid), 2_000),
    true,
  );
});

test("quality corpus preparation rejects repository-owned raw output", () => {
  const outcome = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts/prepare-speech-quality-corpus.mjs"),
      "--cache-dir",
      join(repoRoot, ".quality-cache"),
      "--output",
      join(repoRoot, ".quality-output"),
      "--offline",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /must stay outside the repository/);
});

test("quality corpus preparation rejects a cache symlink into the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "myagents-quality-cache-link-"));
  const cacheLink = join(root, "cache-link");
  symlinkSync(
    repoRoot,
    cacheLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  const outcome = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts/prepare-speech-quality-corpus.mjs"),
      "--cache-dir",
      join(cacheLink, ".quality-cache"),
      "--output",
      join(root, "output"),
      "--offline",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /must stay outside the repository/);
  rmSync(root, { recursive: true, force: true });
});
