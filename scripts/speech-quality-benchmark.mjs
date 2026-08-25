import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertExpectedMediaWorkerBatch,
  runMediaWorkerBatch,
} from "./media-worker-batch-client.mjs";
import {
  spawnSpeechQualityProcess,
  waitForSpeechQualityProcess,
} from "./speech-quality-process-tree.mjs";

const [
  workerPath,
  nativeManifestPath,
  onnxRuntimePath,
  modelManifestPath,
  corpusManifestPath,
  reportPath,
] = process.argv.slice(2);

if (
  !workerPath ||
  !nativeManifestPath ||
  !onnxRuntimePath ||
  !modelManifestPath ||
  !corpusManifestPath ||
  !reportPath
) {
  throw new Error(
    "Usage: node scripts/speech-quality-benchmark.mjs <worker> <native-manifest> <onnx-runtime> <model-manifest> <prepared-corpus-manifest> <report-json>",
  );
}

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_METRIC_OUTPUT_BYTES = 16 * 1024 * 1024;
const METRIC_TIMEOUT_MS = 15 * 60 * 1_000;
const TERMINATION_GRACE_MS = 2_000;
const SAMPLE_RATE = 16_000;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ASR_THRESHOLDS = Object.freeze({
  "mandarin-near:cer": 0.15,
  "mandarin-meeting:cer": 0.3,
  "english-meeting:wer": 0.3,
});
const DIARIZATION_THRESHOLDS = Object.freeze({ meeting: 0.35 });

function readBoundedJson(path, label) {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} must be between 1 byte and 16 MiB`);
  }
  return {
    value: JSON.parse(bytes.toString("utf8")),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function resolveCorpusFile(root, path) {
  if (!isSafeRelativePath(path)) {
    throw new Error("Corpus source path must be a safe relative path");
  }
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Corpus source path escapes its manifest directory");
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Corpus source must be a regular non-symlink file");
  }
  return { absolute, bytes: stat.size };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function validateSegment(segment, label, includeSpeaker) {
  if (
    !segment ||
    typeof segment !== "object" ||
    !Number.isFinite(segment.startSeconds) ||
    !Number.isFinite(segment.endSeconds) ||
    segment.startSeconds < 0 ||
    segment.endSeconds <= segment.startSeconds ||
    (includeSpeaker &&
      (typeof segment.speaker !== "string" || !SAFE_ID.test(segment.speaker)))
  ) {
    throw new Error(`${label} contains an invalid segment`);
  }
}

function validateCorpusManifest(manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.corpusVersion !== "string" ||
    !SAFE_ID.test(manifest.corpusVersion) ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length === 0 ||
    manifest.cases.length > 10_000
  ) {
    throw new Error("Prepared speech quality corpus manifest is invalid");
  }
  const ids = new Set();
  for (const entry of manifest.cases) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !SAFE_ID.test(entry.id ?? "") ||
      ids.has(entry.id) ||
      !["asr", "diarization"].includes(entry.kind) ||
      !SAFE_ID.test(entry.group ?? "") ||
      !isSafeRelativePath(entry.sourcePath) ||
      !SHA256.test(entry.sourceSha256 ?? "") ||
      !Number.isSafeInteger(entry.sourceBytes) ||
      entry.sourceBytes <= 0 ||
      !Number.isSafeInteger(entry.timeoutMs) ||
      entry.timeoutMs <= 0 ||
      entry.timeoutMs > 12 * 60 * 60 * 1_000
    ) {
      throw new Error("Prepared speech quality corpus case is invalid");
    }
    ids.add(entry.id);
    if (entry.kind === "asr") {
      if (
        !["zh", "en", "mixed"].includes(entry.language) ||
        !["cer", "wer"].includes(entry.metric) ||
        typeof entry.reference !== "string" ||
        entry.reference.trim().length === 0 ||
        entry.reference.length > 1_000_000
      ) {
        throw new Error("Prepared ASR quality case is invalid");
      }
    } else {
      if (
        !Array.isArray(entry.reference) ||
        entry.reference.length === 0 ||
        entry.reference.length > 100_000 ||
        !Number.isFinite(entry.collarSeconds) ||
        entry.collarSeconds < 0 ||
        entry.collarSeconds > 5
      ) {
        throw new Error("Prepared diarization quality case is invalid");
      }
      for (const segment of entry.reference) {
        validateSegment(segment, entry.id, true);
      }
    }
  }
}

async function runJsonCommand(command, args, input, timeoutMs) {
  const contained = spawnSpeechQualityProcess(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const { child } = contained;
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow;
  let abortOutput;
  const outputAbort = new Promise((_, reject) => {
    abortOutput = reject;
  });
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_METRIC_OUTPUT_BYTES) {
      overflow = new Error("Speech metric output exceeded 16 MiB");
      abortOutput(overflow);
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_METRIC_OUTPUT_BYTES) stderr.push(chunk);
  });
  child.stdin.end(JSON.stringify(input));
  const outcome = await waitForSpeechQualityProcess(contained, {
    timeoutMs,
    graceMs: TERMINATION_GRACE_MS,
    label: "Speech metric process",
    abortPromise: outputAbort,
  });
  if (overflow) throw overflow;
  if (outcome.code !== 0 || outcome.signal !== null) {
    const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(
      `Speech metric process failed: exit=${outcome.code}, signal=${outcome.signal}, stderr=${diagnostic.slice(0, 2_000)}`,
    );
  }
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}

function collectTranscript(responses) {
  return responses
    .filter((response) => response.type === "transcript_segment")
    .sort(
      (left, right) =>
        left.startSample - right.startSample || left.revision - right.revision,
    )
    .map((response) => response.text)
    .join(" ");
}

function collectSpeakerTurns(responses) {
  return responses
    .filter((response) => response.type === "speaker_turn_batch")
    .sort((left, right) => left.batchIndex - right.batchIndex)
    .flatMap((response) => response.turns)
    .sort(
      (left, right) =>
        left.startSample - right.startSample ||
        left.endSample - right.endSample ||
        left.globalSpeaker - right.globalSpeaker,
    )
    .map((turn) => ({
      speaker: `speaker_${turn.globalSpeaker}`,
      startSeconds: turn.startSample / SAMPLE_RATE,
      endSeconds: turn.endSample / SAMPLE_RATE,
    }));
}

function thresholdResults(metrics) {
  const gates = [];
  for (const [key, maximum] of Object.entries(ASR_THRESHOLDS)) {
    const [group, metric] = key.split(":");
    const result = metrics.asr.groups.find(
      (candidate) => candidate.group === group && candidate.metric === metric,
    );
    gates.push({
      kind: metric,
      group,
      maximum,
      actual: result?.rate ?? null,
      pass: result !== undefined && result.rate <= maximum,
    });
  }
  for (const [group, maximum] of Object.entries(DIARIZATION_THRESHOLDS)) {
    const result = metrics.diarization.groups.find(
      (candidate) => candidate.group === group,
    );
    gates.push({
      kind: "der",
      group,
      maximum,
      actual: result?.rate ?? null,
      pass: result !== undefined && result.rate <= maximum,
    });
  }
  const mixedCases = metrics.asr.cases.filter(
    (candidate) => candidate.group === "mixed",
  );
  gates.push({
    kind: "whole-segment-loss",
    group: "mixed",
    maximum: 0,
    actual: mixedCases.filter((candidate) => candidate.hypothesisUnits === 0)
      .length,
    pass:
      mixedCases.length > 0 &&
      mixedCases.every((candidate) => candidate.hypothesisUnits > 0),
  });
  return gates;
}

const manifestAbsolute = resolve(corpusManifestPath);
const corpusRoot = dirname(manifestAbsolute);
const manifestEvidence = readBoundedJson(manifestAbsolute, "Corpus manifest");
const manifest = manifestEvidence.value;
validateCorpusManifest(manifest);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const sourceLockPath = resolve(
  scriptRoot,
  "speech-quality-corpus-source-lock.json",
);
const sourceLockEvidence = readBoundedJson(
  sourceLockPath,
  "Corpus source lock",
);
const sourceLock = sourceLockEvidence.value;
if (
  sourceLock.schemaVersion !== 1 ||
  manifestEvidence.sha256 !== sourceLock.preparedManifestSha256 ||
  manifest.corpusVersion !== sourceLock.corpusVersion ||
  !sourceLock.tools ||
  typeof sourceLock.tools !== "object"
) {
  throw new Error(
    "Prepared speech quality corpus does not match the current source lock",
  );
}
const runtimePaths = {
  worker: resolve(workerPath),
  nativeManifest: resolve(nativeManifestPath),
  onnxRuntime: resolve(onnxRuntimePath),
  modelManifest: resolve(modelManifestPath),
};

async function snapshotRegularFile(label, path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Speech benchmark ${label} must be a regular non-symlink file`,
    );
  }
  return { label, path, bytes: metadata.size, sha256: await sha256File(path) };
}

async function verifySnapshot(snapshot) {
  const current = await snapshotRegularFile(snapshot.label, snapshot.path);
  if (current.bytes !== snapshot.bytes || current.sha256 !== snapshot.sha256) {
    throw new Error(
      `Speech benchmark input drifted during the run: ${snapshot.label}`,
    );
  }
}

const scriptPaths = {
  benchmark: fileURLToPath(import.meta.url),
  batchClient: resolve(scriptRoot, "media-worker-batch-client.mjs"),
  processTree: resolve(scriptRoot, "speech-quality-process-tree.mjs"),
  metrics: resolve(scriptRoot, "speech-quality-metrics.py"),
  metricsLock: resolve(scriptRoot, "speech-quality-metrics.py.lock"),
};
const snapshots = [];
const runtimeSnapshots = [];
for (const [label, path] of Object.entries(runtimePaths)) {
  const snapshot = await snapshotRegularFile(label, path);
  snapshots.push(snapshot);
  runtimeSnapshots.push(snapshot);
}
for (const [label, path] of Object.entries(scriptPaths)) {
  snapshots.push(await snapshotRegularFile(label, path));
}
snapshots.push({
  label: "sourceLock",
  path: sourceLockPath,
  bytes: sourceLockEvidence.bytes,
  sha256: sourceLockEvidence.sha256,
});
snapshots.push({
  label: "preparedManifest",
  path: manifestAbsolute,
  bytes: manifestEvidence.bytes,
  sha256: manifestEvidence.sha256,
});

const preparedCases = [];
for (const entry of manifest.cases) {
  const source = resolveCorpusFile(corpusRoot, entry.sourcePath);
  const snapshot = await snapshotRegularFile(
    `corpus:${entry.id}`,
    source.absolute,
  );
  if (
    snapshot.bytes !== entry.sourceBytes ||
    snapshot.sha256 !== entry.sourceSha256
  ) {
    throw new Error(`Prepared corpus bytes drifted for ${entry.id}`);
  }
  snapshots.push(snapshot);
  preparedCases.push({ entry, source, snapshot });
}

const metricRequest = { asr: [], diarization: [] };
const caseEvidence = [];
for (const [index, { entry, source, snapshot }] of preparedCases.entries()) {
  const mode = entry.kind === "asr" ? "attachment" : "diarization";
  const startedAt = performance.now();
  const result = await runMediaWorkerBatch({
    workerPath: runtimePaths.worker,
    nativeManifestPath: runtimePaths.nativeManifest,
    onnxRuntimePath: runtimePaths.onnxRuntime,
    modelManifestPath: runtimePaths.modelManifest,
    sourcePath: source.absolute,
    mode,
    timeoutMs: entry.timeoutMs,
    workloadId: `quality_${entry.id}`,
    workerGeneration: index + 1,
  });
  const summary = assertExpectedMediaWorkerBatch(mode, result);
  await verifySnapshot(snapshot);
  for (const runtimeSnapshot of runtimeSnapshots) {
    await verifySnapshot(runtimeSnapshot);
  }
  const wallElapsedMs = Math.round(performance.now() - startedAt);
  caseEvidence.push({
    id: entry.id,
    kind: entry.kind,
    group: entry.group,
    sourceSha256: entry.sourceSha256,
    sourceBytes: entry.sourceBytes,
    wallElapsedMs,
    workerMetrics: summary.completedMetrics,
    transcriptSegments: summary.counts.transcript_segment ?? 0,
    speakerTurns: summary.speakerTurnCount,
  });
  if (entry.kind === "asr") {
    metricRequest.asr.push({
      id: entry.id,
      group: entry.group,
      language: entry.language,
      metric: entry.metric,
      reference: entry.reference,
      hypothesis: collectTranscript(result.responses),
    });
  } else {
    metricRequest.diarization.push({
      id: entry.id,
      group: entry.group,
      collarSeconds: entry.collarSeconds,
      reference: entry.reference,
      hypothesis: collectSpeakerTurns(result.responses),
    });
  }
}

const metrics = await runJsonCommand(
  "uv",
  ["run", "--locked", scriptPaths.metrics],
  metricRequest,
  METRIC_TIMEOUT_MS,
);
for (const name of ["jiwer", "meeteval", "wetext"]) {
  if (metrics.toolVersions?.[name] !== sourceLock.tools[name]) {
    throw new Error(`Speech metric tool version drifted: ${name}`);
  }
}
for (const snapshot of snapshots) await verifySnapshot(snapshot);
const gates = thresholdResults(metrics);
const snapshotByLabel = Object.fromEntries(
  snapshots.map((snapshot) => [snapshot.label, snapshot]),
);
const report = {
  schemaVersion: 1,
  corpusVersion: manifest.corpusVersion,
  sourceLockSha256: sourceLockEvidence.sha256,
  preparedManifestSha256: manifestEvidence.sha256,
  benchmarkScripts: {
    benchmarkSha256: snapshotByLabel.benchmark.sha256,
    batchClientSha256: snapshotByLabel.batchClient.sha256,
    processTreeSha256: snapshotByLabel.processTree.sha256,
    metricsSha256: snapshotByLabel.metrics.sha256,
    metricsLockSha256: snapshotByLabel.metricsLock.sha256,
  },
  environment: {
    platform: platform(),
    release: release(),
    architecture: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    nodeVersion: process.version,
    workerSha256: snapshotByLabel.worker.sha256,
    nativeManifestSha256: snapshotByLabel.nativeManifest.sha256,
    onnxRuntimeSha256: snapshotByLabel.onnxRuntime.sha256,
    modelManifestSha256: snapshotByLabel.modelManifest.sha256,
    metricToolVersions: metrics.toolVersions,
  },
  cases: caseEvidence,
  metrics: {
    asr: metrics.asr,
    diarization: metrics.diarization,
  },
  gates,
  pass: gates.every((gate) => gate.pass),
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
console.log(
  JSON.stringify({
    reportPath: resolve(reportPath),
    corpusVersion: report.corpusVersion,
    caseCount: report.cases.length,
    gates: report.gates,
    pass: report.pass,
  }),
);
if (!report.pass) process.exitCode = 1;
