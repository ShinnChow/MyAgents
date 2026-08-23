/**
 * Read a local package directory into the same immutable in-memory tree used
 * by remote Skill / Plugin packages.
 *
 * The source is never executed in place. Root and child entries are read with
 * lstat-based no-follow checks, bounded by the shared package limits, and
 * rechecked after reading so a normal concurrent edit fails instead of
 * silently producing a mixed snapshot.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SKILL_PACKAGE_LIMITS, type ExtractedTree } from './tarball-fetcher';

export class LocalTreeReadError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'LocalTreeReadError';
    this.statusCode = statusCode;
  }
}

export interface LocalTreeReadOptions {
  /** Skills fail closed; Plugins preserve their historical skip behavior. */
  symlinkPolicy?: 'reject' | 'skip';
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right;
}

function statIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
}

function readStableRegularFile(
  path: string,
  before: Stats,
  label: string,
  maxBytes: number,
): Buffer {
  let fd: number | undefined;
  try {
    // O_NOFOLLOW closes the file-level TOCTOU gap between lstat and read on
    // platforms that expose it. The identity checks remain required for
    // Windows parity and to detect path replacement around the open handle.
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!opened.isFile() || statIdentity(before) !== statIdentity(opened)) {
      throw new LocalTreeReadError(`本地来源在读取期间发生变化：${label}`, 409);
    }
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= maxBytes) {
      const capacity = Math.min(64 * 1024, maxBytes + 1 - bytesRead);
      if (capacity <= 0) break;
      const chunk = Buffer.allocUnsafe(capacity);
      const count = readSync(fd, chunk, 0, capacity, null);
      if (count === 0) break;
      chunks.push(count === capacity ? chunk : chunk.subarray(0, count));
      bytesRead += count;
    }
    if (bytesRead > maxBytes) {
      throw new LocalTreeReadError(
        `文件过大：${label} (> ${Math.round(maxBytes / 1024 / 1024)} MB)`,
        413,
      );
    }
    const buffer = Buffer.concat(chunks, bytesRead);
    const fdAfter = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      statIdentity(opened) !== statIdentity(fdAfter)
      || statIdentity(opened) !== statIdentity(pathAfter)
      || buffer.length !== fdAfter.size
    ) {
      throw new LocalTreeReadError(`本地来源在读取期间发生变化：${label}`, 409);
    }
    return buffer;
  } catch (error) {
    if (error instanceof LocalTreeReadError) throw error;
    throw new LocalTreeReadError(`读取文件失败：${label} (${(error as Error).message})`, 409);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function canonicalizeRoot(absRootInput: string): { path: string; stat: Stats } {
  let parentCanonical: string;
  let leafCanonical: string;
  try {
    parentCanonical = realpathSync(dirname(absRootInput));
    leafCanonical = realpathSync(absRootInput);
  } catch {
    throw new LocalTreeReadError(`本地路径不存在：${absRootInput}`, 404);
  }

  // Permit system ancestor aliases such as macOS /tmp → /private/tmp, but
  // reject a leaf symlink/junction. The caller can pass the reported real path.
  const expectedLeaf = join(parentCanonical, basename(absRootInput));
  if (!pathsEqual(expectedLeaf, leafCanonical)) {
    throw new LocalTreeReadError(
      `路径含 symlink/junction 改写，拒绝导入：${absRootInput} → ${leafCanonical}。请直接传入真实路径`,
      400,
    );
  }

  let rootStat: Stats;
  try {
    rootStat = lstatSync(leafCanonical);
  } catch {
    throw new LocalTreeReadError(`本地路径不存在：${leafCanonical}`, 404);
  }
  if (rootStat.isSymbolicLink()) {
    throw new LocalTreeReadError('拒绝从 symlink/junction 导入：请使用其指向的真实路径', 400);
  }
  return { path: leafCanonical, stat: rootStat };
}

function shouldSkipEntry(entryName: string): boolean {
  if (
    entryName === 'node_modules'
    || entryName === '.git'
    || entryName === '__MACOSX'
    || entryName === '.DS_Store'
  ) {
    return true;
  }
  // Preserve the manifests that have product meaning; omit other hidden
  // files (especially .env/private editor state) from implicit directory copy.
  return entryName.startsWith('.')
    && entryName !== '.claude-plugin'
    && entryName !== '.mcp.json'
    && entryName !== '.lsp.json';
}

export function readLocalDirectoryTree(
  absRootInput: string,
  options: LocalTreeReadOptions = {},
): ExtractedTree {
  const { path: absRoot, stat: rootBefore } = canonicalizeRoot(absRootInput);
  if (!rootBefore.isDirectory()) {
    throw new LocalTreeReadError(`本地路径不是目录：${absRoot}`, 400);
  }

  const symlinkPolicy = options.symlinkPolicy ?? 'reject';
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  let fileCount = 0;

  const walk = (dir: string): void => {
    let dirBefore: Stats;
    let entries: Dirent[];
    try {
      dirBefore = lstatSync(dir);
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch (error) {
      throw new LocalTreeReadError(`读取目录失败：${dir} (${(error as Error).message})`, 500);
    }
    if (!dirBefore.isDirectory() || dirBefore.isSymbolicLink()) {
      throw new LocalTreeReadError(`目录在读取期间变为 symlink 或非目录：${dir}`, 409);
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      let before: Stats;
      try {
        before = lstatSync(fullPath);
      } catch {
        throw new LocalTreeReadError(`本地来源在读取期间发生变化：${fullPath}`, 409);
      }

      if (before.isSymbolicLink()) {
        if (symlinkPolicy === 'skip') continue;
        throw new LocalTreeReadError(
          `本地来源包含 symlink/junction：${relative(absRoot, fullPath)}。请物化为普通文件后重试`,
          400,
        );
      }
      // Skills promise fail-closed symlink admission even for entries whose
      // names are otherwise filtered as noise/private state. Plugins retain
      // their historical skip policy through the explicit option.
      if (shouldSkipEntry(entry.name)) continue;
      if (before.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!before.isFile()) continue;

      const rel = relative(absRoot, fullPath).split(sep).join('/');
      if (before.size > SKILL_PACKAGE_LIMITS.maxFileBytes) {
        throw new LocalTreeReadError(
          `文件过大：${rel} (${Math.round(before.size / 1024 / 1024)} MB > 5 MB)`,
          413,
        );
      }
      fileCount += 1;
      if (fileCount > SKILL_PACKAGE_LIMITS.maxFiles) {
        throw new LocalTreeReadError(`文件数过多 (>${SKILL_PACKAGE_LIMITS.maxFiles})`, 413);
      }

      const buffer = readStableRegularFile(
        fullPath,
        before,
        rel,
        SKILL_PACKAGE_LIMITS.maxFileBytes,
      );
      totalBytes += buffer.length;
      if (totalBytes > SKILL_PACKAGE_LIMITS.maxTotalBytes) {
        throw new LocalTreeReadError(
          `目录总大小超限 (${Math.round(totalBytes / 1024 / 1024)} MB > 50 MB)`,
          413,
        );
      }
      files.set(rel, buffer);
    }

    let dirAfter: Stats;
    try {
      dirAfter = lstatSync(dir);
    } catch {
      throw new LocalTreeReadError(`本地来源在读取期间发生变化：${dir}`, 409);
    }
    if (statIdentity(dirBefore) !== statIdentity(dirAfter)) {
      throw new LocalTreeReadError(`本地目录在读取期间发生变化：${dir}`, 409);
    }
  };

  walk(absRoot);

  let rootAfter: Stats;
  try {
    rootAfter = lstatSync(absRoot);
  } catch {
    throw new LocalTreeReadError(`本地来源在读取期间发生变化：${absRoot}`, 409);
  }
  if (statIdentity(rootBefore) !== statIdentity(rootAfter)) {
    throw new LocalTreeReadError(`本地目录在读取期间发生变化：${absRoot}`, 409);
  }
  if (files.size === 0) {
    throw new LocalTreeReadError('目录为空或没有可导入文件', 422);
  }

  return {
    files,
    sourceUrl: pathToFileURL(absRoot).href,
  };
}

export function readLocalRegularFile(absPathInput: string): { path: string; buffer: Buffer } {
  const { path, stat: before } = canonicalizeRoot(absPathInput);
  if (!before.isFile()) {
    throw new LocalTreeReadError(`本地路径不是普通文件：${path}`, 400);
  }
  if (before.size > SKILL_PACKAGE_LIMITS.maxTotalBytes) {
    throw new LocalTreeReadError(
      `本地压缩包太大 (${Math.round(before.size / 1024 / 1024)} MB > 50 MB)`,
      413,
    );
  }

  const buffer = readStableRegularFile(
    path,
    before,
    path,
    SKILL_PACKAGE_LIMITS.maxTotalBytes,
  );
  return { path, buffer };
}
