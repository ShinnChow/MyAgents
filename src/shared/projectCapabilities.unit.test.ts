import { describe, expect, it } from 'vitest';

import {
  assertProductSystemSkillCandidate,
  normalizeProjectCapabilitySelection,
  parseProjectCapabilityId,
  projectCapabilityId,
} from './projectCapabilities';
import { TASK_ALIGNMENT_SKILL_REQUIREMENT } from './systemSkills';
import type { EffectiveProjectCapabilitySnapshot } from './projectCapabilities';

function productSnapshot(overrides: Partial<EffectiveProjectCapabilitySnapshot['enabledSkills'][number]> = {}): EffectiveProjectCapabilitySnapshot {
  const candidate = {
    id: 'global:skill:myagents-task-alignment',
    kind: 'skill' as const,
    source: 'global' as const,
    sourceLocalId: 'myagents-task-alignment',
    canonicalName: 'myagents-task-alignment',
    name: 'myagents-task-alignment',
    description: 'Task discussion',
    path: '/skills/myagents-task-alignment/SKILL.md',
    required: true,
    systemOwned: true,
    enabled: true,
    contentSha256: TASK_ALIGNMENT_SKILL_REQUIREMENT.contentSha256,
    ...overrides,
  };
  return {
    workspacePath: '/workspace',
    agentId: 'agent',
    revision: 'capability-revision',
    integrityRevision: 'inventory-revision',
    integrityIssues: [],
    candidates: [candidate],
    enabledSkills: [candidate],
    enabledCommands: [],
  };
}

describe('project capability selection contract', () => {
  it('admits only the exact app-owned Task alignment winner', () => {
    expect(assertProductSystemSkillCandidate(
      productSnapshot(),
      TASK_ALIGNMENT_SKILL_REQUIREMENT,
    ).source).toBe('global');

    expect(() => assertProductSystemSkillCandidate(
      productSnapshot({ source: 'project', systemOwned: false }),
      TASK_ALIGNMENT_SKILL_REQUIREMENT,
    )).toThrow('not the app-owned global winner');
    expect(() => assertProductSystemSkillCandidate(
      productSnapshot({ contentSha256: 'tampered' }),
      TASK_ALIGNMENT_SKILL_REQUIREMENT,
    )).toThrow('does not match the app bundle');
  });

  it('defaults to enabled by normalizing an absent override to empty disabled lists', () => {
    expect(normalizeProjectCapabilitySelection(undefined)).toEqual({
      version: 1,
      disabled: { skills: [], commands: [] },
    });
  });

  it('uses exact source/kind/local identities and preserves nested command paths', () => {
    const id = projectCapabilityId('project', 'command', 'release/ship');
    expect(id).toBe('project:command:release/ship');
    expect(parseProjectCapabilityId(id)).toEqual({
      source: 'project',
      kind: 'command',
      sourceLocalId: 'release/ship',
    });

    const skillId = projectCapabilityId('project', 'skill', 'review:local');
    expect(skillId).toBe('project:skill:review:local');
    expect(parseProjectCapabilityId(skillId).sourceLocalId).toBe('review:local');
  });

  it('fails closed for unknown schema versions and invalid identities', () => {
    expect(() => normalizeProjectCapabilitySelection({ version: 2, disabled: {} })).toThrow(
      'Unsupported capabilitySelection version',
    );
    expect(() => normalizeProjectCapabilitySelection({
      version: 1,
      disabled: { skills: ['project:skill:../escape'] },
    })).toThrow('Skill capability source id must be one folder name');
  });

  it('canonicalizes global Required disables without guessing project frontmatter identity', () => {
    expect(normalizeProjectCapabilitySelection({
      version: 1,
      disabled: { skills: ['global:skill:myagents-cli'] },
    }).disabled.skills).toEqual([]);
    expect(normalizeProjectCapabilitySelection({
      version: 1,
      disabled: { skills: ['project:skill:myagents-cli'] },
    }).disabled.skills).toEqual(['project:skill:myagents-cli']);
  });
});
