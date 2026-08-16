import { describe, expect, it } from 'vitest';

import {
  normalizeSpaceErrorCode,
  normalizeSpaceMutationOperation,
  normalizeSpaceMutationSurface,
} from './spaceMetrics';

describe('space analytics metrics', () => {
  it('normalizes mutation operations into the analytics allowlist', () => {
    expect(normalizeSpaceMutationOperation('issue.create')).toBe('create');
    expect(normalizeSpaceMutationOperation('issue.state')).toBe('state_change');
    expect(normalizeSpaceMutationOperation('issue.cancel_claim')).toBe('cancel_claim');
    expect(normalizeSpaceMutationOperation('skill.install')).toBe('install');
    expect(normalizeSpaceMutationOperation('tool.publish')).toBe('publish');
    expect(normalizeSpaceMutationOperation('tool.update')).toBe('update');
    expect(normalizeSpaceMutationOperation('tool.rollback')).toBe('rollback');
    expect(normalizeSpaceMutationOperation('tool.delete')).toBe('delete');
    expect(normalizeSpaceMutationOperation('tool.install')).toBe('install');
    expect(normalizeSpaceMutationOperation('tool.helper_launch')).toBe('helper_launch');
    expect(normalizeSpaceMutationOperation('agent.revoke')).toBe('revoke');
    expect(normalizeSpaceMutationOperation('member.approve')).toBe('approve');
    expect(normalizeSpaceMutationOperation('member.role')).toBe('role_update');
    expect(normalizeSpaceMutationOperation('profile.update')).toBe('profile_update');
    expect(normalizeSpaceMutationOperation('settings.create')).toBe('create');
    expect(normalizeSpaceMutationOperation('unknown.raw.user.input')).toBe('settings_update');
  });

  it('normalizes mutation surfaces without exposing entity ids or names', () => {
    expect(normalizeSpaceMutationSurface('issue.comment')).toBe('issue_detail');
    expect(normalizeSpaceMutationSurface('goal.archive')).toBe('goals');
    expect(normalizeSpaceMutationSurface('skill.upload')).toBe('skills');
    expect(normalizeSpaceMutationSurface('tool.install')).toBe('tools');
    expect(normalizeSpaceMutationSurface('agent.update')).toBe('agents');
    expect(normalizeSpaceMutationSurface('member.remove')).toBe('members');
    expect(normalizeSpaceMutationSurface('profile.update')).toBe('settings');
  });

  it('buckets raw errors without returning the raw message', () => {
    expect(normalizeSpaceErrorCode(new Error('HTTP 403 user@example.com cannot edit issue secret-title'))).toBe('forbidden');
    expect(normalizeSpaceErrorCode('Load failed while fetching')).toBe('network_error');
    expect(normalizeSpaceErrorCode('HTTP 429 slow down')).toBe('rate_limited');
    expect(normalizeSpaceErrorCode('totally custom private error')).toBe('unknown');
  });
});
