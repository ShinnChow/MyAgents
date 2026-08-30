#!/usr/bin/env node
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireLockedResource,
  validateLockedFile,
} from "./document-processing-resource-cache.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_LOCK_PATH = join(
  PROJECT_ROOT,
  "src-tauri/media-worker/model-pack-source-lock.json",
);
const ORIGIN_LOCK_PATH = join(
  PROJECT_ROOT,
  "src-tauri/media-worker/model-pack-mirror-origin-lock.json",
);
const CACHE_ROOT = join(
  PROJECT_ROOT,
  "src-tauri/target/speech-model-mirror-cache",
);
const PUBLIC_ORIGIN = "https://download.myagents.io";
const PUBLIC_PATH_PREFIX = "models/speech/assets/sha256";
const ORIGIN_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);
const SAFE_ID_RE = /^(asset|legal):[0-9A-Za-z][0-9A-Za-z._-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const args = { outDir: resolve("dist/speech-models"), offline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--out requires a directory");
      }
      args.outDir = resolve(value);
      index += 1;
    } else if (argument === "--offline") {
      args.offline = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function downloadableEntries(sourceLock) {
  if (
    !Array.isArray(sourceLock.assets) ||
    !Array.isArray(sourceLock.legalArtifacts)
  ) {
    throw new Error(
      "Speech model source lock omitted assets or legalArtifacts",
    );
  }
  const entries = sourceLock.assets.map((asset) => ({
    id: `asset:${asset.id}`,
    publicUrl: asset.url,
    sha256: asset.sha256,
    size: asset.size,
  }));
  for (const legal of sourceLock.legalArtifacts) {
    if (legal.source?.type !== "remote") continue;
    entries.push({
      id: `legal:${legal.id}`,
      publicUrl: legal.source.url,
      sha256: legal.source.sha256,
      size: legal.source.size,
    });
  }
  return entries;
}

function originFilename(rawUrl) {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    !ORIGIN_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Unsupported speech mirror origin: ${rawUrl}`);
  }
  const filename = basename(url.pathname);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(filename)) {
    throw new Error(`Unsafe speech mirror origin filename: ${rawUrl}`);
  }
  return filename;
}

export function buildMirrorPlan(sourceLock, originLock) {
  if (
    sourceLock?.schemaVersion !== 1 ||
    sourceLock?.packId !== "local-standard-speech" ||
    sourceLock?.packRevision !== "local-standard-speech-v2" ||
    originLock?.schemaVersion !== 1 ||
    originLock?.packId !== sourceLock.packId ||
    originLock?.packRevision !== sourceLock.packRevision ||
    !Array.isArray(originLock.sources)
  ) {
    throw new Error("Speech mirror lock identity mismatch");
  }

  const origins = new Map();
  for (const source of originLock.sources) {
    if (
      !source ||
      !SAFE_ID_RE.test(source.id ?? "") ||
      typeof source.url !== "string" ||
      origins.has(source.id)
    ) {
      throw new Error(
        "Speech mirror origin lock contains an invalid or duplicate source",
      );
    }
    origins.set(source.id, source.url);
  }

  const entries = downloadableEntries(sourceLock).map((entry) => {
    if (
      !SAFE_ID_RE.test(entry.id) ||
      !SHA256_RE.test(entry.sha256 ?? "") ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0
    ) {
      throw new Error(`Invalid speech mirror source entry: ${entry.id}`);
    }
    const originUrl = origins.get(entry.id);
    if (!originUrl) {
      throw new Error(`Speech mirror origin is missing: ${entry.id}`);
    }
    origins.delete(entry.id);
    const filename = originFilename(originUrl);
    const remotePath = `${PUBLIC_PATH_PREFIX}/${entry.sha256}/${filename}`;
    const expectedPublicUrl = `${PUBLIC_ORIGIN}/${remotePath}`;
    if (entry.publicUrl !== expectedPublicUrl) {
      throw new Error(
        `Speech mirror public URL mismatch for ${entry.id}: expected ${expectedPublicUrl}`,
      );
    }
    return {
      ...entry,
      originUrl,
      remotePath,
      localRelativePath: `mirror/${remotePath}`,
    };
  });

  if (origins.size !== 0) {
    throw new Error(
      `Speech mirror origin lock contains unused sources: ${[...origins.keys()].join(", ")}`,
    );
  }
  if (
    entries.length !== 7 ||
    new Set(entries.map((entry) => entry.remotePath)).size !== 7
  ) {
    throw new Error(
      "Speech mirror plan must contain exactly seven unique sources",
    );
  }
  return {
    schemaVersion: 1,
    packRevision: sourceLock.packRevision,
    entries,
  };
}

function ensurePlainDirectory(path) {
  mkdirSync(path, { recursive: true });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Speech mirror output must be a real directory: ${path}`);
  }
}

function ensureRelativeDirectory(root, relativePath) {
  let current = root;
  ensurePlainDirectory(current);
  for (const segment of relativePath.split("/")) {
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(segment)) {
      throw new Error(`Unsafe speech mirror output segment: ${segment}`);
    }
    current = join(current, segment);
    ensurePlainDirectory(current);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceLock = readJson(SOURCE_LOCK_PATH);
  const originLock = readJson(ORIGIN_LOCK_PATH);
  const plan = buildMirrorPlan(sourceLock, originLock);
  ensurePlainDirectory(args.outDir);

  const stats = { hits: 0, migrated: 0, downloaded: 0 };
  for (const entry of plan.entries) {
    const cachePath = await acquireLockedResource({
      cacheRoot: CACHE_ROOT,
      entry: {
        url: entry.originUrl,
        sha256: entry.sha256,
        size: entry.size,
      },
      cacheName: `${entry.id}-${basename(entry.remotePath)}`,
      offline: args.offline,
      downloadTimeoutMs: 30 * 60 * 1000,
      stats,
    });
    const destination = join(args.outDir, entry.localRelativePath);
    ensureRelativeDirectory(args.outDir, dirname(entry.localRelativePath));
    copyFileSync(cachePath, destination, constants.COPYFILE_EXCL);
    if (!validateLockedFile(destination, entry)) {
      throw new Error(`Prepared speech mirror source is invalid: ${entry.id}`);
    }
  }

  const planPath = join(args.outDir, "mirror-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `[speech-models] prepared ${plan.entries.length} mirrored sources; cache hits=${stats.hits} downloaded=${stats.downloaded}`,
  );
  console.log(`[speech-models] wrote ${planPath}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      `[speech-models] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
