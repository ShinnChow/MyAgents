import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';

const networkMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: networkMocks.lookup }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: networkMocks.fetch };
});

import {
  fetchSkillZip,
  extractZipInMemory,
  isBlockedSkillPackageHost,
  isSkillPackageUrlLexicallySafe,
} from './tarball-fetcher';
import {
  _resetProxyStateForTests,
  getGeneralRequestDispatcher,
} from '../proxy-state';

const check = (url: string) => isSkillPackageUrlLexicallySafe(new URL(url));

describe('skill tarball SSRF guard', () => {
  beforeEach(() => {
    networkMocks.fetch.mockReset();
    networkMocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterEach(() => {
    _resetProxyStateForTests(null, {});
  });

  it('requires https package URLs', () => {
    expect(check('https://example.com/skill.zip').ok).toBe(true);
    expect(check('http://example.com/skill.zip').ok).toBe(false);
    expect(check('file:///etc/passwd').ok).toBe(false);
  });

  it('rejects loopback, private, and link-local literal hosts', () => {
    expect(check('https://localhost/skill.zip').ok).toBe(false);
    expect(check('https://127.0.0.1/skill.zip').ok).toBe(false);
    expect(check('https://10.0.0.5/skill.zip').ok).toBe(false);
    expect(check('https://172.16.0.1/skill.zip').ok).toBe(false);
    expect(check('https://192.168.1.1/skill.zip').ok).toBe(false);
    expect(check('https://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(check('https://[::1]/skill.zip').ok).toBe(false);
    expect(check('https://[fd12::1]/skill.zip').ok).toBe(false);
    expect(check('https://[fe80::1]/skill.zip').ok).toBe(false);
  });

  it('uses the same private-host predicate for DNS lookup results', () => {
    expect(isBlockedSkillPackageHost('127.5.5.5')).toBe(true);
    expect(isBlockedSkillPackageHost('172.31.255.255')).toBe(true);
    expect(isBlockedSkillPackageHost('172.32.0.1')).toBe(false);
    expect(isBlockedSkillPackageHost('8.8.8.8')).toBe(false);
    expect(isBlockedSkillPackageHost('fd12::1')).toBe(true);
  });

  it('uses the inherited general dispatcher for trusted GitHub downloads', async () => {
    _resetProxyStateForTests({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      scope: { mode: 'custom', generalRequests: false, providerIds: ['provider-a'] },
    }, { HTTPS_PROXY: 'http://127.0.0.1:18080' });
    const inheritedDispatcher = getGeneralRequestDispatcher();
    networkMocks.fetch.mockResolvedValue(new Response('', { status: 404 }));

    await expect(fetchSkillZip({
      kind: 'github',
      displayName: 'owner/repo',
      owner: 'owner',
      repo: 'repo',
      ref: 'main',
    })).rejects.toMatchObject({ statusCode: 404 });

    const init = networkMocks.fetch.mock.calls[0]?.[1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBe(inheritedDispatcher);
  });

  it('keeps arbitrary raw ZIP downloads on their pinned direct dispatcher', async () => {
    _resetProxyStateForTests({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      scope: { mode: 'custom', generalRequests: true, providerIds: [] },
    });
    const generalDispatcher = getGeneralRequestDispatcher();
    networkMocks.fetch.mockResolvedValue(new Response('', { status: 404 }));

    await expect(fetchSkillZip({
      kind: 'raw-zip',
      displayName: 'https://downloads.example/skill.zip',
      rawZipUrl: 'https://downloads.example/skill.zip',
    })).rejects.toMatchObject({ statusCode: 404 });

    const init = networkMocks.fetch.mock.calls[0]?.[1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
    expect(init.dispatcher).not.toBe(generalDispatcher);
  });
});

describe('skill zip extraction boundaries', () => {
  it('extracts an ordinary wrapper-root package', () => {
    const zip = new AdmZip();
    zip.addFile('repo-main/SKILL.md', Buffer.from('skill'));
    zip.addFile('repo-main/scripts/run.js', Buffer.from('run'));

    expect([...extractZipInMemory(zip.toBuffer()).keys()].sort()).toEqual([
      'SKILL.md',
      'scripts/run.js',
    ]);
  });

  it('rejects traversal before a malicious root can be stripped', () => {
    const zip = new AdmZip();
    zip.addFile('aaa/evil', Buffer.from('evil'));
    const buffer = zip.toBuffer();
    for (let index = 0; index <= buffer.length - 8; index += 1) {
      if (buffer.toString('ascii', index, index + 8) === 'aaa/evil') {
        buffer.write('../evil!', index, 'ascii');
      }
    }

    expect(() => extractZipInMemory(buffer)).toThrow(/非法路径/);
  });

  it('rejects Unix symlink entries instead of materializing their target text', () => {
    const zip = new AdmZip();
    const entry = zip.addFile('repo-main/link', Buffer.from('../outside'));
    entry.attr = (0o120777 << 16) >>> 0;

    expect(() => extractZipInMemory(zip.toBuffer())).toThrow(/symlink/);
  });

  it('rejects a symlink mode even when adm-zip also classifies it as a directory', () => {
    const zip = new AdmZip();
    zip.addFile('repo-main/SKILL.md', Buffer.from('skill'));
    const entry = zip.addFile('repo-main/link/', Buffer.alloc(0));
    entry.attr = (0o120777 << 16) >>> 0;

    expect(() => extractZipInMemory(zip.toBuffer())).toThrow(/symlink/);
  });

  it('enforces total uncompressed bytes across individually valid files', () => {
    const zip = new AdmZip();
    const chunk = Buffer.alloc(5 * 1024 * 1024);
    for (let index = 0; index < 11; index += 1) {
      zip.addFile(`repo-main/file-${index}.bin`, chunk);
    }

    expect(() => extractZipInMemory(zip.toBuffer())).toThrow(/总体积超限/);
  });
});
