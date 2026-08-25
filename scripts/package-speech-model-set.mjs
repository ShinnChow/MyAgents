#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  formatCommandFailure,
  resolveSpawnInvocation,
} from "./package-managed-codex-spawn.js";

const SOURCE_LOCK = new URL(
  "../src-tauri/media-worker/model-pack-source-lock.json",
  import.meta.url,
);
const REVISION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

function parseArgs(argv) {
  const args = {
    outDir: resolve("dist/speech-models"),
    allowUnsigned: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("--out requires a directory");
      args.outDir = resolve(value);
      index += 1;
    } else if (arg === "--allow-unsigned") {
      args.allowUnsigned = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readSourceLock() {
  const bytes = readFileSync(SOURCE_LOCK);
  const lock = JSON.parse(bytes.toString("utf8"));
  if (
    lock.schemaVersion !== 1 ||
    typeof lock.packRevision !== "string" ||
    !REVISION_RE.test(lock.packRevision) ||
    lock.signaturePolicy?.algorithm !== "minisign-ed25519" ||
    lock.signaturePolicy?.trustRoot !== "app-updater" ||
    lock.signaturePolicy?.detachedSignatureRequired !== true
  ) {
    throw new Error(
      `Invalid speech model source lock: ${SOURCE_LOCK.pathname}`,
    );
  }
  return { bytes, lock };
}

function run(command, args, options = {}) {
  const invocation = resolveSpawnInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      formatCommandFailure(
        invocation.displayCommand,
        invocation.displayArgs,
        result,
      ),
    );
  }
}

function signManifest(manifestPath) {
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY is required to sign the speech model manifest",
    );
  }
  const keyPath = join(tmpdir(), `myagents-speech-model-key-${randomUUID()}`);
  writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    const env = { ...process.env };
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_PRIVATE_KEY;
    const password =
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? env.TAURI_PRIVATE_KEY_PASSWORD;
    if (password) env.TAURI_PRIVATE_KEY_PASSWORD = password;
    run("npx", ["tauri", "signer", "sign", "-f", keyPath, manifestPath], {
      stdio: "inherit",
      env,
    });
  } finally {
    rmSync(keyPath, { force: true });
  }
}

function ensurePlainDirectory(path) {
  mkdirSync(path, { recursive: true });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Speech model output must be a real directory: ${path}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { bytes, lock } = readSourceLock();
  const setDir = join(args.outDir, "sets", lock.packRevision);
  const manifestPath = join(setDir, "manifest.json");
  const signaturePath = `${manifestPath}.sig`;
  ensurePlainDirectory(args.outDir);
  ensurePlainDirectory(join(args.outDir, "sets"));
  ensurePlainDirectory(setDir);
  rmSync(manifestPath, { force: true });
  rmSync(signaturePath, { force: true });
  writeFileSync(manifestPath, bytes, { flag: "wx", mode: 0o600 });

  if (!args.allowUnsigned) {
    signManifest(manifestPath);
    if (
      !existsSync(signaturePath) ||
      readFileSync(signaturePath, "utf8").trim() === ""
    ) {
      throw new Error(`Tauri signer did not create ${signaturePath}`);
    }
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(`[speech-models] revision ${lock.packRevision}`);
  console.log(`[speech-models] manifest sha256 ${sha256}`);
  console.log(`[speech-models] wrote ${manifestPath}`);
  if (args.allowUnsigned) {
    console.log("[speech-models] unsigned local output; do not publish");
  } else {
    console.log(`[speech-models] wrote ${signaturePath}`);
    console.log(
      `[speech-models] publish only manifest.json and manifest.json.sig to R2 path models/speech/sets/${lock.packRevision}/`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(
    `[speech-models] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
