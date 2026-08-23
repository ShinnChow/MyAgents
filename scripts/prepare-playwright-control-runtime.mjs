import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const playwrightControlRoot = join(
  repoRoot,
  'src-tauri',
  'resources',
  'playwright-control',
);

const PACKAGES = [
  { source: ['@playwright', 'mcp'], destination: ['@playwright', 'mcp'] },
  { source: ['playwright'], destination: ['playwright'] },
  { source: ['playwright-core'], destination: ['playwright-core'] },
];
const NATIVE_LIBRARY = /\.(?:node|dylib|dll|so(?:\.\d+)*)$/i;

function walkFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

export function validatePlaywrightControlRuntime(root = playwrightControlRoot) {
  for (const pkg of PACKAGES) {
    const sourcePackage = JSON.parse(readFileSync(
      join(repoRoot, 'node_modules', ...pkg.source, 'package.json'),
      'utf8',
    ));
    const stagedPackage = JSON.parse(readFileSync(
      join(root, ...pkg.destination, 'package.json'),
      'utf8',
    ));
    if (sourcePackage.name !== stagedPackage.name || sourcePackage.version !== stagedPackage.version) {
      throw new Error(`Playwright control package drift: ${sourcePackage.name}`);
    }
  }

  const forbidden = walkFiles(root).filter(path => NATIVE_LIBRARY.test(basename(path)));
  if (forbidden.length > 0) {
    throw new Error(
      `Playwright control runtime contains native libraries:\n${forbidden
        .map(path => relative(root, path))
        .join('\n')}`,
    );
  }
  if (existsSync(join(root, 'playwright', '.local-browsers'))
    || existsSync(join(root, 'playwright-core', '.local-browsers'))) {
    throw new Error('Playwright control runtime must not contain browser artifacts');
  }
}

export function preparePlaywrightControlRuntime(root = playwrightControlRoot) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, '@playwright'), { recursive: true });
  for (const pkg of PACKAGES) {
    cpSync(
      join(repoRoot, 'node_modules', ...pkg.source),
      join(root, ...pkg.destination),
      { recursive: true },
    );
  }

  // Optional native file watchers are irrelevant to Browser Host and would
  // otherwise introduce an unsigned, host-architecture Mach-O into the App.
  rmSync(join(root, 'playwright', 'node_modules', 'fsevents'), {
    recursive: true,
    force: true,
  });
  validatePlaywrightControlRuntime(root);
  return root;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = preparePlaywrightControlRuntime();
  const size = walkFiles(root).reduce((total, path) => total + statSync(path).size, 0);
  console.log(`✓ Playwright control runtime → ${relative(repoRoot, root)} (${Math.ceil(size / 1024 / 1024)} MiB)`);
}
