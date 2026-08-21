import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pathEntryExistsNoFollow,
  publishSkillInstallPlan,
  type SkillPublishTarget,
} from './installer';

function target(folderName: string, body: string, overwrite = false): SkillPublishTarget {
  return {
    folderName,
    files: new Map([
      ['SKILL.md', Buffer.from(`---\nname: ${folderName}\n---\n${body}`)],
      ['scripts/run.js', Buffer.from(body)],
    ]),
    name: folderName,
    description: body,
    overwrite,
  };
}

describe('publishSkillInstallPlan', () => {
  let scratch: string;
  let baseDir: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'myagents-skill-publish-'));
    baseDir = join(scratch, 'skills');
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('publishes complete physical directories and removes staging data', async () => {
    const installed = await publishSkillInstallPlan(baseDir, [target('private-skill', 'v1')]);

    expect(installed).toMatchObject([{ folderName: 'private-skill' }]);
    expect(readFileSync(join(baseDir, 'private-skill', 'scripts', 'run.js'), 'utf8')).toBe('v1');
    expect(lstatSync(join(baseDir, 'private-skill')).isDirectory()).toBe(true);
    expect(lstatSync(join(baseDir, 'private-skill')).isSymbolicLink()).toBe(false);
    expect(readdirSync(dirname(baseDir)).filter(name => name.includes('.install-staging-'))).toEqual([]);
  });

  it('does not publish an earlier target when any target conflicts at lock time', async () => {
    await publishSkillInstallPlan(baseDir, [target('occupied', 'old')]);

    await expect(publishSkillInstallPlan(baseDir, [
      target('new-skill', 'new'),
      target('occupied', 'replacement'),
    ])).rejects.toMatchObject({ statusCode: 409 });

    expect(existsSync(join(baseDir, 'new-skill'))).toBe(false);
    expect(readFileSync(join(baseDir, 'occupied', 'scripts', 'run.js'), 'utf8')).toBe('old');
  });

  it('rejects filesystem-equivalent case variants before staging or publishing', async () => {
    await expect(publishSkillInstallPlan(baseDir, [
      target('CaseSkill', 'first'),
      target('caseskill', 'second'),
    ])).rejects.toMatchObject({ statusCode: 409 });

    expect(existsSync(join(baseDir, 'CaseSkill'))).toBe(false);
    expect(existsSync(join(baseDir, 'caseskill'))).toBe(false);
  });

  it('backs up and replaces an explicitly overwritten Skill', async () => {
    await publishSkillInstallPlan(baseDir, [target('replace-me', 'old')]);
    await publishSkillInstallPlan(baseDir, [target('replace-me', 'new', true)]);

    expect(readFileSync(join(baseDir, 'replace-me', 'scripts', 'run.js'), 'utf8')).toBe('new');
  });

  it('treats a dangling symlink target as occupied without following it', async () => {
    const missing = join(scratch, 'missing');
    const dangling = join(baseDir, 'dangling');
    await publishSkillInstallPlan(baseDir, [target('seed', 'seed')]);
    symlinkSync(missing, dangling, 'dir');

    expect(pathEntryExistsNoFollow(dangling)).toBe(true);
    await expect(publishSkillInstallPlan(baseDir, [target('dangling', 'new')]))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
  });

  it('never exposes a target when staged validation fails', async () => {
    const invalid = target('invalid', 'body');
    invalid.files.delete('SKILL.md');

    await expect(publishSkillInstallPlan(baseDir, [invalid])).rejects.toThrow(/缺少 SKILL\.md/);

    expect(existsSync(join(baseDir, 'invalid'))).toBe(false);
    expect(readdirSync(dirname(baseDir)).filter(name => name.includes('.install-staging-'))).toEqual([]);
  });

});
