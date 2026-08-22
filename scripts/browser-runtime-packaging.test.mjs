import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertNoNonChromiumBrowser, listFiles, readAndValidateBrowserRuntimeLock, stageDownloadedRuntime, targetLayout } from './package-browser-runtime.mjs';

const repoRoot = new URL('..', import.meta.url).pathname;

test('Browser runtime packaging is pinned to the installed Playwright dependency graph', () => {
  const lock = readAndValidateBrowserRuntimeLock();
  assert.equal(lock.playwrightMcpVersion, '0.0.68');
  assert.equal(lock.chromiumRevision, '1212');
  assert.match(lock.runtimeSet, /^playwright-.+-chromium-1212$/);
});

test('every supported target declares only the headed Chromium executable', () => {
  const lock = readAndValidateBrowserRuntimeLock();
  for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']) {
    const layout = targetLayout(platform, lock);
    assert.match(layout.executableRelativePath, /^chromium-/);
    assert.doesNotThrow(() => assertNoNonChromiumBrowser(Object.values(layout)));
  }
  assert.throws(() => assertNoNonChromiumBrowser(['webkit-2259/pw_run.sh']), /non-Chromium/);
});

test('release staging copies each locked Chromium component exactly once', (t) => {
  const lock = readAndValidateBrowserRuntimeLock();
  const root = mkdtempSync(join(tmpdir(), 'myagents-browser-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const downloadRoot = join(root, 'download');
  const packageRoot = join(root, 'package');
  mkdirSync(packageRoot, { recursive: true });
  for (const [directory, file] of [[`chromium-${lock.chromiumRevision}`, 'chrome']]) {
    mkdirSync(join(downloadRoot, directory), { recursive: true });
    writeFileSync(join(downloadRoot, directory, file), directory);
  }

  stageDownloadedRuntime(downloadRoot, packageRoot, lock);
  const files = listFiles(packageRoot);
  assert.equal(files.filter((path) => path.startsWith(`chromium-${lock.chromiumRevision}/`)).length, 1);
  assert.equal(
    files.some((path) => path.startsWith('chromium_headless_shell-')),
    false,
  );
  assert.equal(
    files.some((path) => path.startsWith('ffmpeg-')),
    false,
  );
  assert.deepEqual(
    files.filter((path) => path.startsWith('PLAYWRIGHT_')),
    ['PLAYWRIGHT_LICENSE.txt', 'PLAYWRIGHT_NOTICE.txt', 'PLAYWRIGHT_THIRD_PARTY_NOTICES.txt'],
  );
});

test('normal app builds cannot invoke the release-only Browser packager', () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(readFileSync(join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  const releaseWorkflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  assert.equal(packageJson.scripts['tauri:build'], 'tauri build');
  assert.equal(packageJson.scripts['tauri:dev'], 'npm run prepare:document-processing && tauri dev');
  assert.equal(packageJson.scripts['package:browser-runtime'], 'node scripts/package-browser-runtime.mjs');
  assert.doesNotMatch(packageJson.scripts['tauri:build'], /browser|playwright/i);
  assert.doesNotMatch(packageJson.scripts['tauri:dev'], /browser|playwright/i);
  assert.equal(
    Object.keys(tauriConfig.bundle.resources).some((path) => /browser|playwright/i.test(path)),
    false,
  );
  assert.doesNotMatch(releaseWorkflow, /prepare-playwright-runtime|playwright-browsers/);
  assert.equal(existsSync(join(repoRoot, 'scripts/prepare-playwright-runtime.mjs')), false);
  assert.equal(existsSync(join(repoRoot, 'scripts/tauri-build.mjs')), false);
});
