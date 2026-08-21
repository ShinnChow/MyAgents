/**
 * fetcher.ts — Resolve a ResolvedPluginSource into an in-memory ExtractedTree.
 *
 * For remote sources we reuse skills/tarball-fetcher.ts (GitHub or raw zip,
 * SSRF-guarded, size-capped, manual-redirect-validated). For local sources
 * we walk the directory and produce the same `ExtractedTree` shape so the
 * downstream installer can stay source-agnostic.
 *
 * Local-directory limits mirror the tarball limits (50MB / 2000 files / 5MB
 * per file) to keep "drop a project folder by mistake" failures predictable.
 */

import { existsSync, lstatSync, statSync } from 'fs';

import {
  fetchSkillZip,
  TarballFetchError,
  type ExtractedTree,
} from '../skills/tarball-fetcher';
import { LocalTreeReadError, readLocalDirectoryTree } from '../skills/local-tree-reader';
import type { ResolvedPluginSource } from './url-resolver';

export class PluginFetchError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'PluginFetchError';
    this.statusCode = statusCode;
  }
}

/** Single entrypoint — discharges any source into an ExtractedTree. */
export async function fetchPluginTree(src: ResolvedPluginSource): Promise<ExtractedTree> {
  if (src.kind === 'remote') {
    try {
      return await fetchSkillZip(src.tarball);
    } catch (err) {
      if (err instanceof TarballFetchError) {
        throw new PluginFetchError(err.message, err.statusCode);
      }
      throw err;
    }
  }
  try {
    return readLocalDirectoryTree(src.absolutePath, { symlinkPolicy: 'skip' });
  } catch (error) {
    if (error instanceof LocalTreeReadError) {
      throw new PluginFetchError(error.message, error.statusCode);
    }
    throw error;
  }
}

/** Lightweight existence check (used by store to detect "directory was deleted externally") */
export function pluginInstallPathExists(installPath: string): boolean {
  try {
    return statSync(installPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check whether `installPath` is currently a "broken symlink" — exists per
 * lstat but the target is gone. We MUST unlink before any write/cp operation
 * because Node v24's cpSync calls std::filesystem::equivalent which throws
 * an uncaught C++ exception on dangling symlinks and aborts the sidecar
 * (see CLAUDE.md "断链 symlink" red-line for the v0.2.5 repro).
 */
export function isBrokenSymlink(p: string): boolean {
  let lst;
  try {
    lst = lstatSync(p);
  } catch {
    return false;
  }
  if (!lst.isSymbolicLink()) return false;
  // exists() follows symlinks — if it returns false on a symlink, it's broken
  return !existsSync(p);
}
