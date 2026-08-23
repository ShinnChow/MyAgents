import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('..', import.meta.url).pathname;
const lock = JSON.parse(readFileSync(join(repoRoot, 'src/shared/managed-browser-runtime.json'), 'utf8'));
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const mcpPackage = JSON.parse(readFileSync(join(repoRoot, 'node_modules/@playwright/mcp/package.json'), 'utf8'));
const playwrightPackage = JSON.parse(readFileSync(join(repoRoot, 'node_modules/playwright/package.json'), 'utf8'));
const corePackage = JSON.parse(readFileSync(join(repoRoot, 'node_modules/playwright-core/package.json'), 'utf8'));
const browsers = JSON.parse(readFileSync(join(repoRoot, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers;
const chromium = browsers.find((browser) => browser.name === 'chromium');

test('Browser runtime lock is pinned to the installed Playwright dependency graph', () => {
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.playwrightMcpVersion, mcpPackage.version);
  assert.equal(lock.playwrightCoreVersion, corePackage.version);
  assert.equal(mcpPackage.dependencies?.['playwright-core'], corePackage.version);
  assert.equal(lock.chromiumRevision, chromium.revision);
  assert.equal(lock.chromiumBrowserVersion, chromium.browserVersion);
  assert.equal(lock.runtimeSet, `playwright-${corePackage.version}-chromium-${chromium.revision}`);
});

test('Browser Host owns every Playwright package it imports directly', () => {
  assert.equal(rootPackage.dependencies?.['@playwright/mcp'], mcpPackage.version);
  assert.equal(rootPackage.dependencies?.playwright, playwrightPackage.version);
  assert.equal(mcpPackage.dependencies?.playwright, playwrightPackage.version);
});

test('Windows build entrypoints reconcile root dependencies before typecheck', () => {
  for (const relativePath of ['build_windows.ps1', 'build_dev_win.ps1']) {
    const script = readFileSync(join(repoRoot, relativePath), 'utf8');
    const installIndex = script.indexOf('npm install --no-audit --no-fund');
    const typecheckIndex = script.indexOf('npm run typecheck');
    assert.ok(installIndex >= 0, `${relativePath} must reconcile root dependencies`);
    assert.ok(typecheckIndex > installIndex, `${relativePath} must install before typecheck`);
  }
});

test('every supported target pins one official headed Chromium artifact', () => {
  const expected = {
    'darwin-arm64': ['mac-arm64/chrome-mac-arm64.zip', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    'darwin-x64': ['mac-x64/chrome-mac-x64.zip', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    'win32-x64': ['win64/chrome-win64.zip', 'chrome-win64/chrome.exe'],
    'linux-x64': ['linux64/chrome-linux64.zip', 'chrome-linux64/chrome'],
    'linux-arm64': [`builds/chromium/${chromium.revision}/chromium-linux-arm64.zip`, 'chrome-linux/chrome'],
  };
  assert.deepEqual(Object.keys(lock.officialArtifacts).sort(), Object.keys(expected).sort());
  for (const [platform, artifact] of Object.entries(lock.officialArtifacts)) {
    assert.ok(artifact.sourceUrl.startsWith('https://cdn.playwright.dev/'));
    assert.ok(artifact.sourceUrl.endsWith(expected[platform][0]));
    assert.match(artifact.url, /^https:\/\/(storage\.googleapis\.com\/chrome-for-testing-public\/|playwright\.download\.prss\.microsoft\.com\/|cdn\.playwright\.dev\/builds\/chromium\/)/);
    assert.ok(artifact.url.endsWith(expected[platform][0]));
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(artifact.archiveSizeBytes > 100 * 1024 * 1024);
    assert.ok(artifact.archiveSizeBytes < 512 * 1024 * 1024);
    assert.ok(artifact.unpackedSizeBytes > artifact.archiveSizeBytes);
    assert.ok(artifact.unpackedSizeBytes < 1024 * 1024 * 1024);
    assert.ok(artifact.entryCount > 0 && artifact.entryCount < 6000);
    assert.equal(artifact.executableRelativePath, expected[platform][1]);
    assert.ok(artifact.executableRelativePath.startsWith(`${artifact.archiveRoot}/`));
    assert.doesNotMatch(`${artifact.sourceUrl}\n${artifact.url}\n${artifact.executableRelativePath}`, /firefox|webkit|headless-shell|ffmpeg|winldd/i);
  }
});

test('Browser resources have no build-time packager or Tauri bundle entry', () => {
  const tauriConfig = JSON.parse(readFileSync(join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  const releaseWorkflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  assert.equal(rootPackage.scripts['package:browser-runtime'], undefined);
  assert.equal(existsSync(join(repoRoot, 'scripts/package-browser-runtime.mjs')), false);
  assert.doesNotMatch(rootPackage.scripts['tauri:build'], /browser|playwright/i);
  assert.doesNotMatch(rootPackage.scripts['tauri:dev'], /browser|playwright/i);
  assert.equal(Object.keys(tauriConfig.bundle.resources).some((path) => /browser|playwright/i.test(path)), false);
  assert.doesNotMatch(releaseWorkflow, /prepare-playwright-runtime|playwright-browsers|package:browser-runtime/);
});
