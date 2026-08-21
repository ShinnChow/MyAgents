import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  expectedBrowserDirectories,
  targetTripleFromArgs,
  validatePreparedPlaywrightRuntime,
} from './prepare-playwright-runtime.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

test('Tauri packaging routes every build through exact browser staging', () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const wrapper = readFileSync(join(repoRoot, 'scripts', 'tauri-build.mjs'), 'utf8');
  assert.equal(packageJson.scripts['tauri:build'], 'node scripts/tauri-build.mjs');
  assert.equal(
    tauriConfig.bundle.resources['../src-tauri/resources/playwright-browsers'],
    'playwright-browsers',
  );
  assert.match(wrapper, /preparePlaywrightRuntime\(targetTripleFromArgs\(args\)\)/);
  assert.ok(existsSync(join(repoRoot, 'src-tauri', 'resources', 'playwright-browsers')));
});

test('Tauri target parsing keeps browser staging target-scoped', () => {
  assert.equal(
    targetTripleFromArgs(['--debug', '--target', 'x86_64-apple-darwin'], 'darwin', 'arm64'),
    'x86_64-apple-darwin',
  );
  assert.equal(
    targetTripleFromArgs(['--target=aarch64-apple-darwin'], 'darwin', 'x64'),
    'aarch64-apple-darwin',
  );
});

test('browser directory contract includes every locked default and revision override', () => {
  const directories = expectedBrowserDirectories({
    browsers: [
      { name: 'chromium', revision: '1', installByDefault: true },
      { name: 'chromium-headless-shell', revision: '2', installByDefault: true },
      { name: 'webkit', revision: '3', revisionOverrides: { 'mac14-arm64': '4' }, installByDefault: true },
      { name: 'optional', revision: '5', installByDefault: false },
    ],
  }, 'mac14-arm64');
  assert.deepEqual(directories, [
    'chromium-1',
    'chromium_headless_shell-2',
    'webkit_mac14_arm64_special-4',
  ]);
});

test('prepared runtime validation rejects partial browser or legal projections', t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-pw-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const expected = {
    schemaVersion: 1,
    targetTriple: 'x86_64-unknown-linux-gnu',
    hostPlatform: 'ubuntu24.04-x64',
    playwrightVersion: '1',
    playwrightCoreVersion: '1',
    playwrightMcpVersion: '1',
    browserDirectories: ['chromium-1'],
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(expected));
  assert.equal(validatePreparedPlaywrightRuntime(root, expected), false);
  mkdirSync(join(root, 'chromium-1'));
  mkdirSync(join(root, 'legal'));
  for (const file of [
    'playwright-LICENSE',
    'playwright-core-LICENSE',
    'playwright-core-NOTICE',
    'playwright-core-ThirdPartyNotices.txt',
    'playwright-mcp-LICENSE',
  ]) writeFileSync(join(root, 'legal', file), 'notice');
  assert.equal(validatePreparedPlaywrightRuntime(root, expected), true);
});
