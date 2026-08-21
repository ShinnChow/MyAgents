import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchPluginTree } from './fetcher';

describe('fetchPluginTree local compatibility', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'myagents-plugin-source-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses the bounded local reader while preserving symlink-skip semantics', async () => {
    writeFileSync(join(root, 'plugin.json'), '{}');
    symlinkSync(join(root, 'plugin.json'), join(root, '.hidden-link'));

    const tree = await fetchPluginTree({
      kind: 'local',
      displayName: root,
      absolutePath: root,
      sourceUrl: `file://${root}`,
    });

    expect([...tree.files.keys()]).toEqual(['plugin.json']);
  });

  it('translates local reader failures into PluginFetchError status codes', async () => {
    await expect(fetchPluginTree({
      kind: 'local',
      displayName: join(root, 'missing'),
      absolutePath: join(root, 'missing'),
      sourceUrl: `file://${join(root, 'missing')}`,
    })).rejects.toMatchObject({ name: 'PluginFetchError', statusCode: 404 });
  });
});
