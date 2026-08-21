import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveSkillUrl, SkillUrlError } from './url-resolver';

describe('resolveSkillUrl', () => {
  it('accepts https raw package URLs', () => {
    const resolved = resolveSkillUrl('https://example.com/skill.zip');

    expect(resolved.kind).toBe('raw-zip');
    expect(resolved.rawZipUrl).toBe('https://example.com/skill.zip');
  });

  it('rejects http raw package URLs', () => {
    expect(() => resolveSkillUrl('http://example.com/skill.zip')).toThrow(SkillUrlError);
  });

  it('preserves owner/repo as GitHub shorthand instead of guessing a local path', () => {
    expect(resolveSkillUrl('private/example')).toMatchObject({
      kind: 'github',
      owner: 'private',
      repo: 'example',
    });
  });

  it('accepts absolute local paths including spaces', () => {
    const absolutePath = resolve('/tmp', 'private skills', 'example');
    expect(resolveSkillUrl(absolutePath)).toMatchObject({
      kind: 'local',
      absolutePath,
      sourceUrl: pathToFileURL(absolutePath).href,
    });
  });

  it('accepts file URLs and keeps the decoded absolute path', () => {
    const absolutePath = resolve('/tmp', 'private skills', 'example.skill');
    expect(resolveSkillUrl(pathToFileURL(absolutePath).href)).toMatchObject({
      kind: 'local',
      absolutePath,
    });
  });

  it('extracts an absolute local source from a pasted npx command', () => {
    const absolutePath = resolve('/tmp', 'private-skill');
    expect(resolveSkillUrl(`npx skills add ${absolutePath} --skill private`)).toMatchObject({
      kind: 'local',
      absolutePath,
      skillName: 'private',
    });
  });

  it('requires the CLI to resolve explicit relative local paths', () => {
    expect(() => resolveSkillUrl('./private/example')).toThrow(SkillUrlError);
  });

  it('accepts Windows drive-letter grammar for cross-platform CLI requests', () => {
    expect(resolveSkillUrl('C:\\private\\example')).toMatchObject({ kind: 'local' });
  });

  it('rejects traversal and unsupported tar packages before disk or network IO', () => {
    expect(() => resolveSkillUrl('file:///tmp/source/../secret')).toThrow(/非法/);
    expect(() => resolveSkillUrl('https://example.com/skill.tgz')).toThrow(/暂不支持/);
    expect(() => resolveSkillUrl('https://example.com/skill.tar.gz')).toThrow(/暂不支持/);
  });
});
