import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SHERPA_BUILD_MEMBERS = Object.freeze([
  'CMakeLists.txt',
  'LICENSE',
  'cmake',
  'sherpa-onnx',
]);

function requireEntry(path, kind) {
  const metadata = lstatSync(path);
  const valid =
    !metadata.isSymbolicLink() &&
    (kind === 'file' ? metadata.isFile() : metadata.isDirectory());
  if (!valid) {
    throw new Error(`Sherpa build source ${kind} is unavailable: ${path}`);
  }
}

export function extractSherpaBuildSource({
  archive,
  destination,
  archiveRoot,
  runTar = execFileSync,
}) {
  if (!/^[A-Za-z0-9._-]+$/.test(archiveRoot ?? '')) {
    throw new Error('Sherpa source lock has an invalid archive root');
  }
  requireEntry(archive, 'file');
  mkdirSync(destination, { recursive: true });
  runTar(
    'tar',
    [
      '-xf',
      archive,
      '-C',
      destination,
      ...SHERPA_BUILD_MEMBERS.map((member) => `${archiveRoot}/${member}`),
    ],
    { stdio: 'inherit' },
  );

  const sourceRoot = join(destination, archiveRoot);
  requireEntry(join(sourceRoot, 'CMakeLists.txt'), 'file');
  requireEntry(join(sourceRoot, 'LICENSE'), 'file');
  requireEntry(join(sourceRoot, 'cmake'), 'directory');
  requireEntry(join(sourceRoot, 'sherpa-onnx'), 'directory');
  requireEntry(join(sourceRoot, 'sherpa-onnx', 'CMakeLists.txt'), 'file');
  return sourceRoot;
}
