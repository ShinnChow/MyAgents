import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renameFault = vi.hoisted(() => ({ destinationSuffix: '' }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: (source: string, destination: string) => {
      if (
        renameFault.destinationSuffix
        && destination.endsWith(renameFault.destinationSuffix)
        && source.includes('.install-staging-')
        && source.includes('/payload/')
      ) {
        renameFault.destinationSuffix = '';
        const error = new Error('injected publish rename failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      actual.renameSync(source, destination);
    },
  };
});

import { publishSkillInstallPlan, type SkillPublishTarget } from './installer';

function target(folderName: string, body: string, overwrite = false): SkillPublishTarget {
  return {
    folderName,
    files: new Map([['SKILL.md', Buffer.from(`---\nname: ${folderName}\n---\n${body}`)]]),
    name: folderName,
    description: body,
    overwrite,
  };
}

describe('publishSkillInstallPlan rollback', () => {
  let scratch: string;
  let baseDir: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'myagents-skill-rollback-'));
    baseDir = join(scratch, 'skills');
    renameFault.destinationSuffix = '';
  });

  afterEach(() => {
    renameFault.destinationSuffix = '';
    rmSync(scratch, { recursive: true, force: true });
  });

  it('restores earlier overwrites when a later publish rename fails', async () => {
    await publishSkillInstallPlan(baseDir, [target('replace-me', 'old')]);
    renameFault.destinationSuffix = `${join('', 'second')}`;

    await expect(publishSkillInstallPlan(baseDir, [
      target('replace-me', 'new', true),
      target('second', 'never-published'),
    ])).rejects.toThrow(/injected publish rename failure/);

    expect(readFileSync(join(baseDir, 'replace-me', 'SKILL.md'), 'utf8')).toContain('old');
    expect(readdirSync(dirname(baseDir)).filter(name => name.includes('.install-staging-'))).toEqual([]);
  });
});
