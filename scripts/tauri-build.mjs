import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  preparePlaywrightRuntime,
  targetTripleFromArgs,
} from './prepare-playwright-runtime.mjs';

const args = process.argv.slice(2);
preparePlaywrightRuntime(targetTripleFromArgs(args));
const result = spawnSync(
  process.execPath,
  [resolve(import.meta.dirname, '..', 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'build', ...args],
  { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit', env: process.env },
);
process.exit(result.status ?? 1);
