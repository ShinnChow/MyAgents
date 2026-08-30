import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { buildMirrorPlan } from "./prepare-speech-model-mirror.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const sourceLock = JSON.parse(
  readFileSync(
    resolve(repoRoot, "src-tauri/media-worker/model-pack-source-lock.json"),
    "utf8",
  ),
);
const originLock = JSON.parse(
  readFileSync(
    resolve(
      repoRoot,
      "src-tauri/media-worker/model-pack-mirror-origin-lock.json",
    ),
    "utf8",
  ),
);

test("speech mirror plan joins all runtime sources to content-addressed first-party URLs", () => {
  const plan = buildMirrorPlan(sourceLock, originLock);
  assert.equal(plan.packRevision, "local-standard-speech-v2");
  assert.equal(plan.entries.length, 7);
  assert.equal(
    plan.entries.reduce((total, entry) => total + entry.size, 0),
    209_785_686,
  );
  assert.equal(new Set(plan.entries.map((entry) => entry.id)).size, 7);
  assert.equal(new Set(plan.entries.map((entry) => entry.remotePath)).size, 7);
  for (const entry of plan.entries) {
    assert.equal(new URL(entry.publicUrl).hostname, "download.myagents.io");
    assert.equal(
      entry.publicUrl,
      `https://download.myagents.io/${entry.remotePath}`,
    );
    assert.match(entry.remotePath, new RegExp(`/sha256/${entry.sha256}/`));
    assert.ok(
      ["github.com", "raw.githubusercontent.com"].includes(
        new URL(entry.originUrl).hostname,
      ),
    );
  }
});

test("speech mirror plan rejects missing, extra, or duplicate origins", () => {
  const missing = structuredClone(originLock);
  missing.sources.pop();
  assert.throws(
    () => buildMirrorPlan(sourceLock, missing),
    /origin is missing/,
  );

  const extra = structuredClone(originLock);
  extra.sources.push({ id: "legal:unused", url: extra.sources[0].url });
  assert.throws(() => buildMirrorPlan(sourceLock, extra), /unused sources/);

  const duplicate = structuredClone(originLock);
  duplicate.sources.push(structuredClone(duplicate.sources[0]));
  assert.throws(
    () => buildMirrorPlan(sourceLock, duplicate),
    /duplicate source/,
  );
});

test("speech mirror plan rejects public hash drift and untrusted origins", () => {
  const publicDrift = structuredClone(sourceLock);
  publicDrift.assets[0].url = publicDrift.assets[0].url.replace(
    publicDrift.assets[0].sha256,
    publicDrift.assets[1].sha256,
  );
  assert.throws(
    () => buildMirrorPlan(publicDrift, originLock),
    /public URL mismatch/,
  );

  const originDrift = structuredClone(originLock);
  originDrift.sources[0].url = "https://example.com/model.tar.bz2";
  assert.throws(
    () => buildMirrorPlan(sourceLock, originDrift),
    /Unsupported speech mirror origin/,
  );
});
