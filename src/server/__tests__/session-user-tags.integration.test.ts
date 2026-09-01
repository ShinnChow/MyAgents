import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MAX_SESSION_USER_TAGS } from '../../shared/session-user-tags';

type SessionStoreModule = typeof import('../SessionStore');

let scratchHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let store: SessionStoreModule;

const sessionsPath = () => join(scratchHome, '.myagents', 'sessions.json');

function readSessions(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(sessionsPath(), 'utf-8')) as Array<Record<string, unknown>>;
}

function writeSessions(sessions: Array<Record<string, unknown>>): void {
  writeFileSync(sessionsPath(), JSON.stringify(sessions, null, 2), 'utf-8');
}

beforeAll(async () => {
  scratchHome = mkdtempSync(join(tmpdir(), 'myagents-session-tags-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratchHome;
  process.env.USERPROFILE = scratchHome;
  vi.resetModules();
  store = await import('../SessionStore');
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(scratchHome, { recursive: true, force: true });
});

describe('SessionStore user Tag authority', () => {
  it('reuses the first global display name and never changes Session recency', async () => {
    const first = await store.createSession('/tmp/tag-workspace-a', {
      title: 'First',
      lastActiveAt: '2026-09-01T10:00:00.000Z',
    });
    const second = await store.createSession('/tmp/tag-workspace-b', {
      title: 'Second',
      lastActiveAt: '2026-09-01T11:00:00.000Z',
    });

    const created = await store.mutateSessionUserTag(first.id, { kind: 'add', name: ' Cafe\u0301 ' });
    const reused = await store.mutateSessionUserTag(second.id, { kind: 'add', name: 'CAFÉ' });

    expect(created).toMatchObject({ ok: true, session: { userTags: ['Café'] } });
    expect(reused).toMatchObject({ ok: true, session: { userTags: ['Café'] } });
    expect(store.getSessionMetadata(first.id)?.lastActiveAt).toBe('2026-09-01T10:00:00.000Z');
    expect(store.listSessionUserTags()).toContainEqual({ name: 'Café', count: 2 });
  });

  it('serializes concurrent assignment intents and enforces the fifth Tag in the lock', async () => {
    const session = await store.createSession('/tmp/tag-concurrency');
    for (const name of ['One', 'Two', 'Three', 'Four']) {
      expect(await store.mutateSessionUserTag(session.id, { kind: 'add', name })).toMatchObject({ ok: true });
    }

    const results = await Promise.all([
      store.mutateSessionUserTag(session.id, { kind: 'add', name: 'Five' }),
      store.mutateSessionUserTag(session.id, { kind: 'add', name: 'Six' }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ reason: 'limit-reached' }),
    ]);
    expect(store.getSessionMetadata(session.id)?.userTags).toHaveLength(MAX_SESSION_USER_TAGS);

    const existingName = store.getSessionMetadata(session.id)?.userTags?.[0] ?? 'One';
    expect(await store.mutateSessionUserTag(session.id, { kind: 'add', name: existingName.toLowerCase() }))
      .toMatchObject({ ok: true, action: 'noop' });
    expect(await store.mutateSessionUserTag(session.id, { kind: 'remove', name: 'missing' }))
      .toMatchObject({ ok: true, action: 'noop' });
  });

  it('repairs malformed metadata on the next target Session mutation', async () => {
    const session = await store.createSession('/tmp/tag-malformed');
    const sessions = readSessions();
    const target = sessions.find((candidate) => candidate.id === session.id)!;
    target.userTags = [' Alpha ', 'alpha', 42, '', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Sixth'];
    writeSessions(sessions);

    const result = await store.mutateSessionUserTag(session.id, { kind: 'remove', name: 'missing' });
    expect(result).toMatchObject({
      ok: true,
      action: 'updated',
      session: { userTags: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'] },
    });
    expect(store.getSessionMetadata(session.id)?.userTags).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
  });

  it('renames, confirms same-name merge, and deletes across Sessions in one commit', async () => {
    const first = await store.createSession('/tmp/tag-global-a');
    const second = await store.createSession('/tmp/tag-global-b');
    await store.mutateSessionUserTag(first.id, { kind: 'add', name: 'Source' });
    await store.mutateSessionUserTag(first.id, { kind: 'add', name: 'Target' });
    await store.mutateSessionUserTag(second.id, { kind: 'add', name: 'Source' });

    expect(await store.mutateGlobalSessionUserTag({
      kind: 'rename', name: 'Source', newName: 'Source',
    }, first.id)).toMatchObject({ ok: true, action: 'noop', affectedSessionCount: 0 });

    expect(await store.mutateGlobalSessionUserTag({
      kind: 'rename', name: 'Source', newName: 'Target',
    }, first.id)).toMatchObject({ ok: false, reason: 'merge-required', targetName: 'Target' });

    const merged = await store.mutateGlobalSessionUserTag({
      kind: 'rename', name: 'Source', newName: 'Target', merge: true,
    }, first.id);
    expect(merged).toMatchObject({
      ok: true,
      affectedSessionCount: 2,
      session: { userTags: ['Target'] },
      tags: expect.arrayContaining([{ name: 'Target', count: 2 }]),
    });
    expect(store.getSessionMetadata(second.id)?.userTags).toEqual(['Target']);

    const deleted = await store.mutateGlobalSessionUserTag({ kind: 'delete', name: 'Target' }, second.id);
    expect(deleted).toMatchObject({ ok: true, affectedSessionCount: 2 });
    expect(deleted.ok && deleted.session && 'userTags' in deleted.session).toBe(false);
    expect(store.listSessionUserTags().some((tag) => tag.name === 'Target')).toBe(false);
  });

  it('rejects a stale merge confirmation when its target disappeared', async () => {
    const session = await store.createSession('/tmp/tag-stale-merge');
    await store.mutateSessionUserTag(session.id, { kind: 'add', name: 'Source' });
    await store.mutateSessionUserTag(session.id, { kind: 'add', name: 'Target' });

    expect(await store.mutateGlobalSessionUserTag({
      kind: 'rename', name: 'Source', newName: 'Target',
    })).toMatchObject({ ok: false, reason: 'merge-required' });
    expect(await store.mutateGlobalSessionUserTag({ kind: 'delete', name: 'Target' }))
      .toMatchObject({ ok: true });

    expect(await store.mutateGlobalSessionUserTag({
      kind: 'rename', name: 'Source', newName: 'Target', merge: true,
    })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(store.getSessionMetadata(session.id)?.userTags).toEqual(['Source']);
  });

  it('rejects unpaired surrogates without changing the durable index', async () => {
    const session = await store.createSession('/tmp/tag-invalid-unicode');
    const before = readFileSync(sessionsPath(), 'utf-8');
    const result = await store.mutateSessionUserTag(session.id, {
      kind: 'add',
      name: `broken-${String.fromCharCode(0xD800)}`,
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(readFileSync(sessionsPath(), 'utf-8')).toBe(before);
  });

  it('preserves Tags during pending identity migration but does not inherit them into a new Session', async () => {
    const pending = await store.createSession('/tmp/tag-lifecycle', { id: 'pending-tag-lifecycle' });
    await store.mutateSessionUserTag(pending.id, { kind: 'add', name: 'Pinned context' });

    const migrated = await store.migratePendingSessionIdentity(
      pending.id,
      'real-tag-lifecycle',
      { sdkSessionId: 'real-tag-lifecycle', unifiedSession: true },
    );
    expect(migrated).toMatchObject({
      migrated: true,
      metadata: { id: 'real-tag-lifecycle', userTags: ['Pinned context'] },
    });

    const fresh = await store.createSession('/tmp/tag-lifecycle');
    expect(fresh.userTags).toBeUndefined();
  });

  it('does not overwrite sibling metadata mutations', async () => {
    const session = await store.createSession('/tmp/tag-sibling', { title: 'Before' });
    await Promise.all([
      store.mutateSessionUserTag(session.id, { kind: 'add', name: 'Keep me' }),
      store.updateSessionMetadata(session.id, { title: 'After', favorite: true }),
    ]);
    expect(store.getSessionMetadata(session.id)).toMatchObject({
      title: 'After',
      favorite: true,
      userTags: ['Keep me'],
    });
  });

  it('rejects protected Sessions and leaves the durable file unchanged after a batch write failure', async () => {
    const protectedSession = await store.createSession('/tmp/tag-protected');
    const sessions = readSessions();
    const protectedRow = sessions.find((candidate) => candidate.id === protectedSession.id)!;
    protectedRow.systemMaintenanceKind = 'memory_gardener';
    writeSessions(sessions);
    expect(await store.mutateSessionUserTag(protectedSession.id, { kind: 'add', name: 'Nope' }))
      .toMatchObject({ ok: false, reason: 'protected-session' });

    const writable = await store.createSession('/tmp/tag-io');
    await store.mutateSessionUserTag(writable.id, { kind: 'add', name: 'Durable' });
    const before = readFileSync(sessionsPath(), 'utf-8');
    const tmpPath = join(scratchHome, '.myagents', 'sessions.json.tmp');
    if (existsSync(tmpPath)) rmSync(tmpPath, { recursive: true, force: true });
    mkdirSync(tmpPath);
    const failed = await store.mutateGlobalSessionUserTag({
      kind: 'rename', name: 'Durable', newName: 'Should not commit',
    }, writable.id);
    expect(failed).toMatchObject({ ok: false, reason: 'io-error' });
    expect(readFileSync(sessionsPath(), 'utf-8')).toBe(before);
    rmSync(tmpPath, { recursive: true, force: true });
  });
});
