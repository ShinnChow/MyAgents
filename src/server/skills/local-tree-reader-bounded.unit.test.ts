import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const growthFault = vi.hoisted(() => ({ path: '', armed: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      if (growthFault.armed) {
        growthFault.armed = false;
        actual.appendFileSync(growthFault.path, Buffer.alloc(5 * 1024 * 1024 + 1));
      }
      return actual.readSync(...args);
    },
  };
});

import { readLocalDirectoryTree } from './local-tree-reader';

describe('readLocalDirectoryTree bounded descriptor reads', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'myagents-local-growth-'));
    growthFault.path = join(root, 'SKILL.md');
    growthFault.armed = false;
    writeFileSync(growthFault.path, 'small');
  });

  afterEach(() => {
    growthFault.armed = false;
    rmSync(root, { recursive: true, force: true });
  });

  it('stops at limit + 1 when a source file grows after its initial lstat', () => {
    growthFault.armed = true;

    expect(() => readLocalDirectoryTree(root)).toThrow(/文件过大/);
  });
});
