/**
 * Load any supported Skill source into the source-agnostic ExtractedTree.
 *
 * Local directories are snapshotted with no-follow checks; local `.zip` and
 * `.skill` files use the exact same bounded zip extractor as remote packages.
 * Nothing is installed or executed from the source path itself.
 */

import { lstatSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  extractZipInMemory,
  fetchSkillZip,
  TarballFetchError,
  type ExtractedTree,
} from './tarball-fetcher';
import {
  LocalTreeReadError,
  readLocalDirectoryTree,
  readLocalRegularFile,
} from './local-tree-reader';
import type { ResolvedSkillSource } from './url-resolver';

export class SkillSourceLoadError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'SkillSourceLoadError';
    this.statusCode = statusCode;
  }
}

/** Single entrypoint from a resolved source to an immutable package snapshot. */
export async function loadSkillTree(src: ResolvedSkillSource): Promise<ExtractedTree> {
  if (src.kind !== 'local') {
    try {
      return await fetchSkillZip(src);
    } catch (error) {
      if (error instanceof TarballFetchError) {
        throw new SkillSourceLoadError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  let sourceStat;
  try {
    sourceStat = lstatSync(src.absolutePath);
  } catch {
    throw new SkillSourceLoadError(`本地路径不存在：${src.absolutePath}`, 404);
  }

  if (sourceStat.isSymbolicLink()) {
    throw new SkillSourceLoadError('拒绝从 symlink/junction 导入：请使用其指向的真实路径', 400);
  }

  try {
    if (sourceStat.isDirectory()) {
      return readLocalDirectoryTree(src.absolutePath, { symlinkPolicy: 'reject' });
    }

    if (!sourceStat.isFile()) {
      throw new SkillSourceLoadError(`本地路径不是目录或普通文件：${src.absolutePath}`, 400);
    }

    const extension = extname(src.absolutePath).toLocaleLowerCase('en-US');
    if (extension !== '.zip' && extension !== '.skill') {
      throw new SkillSourceLoadError(
        `不支持的本地文件类型“${extension || '(无扩展名)'}”；请提供目录、.zip 或 .skill`,
        400,
      );
    }

    const localFile = readLocalRegularFile(src.absolutePath);
    return {
      files: extractZipInMemory(localFile.buffer),
      sourceUrl: pathToFileURL(localFile.path).href,
    };
  } catch (error) {
    if (error instanceof SkillSourceLoadError) throw error;
    if (error instanceof LocalTreeReadError || error instanceof TarballFetchError) {
      throw new SkillSourceLoadError(error.message, error.statusCode);
    }
    throw error;
  }
}
