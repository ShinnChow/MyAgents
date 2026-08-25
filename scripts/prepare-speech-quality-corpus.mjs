import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireLockedResource,
  withResourcePrepareLock,
} from "./document-processing-resource-cache.mjs";
import {
  spawnSpeechQualityProcess,
  waitForSpeechQualityProcess,
} from "./speech-quality-process-tree.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "..");
const sourceLockPath = resolve(
  scriptRoot,
  "speech-quality-corpus-source-lock.json",
);
const helperPath = resolve(scriptRoot, "speech-quality-corpus-prepare.py");
const sourceLock = JSON.parse(readFileSync(sourceLockPath, "utf8"));
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;
const PREPARE_TIMEOUT_MS = 60 * 60 * 1_000;
const expectedSources = [
  "aishell1Audio",
  "aishell1Transcript",
  "aishell4Audio",
  "aishell4TextGrid",
  "aishell4Rttm",
  "ascendTest",
  "amiAudio",
  "amiAnnotations",
];

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const cacheIndex = args.indexOf("--cache-dir");
const outputIndex = args.indexOf("--output");
const cacheRoot =
  cacheIndex >= 0 && args[cacheIndex + 1]
    ? resolve(args[cacheIndex + 1])
    : undefined;
const outputRoot =
  outputIndex >= 0 && args[outputIndex + 1]
    ? resolve(args[outputIndex + 1])
    : undefined;
const recognized = new Set([
  "--offline",
  "--cache-dir",
  cacheIndex >= 0 ? args[cacheIndex + 1] : undefined,
  "--output",
  outputIndex >= 0 ? args[outputIndex + 1] : undefined,
]);

if (
  !cacheRoot ||
  !outputRoot ||
  args.some((argument) => !recognized.has(argument))
) {
  throw new Error(
    "Usage: node scripts/prepare-speech-quality-corpus.mjs --cache-dir <cache> --output <new-directory> [--offline]",
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
      throw new Error("Unable to resolve speech quality corpus path");
    }
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

const physicalRepoRoot = realpathSync(repoRoot);
const physicalCacheRoot = resolvePhysicalCandidate(cacheRoot);
const physicalOutputRoot = resolvePhysicalCandidate(outputRoot);
if (
  isWithin(physicalRepoRoot, physicalCacheRoot) ||
  isWithin(physicalRepoRoot, physicalOutputRoot)
) {
  throw new Error(
    "Speech quality corpus cache and output must stay outside the repository",
  );
}

function validateSourceLock() {
  if (
    sourceLock.schemaVersion !== 1 ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(sourceLock.corpusVersion ?? "") ||
    !/^[0-9a-f]{64}$/.test(sourceLock.preparedManifestSha256 ?? "") ||
    !sourceLock.tools ||
    typeof sourceLock.tools !== "object" ||
    !sourceLock.selections ||
    typeof sourceLock.selections !== "object" ||
    Object.keys(sourceLock.sources ?? {})
      .sort()
      .join("\0") !== [...expectedSources].sort().join("\0")
  ) {
    throw new Error("Speech quality corpus source lock is invalid");
  }
  let totalBytes = 0;
  for (const source of Object.values(sourceLock.sources)) {
    if (
      !source ||
      typeof source !== "object" ||
      !/^https:\/\//.test(source.url ?? "") ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(source.cacheName ?? "") ||
      !/^[0-9a-f]{64}$/.test(source.sha256 ?? "") ||
      !Number.isSafeInteger(source.size) ||
      source.size <= 0 ||
      source.size > 512 * 1024 * 1024 ||
      !["Apache-2.0", "CC-BY-4.0", "CC-BY-SA-4.0"].includes(source.license) ||
      !/^https:\/\//.test(source.licenseUrl ?? "") ||
      typeof source.upstreamRevision !== "string" ||
      source.upstreamRevision.length === 0
    ) {
      throw new Error("Speech quality corpus source entry is invalid");
    }
    totalBytes += source.size;
  }
  if (totalBytes > 768 * 1024 * 1024) {
    throw new Error("Speech quality corpus source budget exceeds 768 MiB");
  }
  for (const [name, version] of Object.entries(sourceLock.tools)) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(name) ||
      !/^\d+\.\d+(?:\.\d+)?$/.test(version)
    ) {
      throw new Error("Speech quality corpus tool lock is invalid");
    }
  }
}

validateSourceLock();
const stats = { hits: 0, migrated: 0, downloaded: 0 };
await withResourcePrepareLock(cacheRoot, async () => {
  const paths = {};
  for (const name of expectedSources) {
    const source = sourceLock.sources[name];
    paths[name] = await acquireLockedResource({
      cacheRoot,
      entry: source,
      cacheName: source.cacheName,
      offline,
      downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS,
      stats,
    });
  }
  const uvArguments = [
    "run",
    "--locked",
    ...(offline ? ["--offline"] : []),
    helperPath,
  ];
  const preparation = spawnSpeechQualityProcess(
    "uv",
    [
      ...uvArguments,
      "--source-lock",
      sourceLockPath,
      "--output",
      outputRoot,
      "--aishell1-audio",
      paths.aishell1Audio,
      "--aishell1-transcript",
      paths.aishell1Transcript,
      "--aishell4-audio",
      paths.aishell4Audio,
      "--aishell4-textgrid",
      paths.aishell4TextGrid,
      "--aishell4-rttm",
      paths.aishell4Rttm,
      "--ascend-test",
      paths.ascendTest,
      "--ami-audio",
      paths.amiAudio,
      "--ami-annotations",
      paths.amiAnnotations,
    ],
    { stdio: "inherit" },
  );
  const outcome = await waitForSpeechQualityProcess(preparation, {
    timeoutMs: PREPARE_TIMEOUT_MS,
    graceMs: 2_000,
    label: "Speech quality corpus preparation",
  });
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new Error(
      `Speech quality corpus preparation failed: exit=${outcome.code}, signal=${outcome.signal}`,
    );
  }
});
console.log(
  JSON.stringify({
    corpusVersion: sourceLock.corpusVersion,
    cache: stats,
    output: outputRoot,
  }),
);
