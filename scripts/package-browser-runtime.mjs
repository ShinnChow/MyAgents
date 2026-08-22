#!/usr/bin/env node

import AdmZip from 'adm-zip';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'src/shared/managed-browser-runtime.json');
const PLAYWRIGHT_CORE_ROOT = join(REPO_ROOT, 'node_modules/playwright-core');
const MCP_PACKAGE_PATH = join(REPO_ROOT, 'node_modules/@playwright/mcp/package.json');
const CORE_PACKAGE_PATH = join(PLAYWRIGHT_CORE_ROOT, 'package.json');
const BROWSERS_PATH = join(PLAYWRIGHT_CORE_ROOT, 'browsers.json');
const PLAYWRIGHT_CLI = join(PLAYWRIGHT_CORE_ROOT, 'cli.js');
const DEFAULT_BASE_URL = 'https://download.myagents.io/runtimes/browser/sets';
const SUPPORTED_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readAndValidateBrowserRuntimeLock() {
  const lock = readJson(LOCK_PATH);
  const mcpPackage = readJson(MCP_PACKAGE_PATH);
  const corePackage = readJson(CORE_PACKAGE_PATH);
  const browsers = readJson(BROWSERS_PATH).browsers;
  const chromium = browsers.find((browser) => browser.name === 'chromium');
  const expectedRuntimeSet = `playwright-${corePackage.version}-chromium-${chromium?.revision}`;
  const assertions = [
    [lock.schemaVersion === 1, 'schemaVersion'],
    [lock.playwrightMcpVersion === mcpPackage.version, 'playwrightMcpVersion'],
    [lock.playwrightCoreVersion === corePackage.version, 'playwrightCoreVersion'],
    [mcpPackage.dependencies?.['playwright-core'] === corePackage.version, 'MCP playwright-core dependency'],
    [lock.chromiumRevision === chromium?.revision, 'chromiumRevision'],
    [lock.chromiumBrowserVersion === chromium?.browserVersion, 'chromiumBrowserVersion'],
    [chromium?.installByDefault === true, 'Chromium default install contract'],
    [lock.runtimeSet === expectedRuntimeSet, 'runtimeSet'],
  ];
  const mismatch = assertions.find(([valid]) => !valid);
  if (mismatch) throw new Error(`Browser runtime lock mismatch: ${mismatch[1]}`);
  return lock;
}

export function defaultPlatformForHost() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  throw new Error(`Unsupported Browser runtime packaging host: ${process.platform}-${process.arch}`);
}

export function targetLayout(platform, lock) {
  const chromium = `chromium-${lock.chromiumRevision}`;
  const layouts = {
    'darwin-arm64': {
      hostOverride: 'mac15-arm64',
      executableRelativePath: `${chromium}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    },
    'darwin-x64': {
      hostOverride: 'mac15',
      executableRelativePath: `${chromium}/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    },
    'win32-x64': {
      hostOverride: 'win64',
      executableRelativePath: `${chromium}/chrome-win64/chrome.exe`,
    },
    'linux-x64': {
      hostOverride: 'ubuntu24.04-x64',
      executableRelativePath: `${chromium}/chrome-linux64/chrome`,
    },
    'linux-arm64': {
      hostOverride: 'ubuntu24.04-arm64',
      executableRelativePath: `${chromium}/chrome-linux/chrome`,
    },
  };
  const layout = layouts[platform];
  if (!layout) throw new Error(`Unsupported Browser runtime platform: ${platform}`);
  return layout;
}

function parseArgs(argv) {
  const args = {
    platform: defaultPlatformForHost(),
    outDir: resolve(REPO_ROOT, 'dist/browser-runtime'),
    baseUrl: DEFAULT_BASE_URL,
    allowUnsigned: false,
  };
  const value = (index, option) => {
    const candidate = argv[index + 1];
    if (!candidate || candidate.startsWith('--')) throw new Error(`${option} requires a value`);
    return candidate;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--platform') args.platform = value(index++, arg);
    else if (arg === '--out') args.outDir = resolve(value(index++, arg));
    else if (arg === '--base-url') args.baseUrl = value(index++, arg).replace(/\/$/, '');
    else if (arg === '--allow-unsigned') args.allowUnsigned = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!SUPPORTED_PLATFORMS.has(args.platform)) {
    throw new Error(`Unsupported Browser runtime platform: ${args.platform}`);
  }
  if (!args.baseUrl.startsWith('https://download.myagents.io/runtimes/browser/sets')) {
    throw new Error('Browser runtime base URL must use the first-party runtime origin');
  }
  if (!args.allowUnsigned) {
    const hostFamily = defaultPlatformForHost().split('-')[0];
    const targetFamily = args.platform.split('-')[0];
    if (hostFamily !== targetFamily) {
      throw new Error(`Signed ${args.platform} resources must be packaged on the matching OS family`);
    }
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${basename(command)} ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

export function listFiles(root) {
  const files = [];
  const queue = [''];
  while (queue.length > 0) {
    const relativeDirectory = queue.shift();
    const directory = join(root, relativeDirectory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = join(relativeDirectory, entry.name).split('\\').join('/');
      if (entry.isSymbolicLink()) {
        throw new Error(`Browser runtime contains a forbidden symlink: ${relativePath}`);
      }
      if (entry.isDirectory()) queue.push(relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`Browser runtime contains a special file: ${relativePath}`);
    }
  }
  files.sort();
  return files;
}

function archiveDirectory(root, archivePath, fileAllowlist) {
  const zip = new AdmZip();
  for (const relativePath of fileAllowlist) {
    const absolutePath = join(root, relativePath);
    zip.addFile(relativePath, readFileSync(absolutePath));
    const entry = zip.getEntry(relativePath);
    entry.header.time = new Date('2000-01-01T00:00:00.000Z');
    entry.attr = lstatSync(absolutePath).mode << 16;
  }
  mkdirSync(dirname(archivePath), { recursive: true });
  zip.writeZip(archivePath);
  const verified = new AdmZip(archivePath).getEntries();
  return {
    archiveSizeBytes: statSync(archivePath).size,
    unpackedSizeBytes: verified.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.header.size), 0),
    entryCount: verified.length,
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function signFile(path, allowUnsigned, label) {
  if (allowUnsigned) return '';
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!key) throw new Error(`TAURI_SIGNING_PRIVATE_KEY is required to sign Browser ${label}`);
  const keyPath = join(tmpdir(), `myagents-browser-key-${randomUUID()}`);
  writeFileSync(keyPath, key);
  chmodSync(keyPath, 0o600);
  try {
    const env = { ...process.env };
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_PRIVATE_KEY;
    if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
      env.TAURI_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
    }
    run('npx', ['tauri', 'signer', 'sign', '-f', keyPath, path], {
      env,
      stdio: 'inherit',
    });
  } finally {
    rmSync(keyPath, { force: true });
  }
  const signaturePath = `${path}.sig`;
  if (!existsSync(signaturePath)) throw new Error(`tauri signer did not create ${signaturePath}`);
  return readFileSync(signaturePath, 'utf8').trim();
}

function macSigning(executable) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', executable]);
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', executable], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('codesign details failed');
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const teamId = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const signingIdentity = details.match(/^Authority=(.+)$/m)?.[1]?.trim();
  if (!teamId || !signingIdentity) throw new Error('Chromium codesign identity is incomplete');
  return { type: 'codesign', teamId, signingIdentity };
}

function windowsSigning(executable) {
  const encodedPath = Buffer.from(executable, 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    '$sig = Get-AuthenticodeSignature -LiteralPath $path',
    'if ([string]$sig.Status -ne \'Valid\') { throw "Authenticode status: $($sig.Status)" }',
    '$cert = $sig.SignerCertificate',
    "$sha = [BitConverter]::ToString($cert.GetCertHash('SHA256')).Replace('-', '').ToLowerInvariant()",
    '[ordered]@{ publisher = [string]$cert.Subject; certificateSha256 = $sha } | ConvertTo-Json -Compress',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const parsed = JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]));
  if (!parsed.publisher || !/^[0-9a-f]{64}$/.test(parsed.certificateSha256 ?? '')) {
    throw new Error('Chromium Authenticode identity is incomplete');
  }
  return {
    type: 'authenticode',
    publisher: parsed.publisher,
    certificateSha256: parsed.certificateSha256,
  };
}

function platformSigning(platform, executable, allowUnsigned) {
  if (allowUnsigned || platform.startsWith('linux-')) return undefined;
  if (platform.startsWith('darwin-')) return macSigning(executable);
  if (platform === 'win32-x64') return windowsSigning(executable);
  throw new Error(`No Browser signature policy for ${platform}`);
}

export function stageDownloadedRuntime(downloadRoot, packageRoot, lock) {
  const directories = [`chromium-${lock.chromiumRevision}`];
  for (const directory of directories) {
    const source = join(downloadRoot, directory);
    if (!existsSync(source)) throw new Error(`Playwright did not install ${directory}`);
    cpSync(source, join(packageRoot, directory), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
    });
  }
  copyFileSync(join(PLAYWRIGHT_CORE_ROOT, 'LICENSE'), join(packageRoot, 'PLAYWRIGHT_LICENSE.txt'));
  copyFileSync(join(PLAYWRIGHT_CORE_ROOT, 'NOTICE'), join(packageRoot, 'PLAYWRIGHT_NOTICE.txt'));
  copyFileSync(join(PLAYWRIGHT_CORE_ROOT, 'ThirdPartyNotices.txt'), join(packageRoot, 'PLAYWRIGHT_THIRD_PARTY_NOTICES.txt'));
}

export function assertNoNonChromiumBrowser(fileAllowlist) {
  const forbidden = fileAllowlist.find((path) => /(^|\/)(firefox|webkit)([-_/]|$)/i.test(path));
  if (forbidden) throw new Error(`Browser runtime contains a non-Chromium engine: ${forbidden}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lock = readAndValidateBrowserRuntimeLock();
  const layout = targetLayout(args.platform, lock);
  const runtimeOut = join(args.outDir, 'sets', lock.runtimeSet, args.platform);
  rmSync(runtimeOut, { recursive: true, force: true });

  const scratch = mkdtempSync(join(tmpdir(), 'myagents-browser-runtime-'));
  try {
    const downloadRoot = join(scratch, 'playwright-download');
    const packageRoot = join(scratch, 'package');
    mkdirSync(downloadRoot, { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    console.log(`[browser-runtime] downloading locked Chromium resources for ${args.platform}`);
    run(process.execPath, [PLAYWRIGHT_CLI, 'install', 'chromium', '--no-shell'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: downloadRoot,
        PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: layout.hostOverride,
      },
    });
    stageDownloadedRuntime(downloadRoot, packageRoot, lock);

    if (!statSync(join(packageRoot, layout.executableRelativePath)).isFile()) {
      throw new Error(`Locked Browser component is missing: ${layout.executableRelativePath}`);
    }
    const fileAllowlist = listFiles(packageRoot);
    assertNoNonChromiumBrowser(fileAllowlist);
    const signing = platformSigning(args.platform, join(packageRoot, layout.executableRelativePath), args.allowUnsigned);
    const artifactName = `myagents-browser-${lock.runtimeSet}-${args.platform}.zip`;
    const artifactPath = join(runtimeOut, 'artifacts', artifactName);
    const archive = archiveDirectory(packageRoot, artifactPath, fileAllowlist);
    const digest = sha256(artifactPath);
    const artifactSignature = signFile(artifactPath, args.allowUnsigned, 'artifact');
    const artifactUrl = `${args.baseUrl}/${lock.runtimeSet}/${args.platform}/artifacts/${artifactName}`;
    const generatedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      runtimeSet: lock.runtimeSet,
      revision: lock.runtimeSet,
      playwrightMcpVersion: lock.playwrightMcpVersion,
      playwrightCoreVersion: lock.playwrightCoreVersion,
      chromiumRevision: lock.chromiumRevision,
      chromiumBrowserVersion: lock.chromiumBrowserVersion,
      platform: args.platform,
      generatedAt,
      licenses: ['PLAYWRIGHT_LICENSE.txt', 'PLAYWRIGHT_NOTICE.txt', 'PLAYWRIGHT_THIRD_PARTY_NOTICES.txt'],
      artifact: {
        url: artifactUrl,
        sha256: digest,
        signature: artifactSignature,
        ...(signing ? { signing } : {}),
        executableRelativePath: layout.executableRelativePath,
        fileAllowlist,
        ...archive,
      },
    };
    const manifestPath = join(runtimeOut, 'manifest-v1.json');
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestSignature = signFile(manifestPath, args.allowUnsigned, 'manifest');
    if (manifestSignature) writeFileSync(`${manifestPath}.sig`, `${manifestSignature}\n`);
    writeFileSync(
      join(runtimeOut, 'release-audit-v1.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runtimeSet: lock.runtimeSet,
          platform: args.platform,
          generatedAt,
          artifactName,
          sha256: digest,
          signing,
          fileAllowlistCount: fileAllowlist.length,
          ...archive,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`[browser-runtime] wrote ${manifestPath}`);
    console.log(`[browser-runtime] upload ${runtimeOut} to runtimes/browser/sets/${lock.runtimeSet}/${args.platform}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`[browser-runtime] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
