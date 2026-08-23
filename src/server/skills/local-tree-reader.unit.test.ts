import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalTreeReadError, readLocalDirectoryTree } from './local-tree-reader';
import { SKILL_PACKAGE_LIMITS } from './tarball-fetcher';

describe('readLocalDirectoryTree', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'myagents-local-skill-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('snapshots ordinary files and omits private/noise entries', () => {
    writeFileSync(join(root, 'SKILL.md'), '---\nname: private\n---\n');
    writeFileSync(join(root, 'script.ts'), 'export {};');
    writeFileSync(join(root, '.env'), 'TOKEN=secret');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'private');
    writeFileSync(join(root, '.mcp.json'), '{}');

    const tree = readLocalDirectoryTree(root);

    expect([...tree.files.keys()].sort()).toEqual(['.mcp.json', 'SKILL.md', 'script.ts']);
    expect(tree.sourceUrl).toMatch(/^file:/);
  });

  it('rejects a symlink source root and an internal symlink for Skills', () => {
    const linkedRoot = `${root}-link`;
    symlinkSync(root, linkedRoot, 'dir');
    writeFileSync(join(root, 'SKILL.md'), 'skill');
    try {
      expect(() => readLocalDirectoryTree(linkedRoot)).toThrow(LocalTreeReadError);
      symlinkSync(join(root, 'SKILL.md'), join(root, 'linked.md'));
      expect(() => readLocalDirectoryTree(root)).toThrow(/symlink\/junction/);
    } finally {
      rmSync(linkedRoot, { recursive: true, force: true });
    }
  });

  it('retains the Plugin reader historical policy of skipping internal symlinks', () => {
    writeFileSync(join(root, 'SKILL.md'), 'skill');
    symlinkSync(join(root, 'SKILL.md'), join(root, '.hidden-link'));

    const tree = readLocalDirectoryTree(root, { symlinkPolicy: 'skip' });

    expect([...tree.files.keys()]).toEqual(['SKILL.md']);
  });

  it('rejects a filtered hidden symlink before applying the noise filter for Skills', () => {
    writeFileSync(join(root, 'SKILL.md'), 'skill');
    symlinkSync(join(root, 'SKILL.md'), join(root, '.hidden-link'));

    expect(() => readLocalDirectoryTree(root)).toThrow(/symlink\/junction/);
  });

  it('enforces the shared per-file limit before reading the payload', () => {
    writeFileSync(
      join(root, 'SKILL.md'),
      Buffer.alloc(SKILL_PACKAGE_LIMITS.maxFileBytes + 1),
    );

    expect(() => readLocalDirectoryTree(root)).toThrow(/文件过大/);
  });
});
