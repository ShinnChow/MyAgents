import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sha256File } from "./document-processing-resource-cache.mjs";
import {
  assertExpectedMediaWorkerBatch,
  runMediaWorkerBatch,
} from "./media-worker-batch-client.mjs";

const execFileAsync = promisify(execFile);
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const SAMPLE_RATE = 16_000;
const RSS_SAMPLE_INTERVAL_MS = 500;
const RSS_HARD_LIMIT_BYTES = Math.floor(1.2 * 1024 * 1024 * 1024);
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WORKER_STAGES = new Set([
  "loading",
  "decoding",
  "vad",
  "transcribing",
  "segmenting_speakers",
  "embedding_speakers",
  "clustering_speakers",
  "reconciling_speakers",
  "finalizing",
]);
const REQUIRED_STAGES = Object.freeze({
  complete: ["decoding", "finalizing"],
  diarization: [
    "decoding",
    "segmenting_speakers",
    "embedding_speakers",
    "clustering_speakers",
    "reconciling_speakers",
  ],
});
const scriptPath = fileURLToPath(import.meta.url);
const scriptRoot = dirname(scriptPath);
const repoRoot = resolve(scriptRoot, "..");

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

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

function regularFileSnapshot(label, path) {
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return {
    label,
    path: absolute,
    bytes: metadata.size,
    sha256: sha256File(absolute),
  };
}

function verifySnapshot(snapshot) {
  const current = regularFileSnapshot(snapshot.label, snapshot.path);
  if (current.bytes !== snapshot.bytes || current.sha256 !== snapshot.sha256) {
    throw new Error(`Speech long benchmark input drifted: ${snapshot.label}`);
  }
}

export function validateLongCorpusManifest(manifest, sourceLock) {
  if (
    sourceLock?.schemaVersion !== 1 ||
    !SAFE_ID.test(sourceLock.corpusVersion ?? "") ||
    !SHA256.test(sourceLock.preparedManifestSha256 ?? "") ||
    !Array.isArray(sourceLock.cases) ||
    sourceLock.cases.length !== 3 ||
    manifest?.schemaVersion !== 1 ||
    manifest.corpusVersion !== sourceLock.corpusVersion ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== sourceLock.cases.length ||
    manifest.source?.caseId !== sourceLock.source?.caseId ||
    manifest.source?.sourceSha256 !== sourceLock.source?.sourceSha256 ||
    manifest.source?.license !== sourceLock.source?.license ||
    manifest.source?.upstreamRevision !== sourceLock.source?.upstreamRevision
  ) {
    throw new Error("Prepared speech long corpus manifest is invalid");
  }
  for (const [index, entry] of manifest.cases.entries()) {
    const locked = sourceLock.cases[index];
    if (
      !SAFE_ID.test(entry?.id ?? "") ||
      entry.id !== locked?.id ||
      !isSafeRelativePath(entry.sourcePath) ||
      !Number.isSafeInteger(entry.sourceBytes) ||
      entry.sourceBytes <= 0 ||
      !SHA256.test(entry.sourceSha256 ?? "") ||
      entry.durationSeconds !== locked.durationSeconds ||
      entry.expectedSamples16k !== entry.durationSeconds * SAMPLE_RATE ||
      entry.expectedSpeakerCount !== locked.expectedSpeakerCount ||
      entry.timeoutMs !== locked.timeoutMs
    ) {
      throw new Error("Prepared speech long corpus case is invalid");
    }
  }
}

async function readProcessRssBytes(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Speech long benchmark received an invalid Worker pid");
  }
  if (!new Set(["darwin", "linux"]).has(process.platform)) {
    throw new Error(
      `Speech long benchmark RSS sampling is unsupported on ${process.platform}`,
    );
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "/bin/ps",
      ["-o", "rss=", "-p", String(pid)],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    ));
  } catch (error) {
    if (error?.code === 1) return null;
    throw error;
  }
  const value = stdout.trim();
  if (value.length === 0) return null;
  if (!/^\d+$/.test(value)) {
    throw new Error("Speech long benchmark received an invalid RSS sample");
  }
  const rssBytes = Number(value) * 1024;
  if (!Number.isSafeInteger(rssBytes) || rssBytes <= 0) {
    throw new Error("Speech long benchmark received an invalid RSS sample");
  }
  return rssBytes;
}

export function createProcessRssSampler({
  intervalMs = RSS_SAMPLE_INTERVAL_MS,
  readRss = readProcessRssBytes,
} = {}) {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 100 ||
    intervalMs > 10_000 ||
    typeof readRss !== "function"
  ) {
    throw new Error("Speech long benchmark RSS sampler arguments are invalid");
  }
  let pid;
  let interval;
  let currentStage = "spawned";
  let lastRssBytes;
  let sampleCount = 0;
  let missedSampleCount = 0;
  let peakRssBytes = 0;
  let stopped = false;
  const sampleErrors = [];
  const pending = new Set();
  const seenStages = new Set([currentStage]);
  const stagePeakRssBytes = new Map();

  function observeValue(stage, rssBytes) {
    sampleCount += 1;
    lastRssBytes = rssBytes;
    peakRssBytes = Math.max(peakRssBytes, rssBytes);
    stagePeakRssBytes.set(
      stage,
      Math.max(stagePeakRssBytes.get(stage) ?? 0, rssBytes),
    );
  }

  function sample(stage = currentStage) {
    if (!pid || stopped) return;
    let operation;
    operation = Promise.resolve()
      .then(() => readRss(pid))
      .then((rssBytes) => {
        if (rssBytes === null) {
          missedSampleCount += 1;
          return;
        }
        if (!Number.isSafeInteger(rssBytes) || rssBytes <= 0) {
          throw new Error(
            "Speech long benchmark received an invalid RSS sample",
          );
        }
        observeValue(stage, rssBytes);
      })
      .catch((error) => sampleErrors.push(error))
      .finally(() => pending.delete(operation));
    pending.add(operation);
  }

  return {
    start(workerPid) {
      if (
        pid ||
        stopped ||
        !Number.isSafeInteger(workerPid) ||
        workerPid <= 0
      ) {
        throw new Error("Speech long benchmark RSS sampler start is invalid");
      }
      pid = workerPid;
      sample();
      interval = setInterval(() => sample(), intervalMs);
    },
    observeResponse(response) {
      if (!pid || stopped) {
        throw new Error(
          "Speech long benchmark observed a response out of lifecycle",
        );
      }
      if (response.type === "ready") currentStage = "ready";
      if (response.type === "heartbeat") {
        if (!WORKER_STAGES.has(response.stage)) {
          throw new Error(
            "Speech long benchmark received an unknown Worker stage",
          );
        }
        currentStage = response.stage;
      }
      if (["completed", "failed", "yielded"].includes(response.type)) {
        currentStage = "terminal";
      }
      seenStages.add(currentStage);
      if (lastRssBytes !== undefined) {
        stagePeakRssBytes.set(
          currentStage,
          Math.max(stagePeakRssBytes.get(currentStage) ?? 0, lastRssBytes),
        );
      }
      sample(currentStage);
    },
    async stop() {
      if (stopped) {
        throw new Error("Speech long benchmark RSS sampler stopped twice");
      }
      stopped = true;
      clearInterval(interval);
      await Promise.all(pending);
      if (sampleErrors.length > 0) throw sampleErrors[0];
      if (sampleCount === 0) {
        throw new Error("Speech long benchmark did not capture Worker RSS");
      }
      return {
        sampleIntervalMs: intervalMs,
        sampleCount,
        missedSampleCount,
        peakRssBytes,
        stagePeakRssBytes: Object.fromEntries(
          [...stagePeakRssBytes.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
        seenStages: [...seenStages].sort(),
      };
    },
  };
}

function validateTimeline(items, expectedSamples, includeSpeaker) {
  let previousKey;
  const speakers = new Set();
  for (const item of items) {
    const key = [
      item.startSample,
      item.endSample,
      includeSpeaker ? item.globalSpeaker : 0,
    ];
    if (
      !Number.isSafeInteger(item.startSample) ||
      !Number.isSafeInteger(item.endSample) ||
      item.endSample <= item.startSample ||
      item.endSample > expectedSamples ||
      (includeSpeaker &&
        (!Number.isSafeInteger(item.globalSpeaker) ||
          item.globalSpeaker < 0)) ||
      (previousKey &&
        (key[0] < previousKey[0] ||
          (key[0] === previousKey[0] && key[1] < previousKey[1]) ||
          (key[0] === previousKey[0] &&
            key[1] === previousKey[1] &&
            key[2] < previousKey[2])))
    ) {
      throw new Error("Speech long benchmark received an invalid timeline");
    }
    previousKey = key;
    if (includeSpeaker) speakers.add(item.globalSpeaker);
  }
  const speakerLabels = [...speakers].sort((left, right) => left - right);
  if (speakerLabels.some((label, index) => label !== index)) {
    throw new Error(
      "Speech long benchmark received non-compact speaker labels",
    );
  }
  return {
    itemCount: items.length,
    firstStartSample: items[0]?.startSample ?? null,
    lastEndSample: items.at(-1)?.endSample ?? null,
    speakerCount: speakers.size,
  };
}

export function buildLongRunEvidence(mode, result, entry, rss, wallElapsedMs) {
  if (!REQUIRED_STAGES[mode]) {
    throw new Error("Speech long benchmark mode is invalid");
  }
  const summary = assertExpectedMediaWorkerBatch(mode, result);
  const metrics = summary.completedMetrics;
  const requiredStages = [
    ...REQUIRED_STAGES[mode],
    ...(mode === "complete" && entry.durationSeconds >= 120
      ? ["transcribing"]
      : []),
  ];
  if (
    !metrics ||
    metrics.sourceSamples !== entry.expectedSamples16k ||
    !Number.isSafeInteger(metrics.segments) ||
    metrics.segments <= 0 ||
    !Number.isSafeInteger(metrics.speakers) ||
    !Number.isSafeInteger(metrics.elapsedMs) ||
    metrics.elapsedMs <= 0 ||
    !Number.isSafeInteger(wallElapsedMs) ||
    wallElapsedMs <= 0 ||
    !Number.isSafeInteger(rss?.peakRssBytes) ||
    rss.peakRssBytes <= 0 ||
    rss.peakRssBytes >= RSS_HARD_LIMIT_BYTES ||
    requiredStages.some((stage) => !rss.seenStages.includes(stage))
  ) {
    throw new Error("Speech long benchmark run failed its release gates");
  }
  const items =
    mode === "complete"
      ? result.responses.filter(
          (response) => response.type === "transcript_segment",
        )
      : result.responses
          .filter((response) => response.type === "speaker_turn_batch")
          .flatMap((response) => response.turns);
  const timeline = validateTimeline(
    items,
    entry.expectedSamples16k,
    mode === "diarization",
  );
  if (
    timeline.itemCount !== metrics.segments ||
    (mode === "complete" && metrics.speakers !== 0) ||
    (mode === "diarization" &&
      (metrics.speakers !== entry.expectedSpeakerCount ||
        timeline.speakerCount !== entry.expectedSpeakerCount))
  ) {
    throw new Error(
      `Speech long benchmark output metrics drifted: ${JSON.stringify({
        mode,
        expectedSpeakerCount: entry.expectedSpeakerCount,
        workerSpeakerCount: metrics.speakers,
        timelineSpeakerCount: timeline.speakerCount,
        workerSegmentCount: metrics.segments,
        timelineItemCount: timeline.itemCount,
        peakRssBytes: rss.peakRssBytes,
      })}`,
    );
  }
  return {
    mode,
    wallElapsedMs,
    responseCounts: summary.counts,
    workerMetrics: metrics,
    timeline,
    resource: rss,
    pass: true,
  };
}

export function assertRedactedLongReport(value) {
  const forbiddenKeys = new Set([
    "embedding",
    "hypothesis",
    "inputPath",
    "language",
    "outputPath",
    "reference",
    "sourcePath",
    "text",
    "transcript",
  ]);
  function visit(candidate) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, item] of Object.entries(candidate)) {
      if (forbiddenKeys.has(key)) {
        throw new Error(`Speech long benchmark report contains ${key}`);
      }
      visit(item);
    }
  }
  visit(value);
}

async function runMonitoredBatch(options) {
  const sampler = createProcessRssSampler();
  const startedAt = performance.now();
  let result;
  let primaryError;
  try {
    result = await runMediaWorkerBatch({
      ...options,
      onSpawn: (pid) => sampler.start(pid),
      onResponse: (response) => sampler.observeResponse(response),
    });
  } catch (error) {
    primaryError = error;
  }
  let rss;
  try {
    rss = await sampler.stop();
  } catch (error) {
    if (!primaryError) primaryError = error;
  }
  if (primaryError) throw primaryError;
  return {
    result,
    rss,
    wallElapsedMs: Math.max(1, Math.round(performance.now() - startedAt)),
  };
}

function validateReportDestination(reportPath) {
  const absolute = resolve(reportPath);
  if (existsSync(absolute)) {
    throw new Error("Speech long benchmark report must be a new file");
  }
  const physicalParent = realpathSync(dirname(absolute));
  if (isWithin(realpathSync(repoRoot), physicalParent)) {
    throw new Error(
      "Speech long benchmark report must stay outside the repository",
    );
  }
  return absolute;
}

async function main(args) {
  const [
    workerPath,
    nativeManifestPath,
    onnxRuntimePath,
    modelManifestPath,
    corpusManifestPath,
    reportPath,
  ] = args;
  if (
    args.length !== 6 ||
    !workerPath ||
    !nativeManifestPath ||
    !onnxRuntimePath ||
    !modelManifestPath ||
    !corpusManifestPath ||
    !reportPath
  ) {
    throw new Error(
      "Usage: node scripts/speech-long-benchmark.mjs <worker> <native-manifest> <onnx-runtime> <model-manifest> <prepared-long-corpus-manifest> <report-json>",
    );
  }
  const reportAbsolute = validateReportDestination(reportPath);
  const sourceLockPath = resolve(
    scriptRoot,
    "speech-long-corpus-source-lock.json",
  );
  const sourceLockEvidence = readBoundedJson(
    sourceLockPath,
    "Speech long corpus source lock",
  );
  const manifestAbsolute = resolve(corpusManifestPath);
  const manifestEvidence = readBoundedJson(
    manifestAbsolute,
    "Prepared speech long corpus manifest",
  );
  if (
    manifestEvidence.sha256 !== sourceLockEvidence.value.preparedManifestSha256
  ) {
    throw new Error(
      "Prepared speech long corpus does not match the current source lock",
    );
  }
  validateLongCorpusManifest(manifestEvidence.value, sourceLockEvidence.value);

  const runtimePaths = {
    worker: resolve(workerPath),
    nativeManifest: resolve(nativeManifestPath),
    onnxRuntime: resolve(onnxRuntimePath),
    modelManifest: resolve(modelManifestPath),
  };
  const nativeManifestEvidence = readBoundedJson(
    runtimePaths.nativeManifest,
    "Speech native manifest",
  );
  const nativeManifest = nativeManifestEvidence.value;
  if (
    nativeManifest.schemaVersion !== 1 ||
    nativeManifest.capability !== "speech-inference" ||
    !isSafeRelativePath(nativeManifest.files?.mediaWorker?.path) ||
    !SHA256.test(nativeManifest.files?.mediaWorker?.sha256 ?? "") ||
    !Number.isSafeInteger(nativeManifest.files?.mediaWorker?.size) ||
    !SHA256.test(nativeManifest.onnxRuntime?.sha256 ?? "") ||
    !Number.isSafeInteger(nativeManifest.onnxRuntime?.size) ||
    resolve(
      dirname(runtimePaths.nativeManifest),
      nativeManifest.files.mediaWorker.path,
    ) !== runtimePaths.worker
  ) {
    throw new Error("Speech long benchmark native manifest is invalid");
  }
  const modelManifestEvidence = readBoundedJson(
    runtimePaths.modelManifest,
    "Speech model manifest",
  );
  const modelManifest = modelManifestEvidence.value;
  if (
    modelManifest.schemaVersion !== 1 ||
    !SAFE_ID.test(modelManifest.packId ?? "") ||
    !SAFE_ID.test(modelManifest.packRevision ?? "")
  ) {
    throw new Error("Speech long benchmark model manifest is invalid");
  }

  const snapshots = [
    regularFileSnapshot("worker", runtimePaths.worker),
    regularFileSnapshot("nativeManifest", runtimePaths.nativeManifest),
    regularFileSnapshot("onnxRuntime", runtimePaths.onnxRuntime),
    regularFileSnapshot("modelManifest", runtimePaths.modelManifest),
    regularFileSnapshot("benchmark", scriptPath),
    regularFileSnapshot(
      "batchClient",
      resolve(scriptRoot, "media-worker-batch-client.mjs"),
    ),
    regularFileSnapshot("sourceLock", sourceLockPath),
    regularFileSnapshot("preparedManifest", manifestAbsolute),
  ];
  const snapshotByLabel = Object.fromEntries(
    snapshots.map((snapshot) => [snapshot.label, snapshot]),
  );
  if (
    snapshotByLabel.worker.bytes !== nativeManifest.files.mediaWorker.size ||
    snapshotByLabel.worker.sha256 !== nativeManifest.files.mediaWorker.sha256 ||
    snapshotByLabel.onnxRuntime.bytes !== nativeManifest.onnxRuntime.size ||
    snapshotByLabel.onnxRuntime.sha256 !== nativeManifest.onnxRuntime.sha256 ||
    snapshotByLabel.nativeManifest.bytes !== nativeManifestEvidence.bytes ||
    snapshotByLabel.nativeManifest.sha256 !== nativeManifestEvidence.sha256 ||
    snapshotByLabel.modelManifest.bytes !== modelManifestEvidence.bytes ||
    snapshotByLabel.modelManifest.sha256 !== modelManifestEvidence.sha256
  ) {
    throw new Error(
      "Speech long benchmark runtime bytes drifted from manifest",
    );
  }

  const corpusRoot = dirname(manifestAbsolute);
  const preparedCases = manifestEvidence.value.cases.map((entry) => {
    const source = resolve(corpusRoot, entry.sourcePath);
    const fromRoot = relative(corpusRoot, source);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new Error(
        "Speech long corpus source escapes its manifest directory",
      );
    }
    const snapshot = regularFileSnapshot(`corpus:${entry.id}`, source);
    if (
      snapshot.bytes !== entry.sourceBytes ||
      snapshot.sha256 !== entry.sourceSha256
    ) {
      throw new Error(`Speech long corpus bytes drifted for ${entry.id}`);
    }
    snapshots.push(snapshot);
    return { entry, snapshot };
  });

  const cases = [];
  let generation = 1;
  for (const { entry, snapshot } of preparedCases) {
    const runs = {};
    for (const mode of ["complete", "diarization"]) {
      const monitored = await runMonitoredBatch({
        workerPath: runtimePaths.worker,
        nativeManifestPath: runtimePaths.nativeManifest,
        onnxRuntimePath: runtimePaths.onnxRuntime,
        modelManifestPath: runtimePaths.modelManifest,
        sourcePath: snapshot.path,
        mode,
        timeoutMs: entry.timeoutMs,
        workloadId: `long_${entry.id}_${mode}`,
        workerGeneration: generation,
      });
      generation += 1;
      verifySnapshot(snapshot);
      for (const runtimeLabel of [
        "worker",
        "nativeManifest",
        "onnxRuntime",
        "modelManifest",
      ]) {
        verifySnapshot(snapshotByLabel[runtimeLabel]);
      }
      runs[mode] = buildLongRunEvidence(
        mode,
        monitored.result,
        entry,
        monitored.rss,
        monitored.wallElapsedMs,
      );
    }
    cases.push({
      id: entry.id,
      durationSeconds: entry.durationSeconds,
      expectedSamples16k: entry.expectedSamples16k,
      expectedSpeakerCount: entry.expectedSpeakerCount,
      sourceBytes: entry.sourceBytes,
      sourceSha256: entry.sourceSha256,
      runs,
    });
  }
  for (const snapshot of snapshots) verifySnapshot(snapshot);

  const report = {
    schemaVersion: 1,
    corpusVersion: manifestEvidence.value.corpusVersion,
    sourceLockSha256: sourceLockEvidence.sha256,
    preparedManifestSha256: manifestEvidence.sha256,
    benchmarkScripts: {
      benchmarkSha256: snapshotByLabel.benchmark.sha256,
      batchClientSha256: snapshotByLabel.batchClient.sha256,
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
      modelPackId: modelManifest.packId,
      modelPackRevision: modelManifest.packRevision,
    },
    resourceGate: {
      rssHardLimitBytes: RSS_HARD_LIMIT_BYTES,
      measurement:
        "Worker RSS from /bin/ps every 500 ms and at validated protocol responses; native and Rust phase-boundary callbacks move existing WorkerStage heartbeats before embedding and reconciliation work begins",
    },
    cases,
    contentRedacted: true,
    pass: true,
  };
  assertRedactedLongReport(report);
  writeFileSync(reportAbsolute, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(reportAbsolute, 0o600);
  console.log(
    JSON.stringify({
      corpusVersion: report.corpusVersion,
      caseCount: report.cases.length,
      reportPath: reportAbsolute,
      pass: report.pass,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main(process.argv.slice(2));
}
