import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File } from "./document-processing-resource-cache.mjs";
import {
  spawnSpeechQualityProcess,
  waitForSpeechQualityProcess,
} from "./speech-quality-process-tree.mjs";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const PREPARE_TIMEOUT_MS = 60 * 60 * 1_000;
const SAMPLE_RATE = 16_000;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "..");
const sourceLockPath = resolve(
  scriptRoot,
  "speech-long-corpus-source-lock.json",
);
const sourceLockBytes = readFileSync(sourceLockPath);
const sourceLock = JSON.parse(sourceLockBytes.toString("utf8"));

const args = process.argv.slice(2);
const corpusIndex = args.indexOf("--quality-corpus");
const outputIndex = args.indexOf("--output");
const qualityCorpusRoot =
  corpusIndex >= 0 && args[corpusIndex + 1]
    ? resolve(args[corpusIndex + 1])
    : undefined;
const outputRoot =
  outputIndex >= 0 && args[outputIndex + 1]
    ? resolve(args[outputIndex + 1])
    : undefined;
const recognized = new Set([
  "--quality-corpus",
  corpusIndex >= 0 ? args[corpusIndex + 1] : undefined,
  "--output",
  outputIndex >= 0 ? args[outputIndex + 1] : undefined,
]);

if (
  !qualityCorpusRoot ||
  !outputRoot ||
  args.some((argument) => !recognized.has(argument))
) {
  throw new Error(
    "Usage: node scripts/prepare-speech-long-corpus.mjs --quality-corpus <prepared-quality-corpus> --output <new-directory>",
  );
}

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

function resolvePhysicalCandidate(candidate) {
  const suffix = [];
  let existing = resolve(candidate);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw new Error("Unable to resolve speech long-corpus path");
    }
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function readBoundedJson(path, label) {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} must be between 1 byte and 16 MiB`);
  }
  return {
    value: JSON.parse(bytes.toString("utf8")),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateSourceLock() {
  const cases = sourceLock.cases;
  const source = sourceLock.source;
  if (
    sourceLock.schemaVersion !== 1 ||
    !SAFE_ID.test(sourceLock.corpusVersion ?? "") ||
    !SHA256.test(sourceLock.preparedManifestSha256 ?? "") ||
    sourceLock.tools?.ffmpeg !== "8.0.1" ||
    source?.qualityCorpusVersion !== "myagents-speech-quality-v1" ||
    !SHA256.test(source?.preparedManifestSha256 ?? "") ||
    !SAFE_ID.test(source?.caseId ?? "") ||
    !safeRelativePath(source?.sourcePath) ||
    !Number.isSafeInteger(source?.sourceBytes) ||
    source.sourceBytes <= 0 ||
    !SHA256.test(source?.sourceSha256 ?? "") ||
    source?.speakerCount !== 4 ||
    source?.license !== "CC-BY-4.0" ||
    typeof source?.upstreamRevision !== "string" ||
    source.upstreamRevision.length === 0 ||
    !Array.isArray(cases) ||
    cases.length !== 3
  ) {
    throw new Error("Speech long-corpus source lock is invalid");
  }
  const expectedDurations = [30, 2 * 60 * 60, 8 * 60 * 60];
  const ids = new Set();
  for (const [index, entry] of cases.entries()) {
    if (
      !SAFE_ID.test(entry?.id ?? "") ||
      ids.has(entry.id) ||
      entry.durationSeconds !== expectedDurations[index] ||
      !Number.isSafeInteger(entry.expectedSpeakerCount) ||
      entry.expectedSpeakerCount < 2 ||
      entry.expectedSpeakerCount > source.speakerCount ||
      !Number.isSafeInteger(entry.timeoutMs) ||
      entry.timeoutMs < 10 * 60 * 1_000 ||
      entry.timeoutMs > 8 * 60 * 60 * 1_000
    ) {
      throw new Error("Speech long-corpus case is invalid");
    }
    ids.add(entry.id);
  }
}

validateSourceLock();
const physicalRepoRoot = realpathSync(repoRoot);
const physicalCorpusRoot = resolvePhysicalCandidate(qualityCorpusRoot);
const physicalOutputRoot = resolvePhysicalCandidate(outputRoot);
if (
  isWithin(physicalRepoRoot, physicalCorpusRoot) ||
  isWithin(physicalRepoRoot, physicalOutputRoot) ||
  isWithin(physicalCorpusRoot, physicalOutputRoot) ||
  existsSync(outputRoot)
) {
  throw new Error(
    "Speech long corpus input/output must be distinct, new directories outside the repository",
  );
}

const ffmpegVersion = execFileSync("ffmpeg", ["-version"], {
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
})
  .split(/\r?\n/, 1)[0]
  .match(/^ffmpeg version ([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
if (ffmpegVersion !== sourceLock.tools.ffmpeg) {
  throw new Error("Speech long corpus FFmpeg version drifted");
}

const qualityManifestPath = join(qualityCorpusRoot, "prepared-corpus.json");
const qualityManifestEvidence = readBoundedJson(
  qualityManifestPath,
  "Prepared quality corpus manifest",
);
const qualityManifest = qualityManifestEvidence.value;
const sourceEntry = qualityManifest.cases?.find(
  (entry) => entry.id === sourceLock.source.caseId,
);
if (
  qualityManifestEvidence.sha256 !== sourceLock.source.preparedManifestSha256 ||
  qualityManifest.corpusVersion !== sourceLock.source.qualityCorpusVersion ||
  sourceEntry?.sourcePath !== sourceLock.source.sourcePath ||
  sourceEntry?.sourceBytes !== sourceLock.source.sourceBytes ||
  sourceEntry?.sourceSha256 !== sourceLock.source.sourceSha256
) {
  throw new Error(
    "Prepared quality corpus does not match the long source lock",
  );
}

const sourcePath = resolve(qualityCorpusRoot, sourceEntry.sourcePath);
const sourceFromRoot = relative(qualityCorpusRoot, sourcePath);
const sourceMetadata = lstatSync(sourcePath);
if (
  sourceFromRoot.startsWith("..") ||
  isAbsolute(sourceFromRoot) ||
  !sourceMetadata.isFile() ||
  sourceMetadata.isSymbolicLink() ||
  sourceMetadata.size !== sourceEntry.sourceBytes ||
  sha256File(sourcePath) !== sourceEntry.sourceSha256
) {
  throw new Error("Speech long corpus source bytes drifted");
}

mkdirSync(outputRoot, { mode: 0o700 });
mkdirSync(join(outputRoot, "audio"), { mode: 0o700 });
const preparedCases = [];
for (const entry of sourceLock.cases) {
  const outputPath = join(outputRoot, "audio", `${entry.id}.ogg`);
  const ffmpeg = spawnSpeechQualityProcess(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-stream_loop",
      "-1",
      "-i",
      sourcePath,
      "-map",
      "0:a:0",
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-t",
      String(entry.durationSeconds),
      "-ac",
      "1",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-flags:a",
      "+bitexact",
      "-application",
      "audio",
      "-frame_duration",
      "20",
      "-vbr",
      "on",
      "-b:a",
      "64000",
      outputPath,
    ],
    { stdio: "inherit" },
  );
  const outcome = await waitForSpeechQualityProcess(ffmpeg, {
    timeoutMs: PREPARE_TIMEOUT_MS,
    graceMs: 2_000,
    label: `Speech long corpus ${entry.id}`,
  });
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new Error(
      `Speech long corpus FFmpeg failed: case=${entry.id}, exit=${outcome.code}, signal=${outcome.signal}`,
    );
  }
  const metadata = lstatSync(outputPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error("Prepared speech long corpus output is invalid");
  }
  chmodSync(outputPath, 0o600);
  preparedCases.push({
    id: entry.id,
    sourcePath: relative(outputRoot, outputPath).replaceAll("\\", "/"),
    sourceBytes: metadata.size,
    sourceSha256: sha256File(outputPath),
    durationSeconds: entry.durationSeconds,
    expectedSamples16k: entry.durationSeconds * SAMPLE_RATE,
    expectedSpeakerCount: entry.expectedSpeakerCount,
    timeoutMs: entry.timeoutMs,
  });
}

const manifest = {
  schemaVersion: 1,
  corpusVersion: sourceLock.corpusVersion,
  source: {
    caseId: sourceLock.source.caseId,
    sourceSha256: sourceLock.source.sourceSha256,
    license: sourceLock.source.license,
    upstreamRevision: sourceLock.source.upstreamRevision,
  },
  cases: preparedCases,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const manifestPath = join(outputRoot, "prepared-long-corpus.json");
writeFileSync(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
if (manifestSha256 !== sourceLock.preparedManifestSha256) {
  throw new Error(
    `Prepared speech long corpus manifest drifted: expected=${sourceLock.preparedManifestSha256}, actual=${manifestSha256}`,
  );
}

console.log(
  JSON.stringify({
    corpusVersion: sourceLock.corpusVersion,
    manifestSha256,
    output: outputRoot,
  }),
);
