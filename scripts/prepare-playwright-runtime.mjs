import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, release } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..');
const resourceRoot = join(repoRoot, 'src-tauri', 'resources', 'playwright-browsers');
const playwrightRoot = join(repoRoot, 'node_modules', 'playwright');
const playwrightCoreRoot = join(repoRoot, 'node_modules', 'playwright-core');
const mcpRoot = join(repoRoot, 'node_modules', '@playwright', 'mcp');

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

export function targetTripleFromArgs(args, fallbackPlatform = platform(), fallbackArch = arch()) {
  const targetIndex = args.indexOf('--target');
  if (targetIndex >= 0 && args[targetIndex + 1]) return args[targetIndex + 1];
  const inline = args.find(value => value.startsWith('--target='));
  if (inline) return inline.slice('--target='.length);
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  if (fallbackPlatform === 'darwin') return `${fallbackArch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
  if (fallbackPlatform === 'win32') return `${fallbackArch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`;
  return `${fallbackArch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`;
}

function naturalMacPlatform(targetArch) {
  const darwinMajor = Number.parseInt(release().split('.')[0] ?? '', 10);
  if (!Number.isFinite(darwinMajor)) throw new Error('Cannot determine the macOS browser platform');
  const macMajor = Math.min(Math.max(darwinMajor - 9, 11), 15);
  return `mac${macMajor}${targetArch === 'arm64' ? '-arm64' : ''}`;
}

function currentPlaywrightHostPlatform() {
  const helper = join(playwrightCoreRoot, 'lib', 'server', 'utils', 'hostPlatform.js');
  // This is build-time inspection of the exact locked Playwright package. The
  // application never imports this private helper at runtime.
  return createRequire(import.meta.url)(helper).hostPlatform;
}

export function hostPlatformForTarget(targetTriple, currentHostPlatform = currentPlaywrightHostPlatform()) {
  const targetArch = targetTriple.startsWith('aarch64-') ? 'arm64' : 'x64';
  if (targetTriple.endsWith('-apple-darwin')) {
    if (platform() !== 'darwin') throw new Error('Playwright macOS browsers must be staged on macOS');
    return naturalMacPlatform(targetArch);
  }
  if (targetTriple.includes('windows')) {
    if (platform() !== 'win32') throw new Error('Playwright Windows browsers must be staged on Windows');
    if (targetArch !== 'x64') throw new Error('The locked Playwright runtime does not support Windows ARM browsers');
    return 'win64';
  }
  if (targetTriple.includes('linux')) {
    if (platform() !== 'linux') throw new Error('Playwright Linux browsers must be staged on Linux');
    if (!/^(ubuntu|debian)/.test(currentHostPlatform)) {
      throw new Error(`Unsupported Playwright Linux build host: ${currentHostPlatform}`);
    }
    return currentHostPlatform.replace(/-(?:x64|arm64)$/, `-${targetArch}`);
  }
  throw new Error(`Unsupported Playwright target: ${targetTriple}`);
}

export function expectedBrowserDirectories(browsersJson, hostPlatform) {
  return browsersJson.browsers
    .filter(browser => browser.installByDefault)
    .map(browser => {
      const override = browser.revisionOverrides?.[hostPlatform];
      const revision = override ?? browser.revision;
      const prefix = override ? `${browser.name}_${hostPlatform}_special` : browser.name;
      return `${prefix.replaceAll('-', '_')}-${revision}`;
    })
    .sort();
}

function expectedManifest(targetTriple, hostPlatform) {
  const playwright = readJson(join(playwrightRoot, 'package.json'));
  const playwrightCore = readJson(join(playwrightCoreRoot, 'package.json'));
  const mcp = readJson(join(mcpRoot, 'package.json'));
  const browsers = readJson(join(playwrightCoreRoot, 'browsers.json'));
  return {
    schemaVersion: 1,
    targetTriple,
    hostPlatform,
    playwrightVersion: playwright.version,
    playwrightCoreVersion: playwrightCore.version,
    playwrightMcpVersion: mcp.version,
    browserDirectories: expectedBrowserDirectories(browsers, hostPlatform),
  };
}

export function validatePreparedPlaywrightRuntime(root, expected) {
  if (!existsSync(join(root, 'manifest.json'))) return false;
  let actual;
  try {
    actual = readJson(join(root, 'manifest.json'));
  } catch {
    return false;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  if (!expected.browserDirectories.every(directory => existsSync(join(root, directory)))) return false;
  return [
    'playwright-LICENSE',
    'playwright-core-LICENSE',
    'playwright-core-NOTICE',
    'playwright-core-ThirdPartyNotices.txt',
    'playwright-mcp-LICENSE',
  ].every(file => existsSync(join(root, 'legal', file)));
}

function copyLegalFiles(stageRoot) {
  const legalRoot = join(stageRoot, 'legal');
  mkdirSync(legalRoot, { recursive: true });
  for (const [source, destination] of [
    [join(playwrightRoot, 'LICENSE'), 'playwright-LICENSE'],
    [join(playwrightCoreRoot, 'LICENSE'), 'playwright-core-LICENSE'],
    [join(playwrightCoreRoot, 'NOTICE'), 'playwright-core-NOTICE'],
    [join(playwrightCoreRoot, 'ThirdPartyNotices.txt'), 'playwright-core-ThirdPartyNotices.txt'],
    [join(mcpRoot, 'LICENSE'), 'playwright-mcp-LICENSE'],
  ]) {
    copyFileSync(source, join(legalRoot, destination));
  }
}

export function preparePlaywrightRuntime(targetTriple = targetTripleFromArgs(process.argv.slice(2))) {
  for (const required of [playwrightRoot, playwrightCoreRoot, mcpRoot]) {
    if (!existsSync(required)) throw new Error(`Locked Playwright dependency is missing: ${required}`);
  }
  const hostPlatform = hostPlatformForTarget(targetTriple);
  const expected = expectedManifest(targetTriple, hostPlatform);
  if (validatePreparedPlaywrightRuntime(resourceRoot, expected)) {
    console.log(`[playwright-runtime] ready target=${targetTriple} platform=${hostPlatform}`);
    return expected;
  }

  mkdirSync(dirname(resourceRoot), { recursive: true });
  const token = `${process.pid}-${Date.now()}`;
  const stageRoot = `${resourceRoot}.staging-${token}`;
  const backupRoot = `${resourceRoot}.backup-${token}`;
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  try {
    const install = spawnSync(
      process.execPath,
      [join(playwrightRoot, 'cli.js'), 'install', 'chromium', 'firefox', 'webkit'],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: stageRoot,
          PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: hostPlatform,
        },
      },
    );
    if (install.status !== 0) {
      throw new Error(`Playwright browser installation failed with status ${install.status ?? 'unknown'}`);
    }
    copyLegalFiles(stageRoot);
    writeFileSync(join(stageRoot, 'manifest.json'), `${JSON.stringify(expected, null, 2)}\n`);
    if (!validatePreparedPlaywrightRuntime(stageRoot, expected)) {
      throw new Error('Prepared Playwright browser runtime failed exact-version validation');
    }
    if (existsSync(resourceRoot)) renameSync(resourceRoot, backupRoot);
    renameSync(stageRoot, resourceRoot);
    rmSync(backupRoot, { recursive: true, force: true });
    console.log(
      `[playwright-runtime] staged target=${targetTriple} platform=${hostPlatform}`
        + ` browsers=${expected.browserDirectories.map(basename).join(',')}`,
    );
    return expected;
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    if (!existsSync(resourceRoot) && existsSync(backupRoot)) renameSync(backupRoot, resourceRoot);
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  preparePlaywrightRuntime();
}
