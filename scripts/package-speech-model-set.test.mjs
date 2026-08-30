import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const packager = join(repoRoot, "scripts/package-speech-model-set.mjs");
const publisher = join(repoRoot, "publish_speech_model_set.sh");
const sourceLockPath = join(
  repoRoot,
  "src-tauri/media-worker/model-pack-source-lock.json",
);
const originLockPath = join(
  repoRoot,
  "src-tauri/media-worker/model-pack-mirror-origin-lock.json",
);

function writeExecutable(path, contents) {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function createPublisherFixture() {
  const root = mkdtempSync(join(tmpdir(), "myagents-speech-publisher-"));
  const fakeBin = join(root, "fake-bin");
  const remoteDir = join(root, "remote");
  const rcloneLog = join(root, "rclone.log");
  const eventLog = join(root, "events.log");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src-tauri", "media-worker"), { recursive: true });
  mkdirSync(fakeBin);
  mkdirSync(remoteDir);
  cpSync(publisher, join(root, "publish_speech_model_set.sh"));
  chmodSync(join(root, "publish_speech_model_set.sh"), 0o755);
  cpSync(packager, join(root, "scripts", "package-speech-model-set.mjs"));
  cpSync(
    join(repoRoot, "scripts", "package-managed-codex-spawn.js"),
    join(root, "scripts", "package-managed-codex-spawn.js"),
  );
  cpSync(
    sourceLockPath,
    join(root, "src-tauri", "media-worker", "model-pack-source-lock.json"),
  );
  cpSync(
    originLockPath,
    join(
      root,
      "src-tauri",
      "media-worker",
      "model-pack-mirror-origin-lock.json",
    ),
  );
  cpSync(
    join(repoRoot, "src-tauri", "tauri.conf.json"),
    join(root, "src-tauri", "tauri.conf.json"),
  );
  writeFileSync(
    join(root, ".env"),
    [
      "TAURI_SIGNING_PRIVATE_KEY=dummy-test-key",
      "R2_ACCESS_KEY_ID=dummy-access-key",
      "R2_SECRET_ACCESS_KEY=dummy-secret-key",
      "R2_ACCOUNT_ID=dummy-account",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "scripts", "prepare-speech-model-mirror.mjs"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const outIndex = process.argv.indexOf("--out");
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error("missing --out");
const outDir = process.argv[outIndex + 1];
const entries = Array.from({ length: 7 }, (_, index) => {
  const digest = String(index + 1).repeat(64);
  const remotePath = \`models/speech/assets/sha256/\${digest}/source-\${index}.bin\`;
  const localRelativePath = \`mirror/\${remotePath}\`;
  const destination = join(outDir, localRelativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, \`source-\${index}\`);
  return {
    id: \`asset:fixture-\${index}\`,
    publicUrl: \`https://download.myagents.io/\${remotePath}\`,
    remotePath,
    localRelativePath,
  };
});
writeFileSync(
  join(outDir, "mirror-plan.json"),
  JSON.stringify({ schemaVersion: 1, entries }),
);
`,
  );
  writeExecutable(
    join(fakeBin, "npx"),
    `#!/bin/sh
manifest=""
for argument in "$@"; do manifest="$argument"; done
if [ "\${FAKE_SIGNING_VALID:-1}" = "1" ]; then
  signature="ZmFrZS12YWxpZA=="
else
  signature="ZmFrZS1pbnZhbGlk"
fi
printf 'sign\n' >> "\${FAKE_EVENT_LOG}"
printf '%s' "$signature" > "\${manifest}.sig"
`,
  );
  writeExecutable(
    join(fakeBin, "minisign"),
    `#!/bin/sh
signature=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-x" ]; then
    shift
    signature="$1"
  fi
  shift
done
grep -q 'fake-valid' "$signature"
`,
  );
  writeExecutable(
    join(fakeBin, "curl"),
    `#!/bin/sh
head_request=0
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -I) head_request=1 ;;
    -o) shift; output="$1" ;;
    -w) shift ;;
    http*) url="$1" ;;
  esac
  shift
done
relative="\${url#https://download.myagents.io/}"
remote="\${FAKE_REMOTE_DIR}/\${relative}"
if [ "$head_request" -eq 1 ]; then
  if [ -f "$remote" ]; then printf '200'; else printf '404'; fi
  exit 0
fi
if [ ! -f "$remote" ]; then exit 22; fi
cp "$remote" "$output"
`,
  );
  writeExecutable(
    join(fakeBin, "rclone"),
    `#!/bin/sh
previous=""
current=""
for argument in "$@"; do
  previous="$current"
  current="$argument"
done
source_path="$previous"
relative="\${current#r2:myagents-releases/}"
destination="\${FAKE_REMOTE_DIR}/\${relative}"
mkdir -p "\${destination%/*}"
cp "$source_path" "$destination"
printf '%s\n' "$relative" >> "$FAKE_RCLONE_LOG"
printf 'upload:%s\n' "$relative" >> "$FAKE_EVENT_LOG"
`,
  );
  const sourceLock = JSON.parse(readFileSync(sourceLockPath, "utf8"));
  return {
    root,
    fakeBin,
    remoteDir,
    rcloneLog,
    eventLog,
    packRevision: sourceLock.packRevision,
  };
}

function runPublisher(fixture, extraEnv = {}) {
  return spawnSync(
    "bash",
    [join(fixture.root, "publish_speech_model_set.sh"), "-y"],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:${process.env.PATH}`,
        CF_ZONE_ID: "",
        CF_API_TOKEN: "",
        FAKE_REMOTE_DIR: fixture.remoteDir,
        FAKE_RCLONE_LOG: fixture.rcloneLog,
        FAKE_EVENT_LOG: fixture.eventLog,
        ...extraEnv,
      },
    },
  );
}

test("speech model packager publishes the exact compiled source-lock bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "myagents-speech-model-package-"));
  try {
    execFileSync(
      process.execPath,
      [packager, "--out", root, "--allow-unsigned"],
      {
        cwd: repoRoot,
        stdio: "pipe",
      },
    );
    const sourceBytes = readFileSync(sourceLockPath);
    const source = JSON.parse(sourceBytes.toString("utf8"));
    const manifestPath = join(
      root,
      "sets",
      source.packRevision,
      "manifest.json",
    );
    assert.deepEqual(readFileSync(manifestPath), sourceBytes);
    assert.equal(existsSync(`${manifestPath}.sig`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("speech model packager requires the existing updater signing key for release output", () => {
  const root = mkdtempSync(join(tmpdir(), "myagents-speech-model-signing-"));
  try {
    const env = { ...process.env };
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_PRIVATE_KEY;
    const result = spawnSync(process.execPath, [packager, "--out", root], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /TAURI_SIGNING_PRIVATE_KEY is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "speech model packager rejects a symlinked publication directory",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "myagents-speech-model-symlink-"));
    const external = mkdtempSync(
      join(tmpdir(), "myagents-speech-model-external-"),
    );
    try {
      symlinkSync(external, join(root, "sets"), "dir");
      const result = spawnSync(
        process.execPath,
        [packager, "--out", root, "--allow-unsigned"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be a real directory/);
      assert.deepEqual(readdirSync(external), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  },
);

test("speech model publisher prepares mirrored sources before the signed manifest", () => {
  const source = readFileSync(publisher, "utf8");
  assert.match(source, /scripts\/package-speech-model-set\.mjs/);
  assert.match(source, /scripts\/prepare-speech-model-mirror\.mjs/);
  assert.match(source, /models\/speech\/sets\/\$\{PACK_REVISION\}/);
  assert.match(source, /cmp -s "\$SOURCE_LOCK" "\$MANIFEST_PATH"/);
  assert.match(source, /--progress --immutable/);
  assert.match(source, /copyto "\$MANIFEST_PATH"/);
  assert.match(source, /copyto "\$SIGNATURE_PATH"/);
  assert.match(source, /minisign -Vm "\$MANIFEST_PATH"/);
  assert.doesNotMatch(source, /force-republish/);
  assert.match(source, /immutable remote manifest differs/);
  assert.match(
    source,
    /published manifest bytes do not match the compiled source lock/,
  );
  assert.match(source, /published signature does not match/);
});

test(
  "speech model publisher uploads seven sources before the two manifest objects",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createPublisherFixture();
    try {
      const result = runPublisher(fixture);
      assert.equal(result.status, 0, result.stderr);
      const uploads = readFileSync(fixture.rcloneLog, "utf8")
        .trim()
        .split("\n");
      assert.equal(uploads.length, 9);
      assert.deepEqual(
        uploads.slice(0, 7),
        Array.from({ length: 7 }, (_, index) => {
          const digest = String(index + 1).repeat(64);
          return `models/speech/assets/sha256/${digest}/source-${index}.bin`;
        }),
      );
      assert.deepEqual(uploads.slice(7), [
        `models/speech/sets/${fixture.packRevision}/manifest.json`,
        `models/speech/sets/${fixture.packRevision}/manifest.json.sig`,
      ]);
      assert.deepEqual(
        readFileSync(fixture.eventLog, "utf8").trim().split("\n"),
        [
          ...uploads.slice(0, 7).map((path) => `upload:${path}`),
          "sign",
          ...uploads.slice(7).map((path) => `upload:${path}`),
        ],
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "speech model publisher rejects a signer outside the updater trust root",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createPublisherFixture();
    try {
      const result = runPublisher(fixture, { FAKE_SIGNING_VALID: "0" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not match the App updater public key/);
      const uploads = readFileSync(fixture.rcloneLog, "utf8")
        .trim()
        .split("\n");
      assert.equal(uploads.length, 7);
      assert.doesNotMatch(uploads.join("\n"), /models\/speech\/sets\//);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "speech model publisher refuses an existing manifest with different bytes",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createPublisherFixture();
    try {
      const manifestPath = join(
        fixture.remoteDir,
        "models",
        "speech",
        "sets",
        fixture.packRevision,
        "manifest.json",
      );
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, "different\n");
      const result = runPublisher(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /immutable remote manifest differs/);
      assert.equal(existsSync(fixture.rcloneLog), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "speech model publisher refuses an existing content-addressed source with different bytes",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createPublisherFixture();
    try {
      const remotePath = join(
        fixture.remoteDir,
        "models",
        "speech",
        "assets",
        "sha256",
        "1".repeat(64),
        "source-0.bin",
      );
      mkdirSync(dirname(remotePath), { recursive: true });
      writeFileSync(remotePath, "different\n");
      const result = runPublisher(fixture);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /immutable remote speech model source differs/,
      );
      assert.equal(existsSync(fixture.rcloneLog), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);
