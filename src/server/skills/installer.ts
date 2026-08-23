/**
 * installer.ts — Analyse an in-memory skill tree and determine what to install.
 *
 * Responsibilities:
 *   - Detect `.claude-plugin/marketplace.json` (Anthropic Plugin Marketplace format)
 *   - Detect skill roots (directories containing `SKILL.md`)
 *   - Apply subPath / skillName hints from the resolver
 *   - Produce a preview (for ambiguous installs) OR a concrete plan (for unambiguous ones)
 *
 * Publishing is staged beside the managed skills root, then serialized under
 * the shared cross-process file lock so readers never observe half-written
 * skill directories.
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';
import { load as yamlLoad, FAILSAFE_SCHEMA } from 'js-yaml';
import { parseFullSkillContent } from '../../shared/slashCommands';
import type { ExtractedTree } from './tarball-fetcher';
import type { ResolvedSkillSource } from './url-resolver';
import { ensureDirSync } from '../utils/fs-utils';
import { FileBusyError, withFileLock } from '../utils/file-lock';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single skill candidate discovered inside the tree */
export interface SkillCandidate {
  /** Path inside the tree where SKILL.md lives (the skill root). '' means tree root. */
  rootPath: string;
  /** Preferred folder name (from frontmatter.name or basename). Sanitization is caller's job. */
  suggestedFolderName: string;
  /** Parsed skill name (from frontmatter) */
  name: string;
  /** Parsed description */
  description: string;
  /** True when frontmatter's `allowed-tools` mentions Bash/Shell etc — surface as a warning */
  hasDangerousTools: boolean;
}

/** A Claude Plugins plugin group parsed from marketplace.json */
export interface PluginGroup {
  /** Plugin name as it appears in marketplace.json */
  name: string;
  /** Plugin description */
  description: string;
  /** Skill root paths this plugin contributes (pre-resolved against plugin `source`) */
  skills: SkillCandidate[];
}

/** Result of analysing a fetched tree */
export type InstallAnalysis =
  | {
      mode: 'single';
      skill: SkillCandidate;
    }
  | {
      mode: 'multi';
      candidates: SkillCandidate[];
    }
  | {
      mode: 'marketplace';
      marketplaceName: string;
      marketplaceDescription?: string;
      plugins: PluginGroup[];
    }
  | {
      mode: 'empty';
      reason: string;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyseTree(tree: ExtractedTree, src: ResolvedSkillSource): InstallAnalysis {
  // 1. Marketplace takes precedence (only when user didn't specify subPath/skillName)
  if (!src.subPath && !src.skillName) {
    const marketplace = tryParseMarketplace(tree);
    if (marketplace) return marketplace;
  }

  // 2. Collect all SKILL.md locations in the tree
  const allSkills = scanForSkills(tree);
  if (allSkills.length === 0) {
    return { mode: 'empty', reason: '未找到 SKILL.md — 仓库不是有效的 skill' };
  }

  // 3. Apply subPath hint — only keep skills under that prefix
  let filtered = allSkills;
  if (src.subPath) {
    const prefix = src.subPath.replace(/\/+$/, '') + '/';
    filtered = allSkills.filter(
      s => s.rootPath === src.subPath || s.rootPath.startsWith(prefix),
    );
    if (filtered.length === 0) {
      return { mode: 'empty', reason: `子路径 "${src.subPath}" 下未找到 SKILL.md` };
    }
  }

  // 4. Apply skillName hint — exact match on frontmatter.name or folder name
  if (src.skillName) {
    const hint = src.skillName.toLowerCase();
    const exact = filtered.filter(
      s => s.name.toLowerCase() === hint || s.suggestedFolderName.toLowerCase() === hint,
    );
    if (exact.length > 0) {
      filtered = exact;
    } else {
      return { mode: 'empty', reason: `未找到名为 "${src.skillName}" 的 skill` };
    }
  }

  if (filtered.length === 1) {
    return { mode: 'single', skill: filtered[0] };
  }
  return { mode: 'multi', candidates: filtered };
}

/**
 * Given a plan (skill candidates to install) + the tree, build a map of
 * `{targetFolderName → Map<relativeInsideFolder, Buffer>}` ready to be
 * written to disk.
 */
export function buildInstallPayload(
  tree: ExtractedTree,
  candidates: SkillCandidate[],
): Map<string, Map<string, Buffer>> {
  const result = new Map<string, Map<string, Buffer>>();
  for (const cand of candidates) {
    const folderFiles = buildInstallPayloadForCandidate(tree, cand);
    if (folderFiles.size > 0) {
      result.set(cand.suggestedFolderName, folderFiles);
    }
  }
  return result;
}

/** Candidate-keyed form avoids collisions when two roots share one suggested name. */
export function buildInstallPayloadForCandidate(
  tree: ExtractedTree,
  cand: SkillCandidate,
): Map<string, Buffer> {
  const prefix = cand.rootPath === '' ? '' : `${cand.rootPath.replace(/\/+$/, '')}/`;
  const folderFiles = new Map<string, Buffer>();
  for (const [path, buf] of tree.files) {
    if (prefix !== '' && !path.startsWith(prefix)) continue;
    const rel = prefix === '' ? path : path.slice(prefix.length);
    if (!rel) continue;
    // Runtime inventory intentionally requires the convention-reserved exact
    // filename. Accept common case variants at import time, then canonicalize.
    const installedRel = /^skill\.md$/i.test(rel) ? 'SKILL.md' : rel;
    if (folderFiles.has(installedRel)) {
      throw new SkillInstallError(`Skill 包含大小写冲突的重复路径：${installedRel}`, 422);
    }
    folderFiles.set(installedRel, buf);
  }
  return folderFiles;
}

// ---------------------------------------------------------------------------
// Internal scanning
// ---------------------------------------------------------------------------

/** Matches `SKILL.md` either at the tree root or as the tail of a subdirectory.
 *  Case-insensitive: repos sometimes use `Skill.md` / `skill.md`. */
const SKILL_MD_REGEX = /(?:^|\/)SKILL\.md$/i;

/** Walk the tree to find every SKILL.md */
function scanForSkills(tree: ExtractedTree): SkillCandidate[] {
  const candidates: SkillCandidate[] = [];
  for (const [relPath, buf] of tree.files) {
    if (!SKILL_MD_REGEX.test(relPath)) continue;

    const rootPath = relPath.includes('/')
      ? relPath.slice(0, relPath.lastIndexOf('/'))
      : '';

    const cand = buildCandidate(rootPath, buf.toString('utf-8'));
    if (cand) candidates.push(cand);
  }
  // Sort by rootPath depth so shallower skills come first (stable UI)
  candidates.sort((a, b) => {
    const da = a.rootPath.split('/').length;
    const db = b.rootPath.split('/').length;
    if (da !== db) return da - db;
    return a.rootPath.localeCompare(b.rootPath);
  });
  return candidates;
}

/** Exact tool names that should raise the "dangerous tools" warning.
 *  Matching is case-insensitive and only against the bare tool name (stripping
 *  any argument filters like `Bash(ls:*)`). Keep this list tight — false
 *  positives train the user to ignore the warning. */
const DANGEROUS_TOOL_NAMES = new Set([
  'bash', 'shell', 'sh', 'exec', 'run', 'cmd', 'powershell', 'pwsh', 'zsh',
]);

function buildCandidate(rootPath: string, content: string): SkillCandidate | null {
  let name = '';
  let description = '';
  let allowedTools: string[] = [];
  try {
    // parseFullSkillContent is strict (string-only allowed-tools). We re-parse
    // the raw frontmatter block here because the Agent Skills spec permits
    // allowed-tools as an array — and we specifically need to surface array
    // form to the UI as a "dangerous tools" warning. FAILSAFE_SCHEMA blocks
    // YAML anchors/merge-keys/custom tags (zip-bomb / expansion-attack surface).
    const parsed = parseFullSkillContent(content);
    name = (parsed.frontmatter?.name as string) || '';
    description = (parsed.frontmatter?.description as string) || '';

    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const raw = yamlLoad(fmMatch[1], { schema: FAILSAFE_SCHEMA }) as Record<string, unknown> | null;
      const tools = raw?.['allowed-tools'];
      if (Array.isArray(tools)) {
        allowedTools = tools.filter((x): x is string => typeof x === 'string');
      } else if (typeof tools === 'string') {
        allowedTools = tools.split(/[,\s]+/).filter(Boolean);
      }
    }
  } catch {
    // Fall through — we'll use defaults below
  }

  // Suggested folder name: frontmatter.name wins, then the last path segment
  const basename = rootPath === '' ? '' : rootPath.split('/').pop() ?? '';
  const suggestedFolderName = name || basename || 'unnamed-skill';
  if (!suggestedFolderName) return null;

  // Extract the bare tool name from entries like `Bash(ls:*)` or `mcp__shell__*`
  // and check against the exact-match allowlist.
  const hasDangerousTools = allowedTools.some(t => {
    const bare = t.replace(/\(.*\)$/, '').trim().toLowerCase();
    return DANGEROUS_TOOL_NAMES.has(bare);
  });

  return {
    rootPath,
    suggestedFolderName,
    name: name || suggestedFolderName,
    description,
    hasDangerousTools,
  };
}

// ---------------------------------------------------------------------------
// Marketplace.json parsing
// ---------------------------------------------------------------------------

interface MarketplaceJson {
  name?: string;
  metadata?: { description?: string; version?: string };
  plugins?: Array<{
    name?: string;
    description?: string;
    source?: string;
    skills?: string[];
  }>;
}

function tryParseMarketplace(tree: ExtractedTree): InstallAnalysis | null {
  const mpBuf = tree.files.get('.claude-plugin/marketplace.json');
  if (!mpBuf) return null;

  let parsed: MarketplaceJson;
  try {
    parsed = JSON.parse(mpBuf.toString('utf-8')) as MarketplaceJson;
  } catch {
    return null;
  }

  if (!parsed.plugins || !Array.isArray(parsed.plugins) || parsed.plugins.length === 0) {
    return null;
  }

  const plugins: PluginGroup[] = [];
  for (const p of parsed.plugins) {
    if (!p.name || !Array.isArray(p.skills)) continue;
    const sourceRoot = (p.source ?? './').replace(/^\.\/+/, '').replace(/\/+$/, '');
    const skillCandidates: SkillCandidate[] = [];

    for (const skillRel of p.skills) {
      const rel = skillRel.replace(/^\.\/+/, '').replace(/\/+$/, '');
      const rootPath = sourceRoot ? `${sourceRoot}/${rel}` : rel;
      const skillMdPath = `${rootPath}/SKILL.md`;
      const buf = tree.files.get(skillMdPath);
      if (!buf) continue;
      const cand = buildCandidate(rootPath, buf.toString('utf-8'));
      if (cand) skillCandidates.push(cand);
    }

    if (skillCandidates.length > 0) {
      plugins.push({
        name: p.name,
        description: p.description || '',
        skills: skillCandidates,
      });
    }
  }

  if (plugins.length === 0) return null;

  return {
    mode: 'marketplace',
    marketplaceName: parsed.name || 'claude-plugins',
    marketplaceDescription: parsed.metadata?.description,
    plugins,
  };
}

// ---------------------------------------------------------------------------
// Disk writer — single zip-slip-guarded write path reused by every skill
// install call site (`install-from-url` single branch, confirmed branch, and
// the legacy `/api/skill/upload` flow).
// ---------------------------------------------------------------------------

/**
 * Materialize an in-memory file map under `skillDir`.
 *
 * Zip-slip defense: every resolved path must remain inside `skillDir`. Any
 * entry that escapes is silently dropped (with a warning) so a partially
 * malicious zip still produces a consistent partial skill rather than
 * corrupting unrelated directories.
 *
 * Creates `skillDir` (recursively) and every intermediate subdirectory as it
 * writes. Caller is responsible for conflict handling (checking `existsSync`
 * before calling, or passing a fresh path).
 */
export function writeSkillFiles(skillDir: string, files: Map<string, Buffer>): void {
  const resolvedSkillDir = resolve(skillDir);
  ensureDirSync(resolvedSkillDir);
  for (const [rel, data] of files) {
    const fullPath = resolve(join(resolvedSkillDir, rel));
    // Zip-slip: resolved path MUST stay within skillDir
    if (!fullPath.startsWith(resolvedSkillDir + sep) && fullPath !== resolvedSkillDir) {
      throw new SkillInstallError(`Skill 包含非法写入路径：${rel}`, 422);
    }
    const dir = dirname(fullPath);
    ensureDirSync(dir);
    writeFileSync(fullPath, data);
  }
}

export class SkillInstallError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'SkillInstallError';
    this.statusCode = statusCode;
  }
}

export interface SkillPublishTarget {
  folderName: string;
  files: Map<string, Buffer>;
  name: string;
  description: string;
  overwrite: boolean;
}

export interface PublishedSkill {
  folderName: string;
  path: string;
  name: string;
  description: string;
}

/** Existence check that treats dangling symlinks as occupied targets. */
export function pathEntryExistsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Portable collision identity for managed Skill folder names. */
export function skillTargetCollisionKey(folderName: string): string {
  return folderName.normalize('NFC').toLocaleLowerCase('en-US');
}

function assertManagedSkillsRoot(baseDirInput: string): string {
  const baseDir = resolve(baseDirInput);
  ensureDirSync(dirname(baseDir));
  if (!pathEntryExistsNoFollow(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  const stat = lstatSync(baseDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SkillInstallError(`Skill 安装根目录不是普通物理目录：${baseDir}`, 400);
  }
  return baseDir;
}

function assertTargetFolderName(folderName: string): void {
  if (
    !folderName
    || folderName === '.'
    || folderName === '..'
    || basename(folderName) !== folderName
    || folderName.includes('/')
    || folderName.includes('\\')
  ) {
    throw new SkillInstallError(`非法 Skill 目录名：${folderName}`, 400);
  }
}

/**
 * Stage every managed Skill as a complete physical directory and publish each
 * with a same-filesystem rename. Conflict decisions are repeated while holding
 * the install lock; overwritten directories are retained as backups until the
 * complete batch succeeds and are restored on any publish failure.
 */
export async function publishSkillInstallPlan(
  baseDirInput: string,
  targets: SkillPublishTarget[],
): Promise<PublishedSkill[]> {
  if (targets.length === 0) {
    throw new SkillInstallError('没有任何 Skill 可安装', 400);
  }

  const baseDir = assertManagedSkillsRoot(baseDirInput);
  const seen = new Set<string>();
  for (const target of targets) {
    assertTargetFolderName(target.folderName);
    const collisionKey = skillTargetCollisionKey(target.folderName);
    if (seen.has(collisionKey)) {
      throw new SkillInstallError(`多个 Skill 解析到同一个文件夹名“${target.folderName}”`, 409);
    }
    seen.add(collisionKey);
    if (target.files.size === 0) {
      throw new SkillInstallError(`Skill“${target.folderName}”没有可安装文件`, 422);
    }
  }

  // A sibling staging directory guarantees rename() stays on one filesystem.
  const stagingRoot = mkdtempSync(`${baseDir}.install-staging-`);
  const payloadRoot = join(stagingRoot, 'payload');
  const backupRoot = join(stagingRoot, 'backup');
  mkdirSync(payloadRoot);
  mkdirSync(backupRoot);
  let preserveForRecovery = false;

  try {
    targets.forEach((target, index) => {
      const stagedDir = join(payloadRoot, String(index));
      writeSkillFiles(stagedDir, target.files);
      let manifestStat;
      try {
        manifestStat = lstatSync(join(stagedDir, 'SKILL.md'));
      } catch {
        throw new SkillInstallError(`Skill“${target.folderName}”缺少 SKILL.md`, 422);
      }
      if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
        throw new SkillInstallError(`Skill“${target.folderName}”的 SKILL.md 不是普通文件`, 422);
      }
    });

    try {
      return await withFileLock(
        { lockPath: `${baseDir}.install.lock`, timeoutMs: 10_000 },
        async () => {
          // Recheck every conflict under the authority lock before moving any
          // existing target or publishing any staged directory.
          for (const target of targets) {
            const targetPath = join(baseDir, target.folderName);
            if (pathEntryExistsNoFollow(targetPath) && !target.overwrite) {
              throw new SkillInstallError(`技能“${target.folderName}”已存在`, 409);
            }
          }

          const backups: Array<{ targetPath: string; backupPath: string }> = [];
          const published: string[] = [];
          try {
            targets.forEach((target, index) => {
              const targetPath = join(baseDir, target.folderName);
              if (pathEntryExistsNoFollow(targetPath)) {
                const backupPath = join(backupRoot, String(index));
                renameSync(targetPath, backupPath);
                backups.push({ targetPath, backupPath });
              }

              renameSync(join(payloadRoot, String(index)), targetPath);
              published.push(targetPath);
            });
          } catch (publishError) {
            const recoveryErrors: string[] = [];
            for (const targetPath of published.reverse()) {
              try {
                rmSync(targetPath, { recursive: true, force: true });
              } catch (error) {
                recoveryErrors.push(`移除新目录 ${targetPath} 失败：${(error as Error).message}`);
              }
            }
            for (const { targetPath, backupPath } of backups.reverse()) {
              try {
                if (pathEntryExistsNoFollow(targetPath)) {
                  rmSync(targetPath, { recursive: true, force: true });
                }
                renameSync(backupPath, targetPath);
              } catch (error) {
                recoveryErrors.push(`恢复旧目录 ${targetPath} 失败：${(error as Error).message}`);
              }
            }

            if (recoveryErrors.length > 0) {
              preserveForRecovery = true;
              throw new SkillInstallError(
                `Skill 发布失败且回滚不完整；恢复数据保留在 ${stagingRoot}。`
                + `原始错误：${(publishError as Error).message}；${recoveryErrors.join('；')}`,
                500,
              );
            }
            throw publishError;
          }

          return targets.map(target => ({
            folderName: target.folderName,
            path: join(baseDir, target.folderName),
            name: target.name,
            description: target.description,
          }));
        },
      );
    } catch (error) {
      if (error instanceof FileBusyError) {
        throw new SkillInstallError('Skill 安装目录正被另一个操作占用，请稍后重试', 409);
      }
      throw error;
    }
  } finally {
    if (!preserveForRecovery) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
}
