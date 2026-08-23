import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';

import { loadSkillTree, SkillSourceLoadError } from './source-loader';
import { resolveSkillUrl } from './url-resolver';

describe('loadSkillTree local sources', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'myagents-skill-source-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads a local directory without executing or linking it in place', async () => {
    writeFileSync(join(root, 'SKILL.md'), '---\nname: local\n---\nbody');
    const tree = await loadSkillTree(resolveSkillUrl(root));
    expect(tree.files.get('SKILL.md')?.toString()).toContain('name: local');
  });

  it.each(['.zip', '.skill'])('loads a local %s zip container', async (extension) => {
    const archivePath = join(root, `local${extension}`);
    const zip = new AdmZip();
    zip.addFile('wrapper/SKILL.md', Buffer.from('---\nname: packed\n---\nbody'));
    zip.addFile('wrapper/scripts/run.js', Buffer.from('export {};'));
    zip.writeZip(archivePath);

    const tree = await loadSkillTree(resolveSkillUrl(archivePath));

    expect([...tree.files.keys()].sort()).toEqual(['SKILL.md', 'scripts/run.js']);
  });

  it('rejects unsupported local file types with a stable client error', async () => {
    const path = join(root, 'skill.tar.gz');
    writeFileSync(path, 'not a zip');

    await expect(loadSkillTree(resolveSkillUrl(path))).rejects.toMatchObject({
      name: 'SkillSourceLoadError',
      statusCode: 400,
    } satisfies Partial<SkillSourceLoadError>);
  });
});
