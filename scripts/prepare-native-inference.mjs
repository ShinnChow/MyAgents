import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forwardedArgs = process.argv.slice(2);

for (const script of [
  'prepare-document-processing.mjs',
  'prepare-speech-inference.mjs',
]) {
  execFileSync(
    process.execPath,
    [join(projectRoot, 'scripts', script), ...forwardedArgs],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );
}
