import { describe, expect, it } from 'vitest';

import {
  readyMcpToolCount,
  reduceMcpEffectiveSnapshot,
  type McpEffectiveSnapshot,
} from './mcpEffectiveState';

function snapshot(overrides: Partial<McpEffectiveSnapshot> = {}): McpEffectiveSnapshot {
  return {
    sessionId: 'session-a',
    runtime: 'builtin',
    runtimeGeneration: 1,
    configGeneration: 1,
    configFingerprint: 'one',
    catalogGeneration: 1,
    revision: 1,
    observedAt: 1,
    dispatch: { state: 'waiting' },
    servers: [],
    tools: [],
    ...overrides,
  };
}

describe('MCP effective snapshot reducer', () => {
  it('rejects stale revisions, configs, runtimes, and another Product Session', () => {
    const current = snapshot({ runtimeGeneration: 3, configGeneration: 4, catalogGeneration: 5, revision: 5 });
    expect(reduceMcpEffectiveSnapshot(current, snapshot({ runtimeGeneration: 3, configGeneration: 4, catalogGeneration: 5, revision: 4 }))).toBe(current);
    expect(reduceMcpEffectiveSnapshot(current, snapshot({ runtimeGeneration: 3, configGeneration: 4, catalogGeneration: 4, revision: 99 }))).toBe(current);
    expect(reduceMcpEffectiveSnapshot(current, snapshot({ runtimeGeneration: 3, configGeneration: 3, revision: 99 }))).toBe(current);
    expect(reduceMcpEffectiveSnapshot(current, snapshot({ runtimeGeneration: 2, configGeneration: 99, revision: 99 }))).toBe(current);
    expect(reduceMcpEffectiveSnapshot(current, snapshot({ sessionId: 'session-b', runtimeGeneration: 99 }))).toBe(current);
  });

  it('accepts a later config or runtime generation even when local revision resets', () => {
    const current = snapshot({ runtimeGeneration: 1, configGeneration: 9, revision: 12 });
    expect(reduceMcpEffectiveSnapshot(current, snapshot({ runtimeGeneration: 1, configGeneration: 10, revision: 1 }))?.configGeneration).toBe(10);
    expect(reduceMcpEffectiveSnapshot(current, snapshot({ runtimeGeneration: 2, configGeneration: 1, revision: 1 }))?.runtimeGeneration).toBe(2);
  });

  it('accepts a later catalog generation and rejects a late catalog callback', () => {
    const current = snapshot({ catalogGeneration: 3, revision: 7 });
    expect(reduceMcpEffectiveSnapshot(current, snapshot({ catalogGeneration: 4, revision: 1 }))?.catalogGeneration).toBe(4);
    expect(reduceMcpEffectiveSnapshot(current, snapshot({ catalogGeneration: 2, revision: 99 }))).toBe(current);
  });

  it('counts only ready desired server tools', () => {
    expect(readyMcpToolCount(snapshot({
      servers: [
        { id: 'ready', desired: true, state: 'ready', toolCount: 4, attemptGeneration: 1, updatedAt: 1 },
        { id: 'starting', desired: true, state: 'starting', toolCount: 8, attemptGeneration: 1, updatedAt: 1 },
        { id: 'disabled', desired: false, state: 'ready', toolCount: 2, attemptGeneration: 1, updatedAt: 1 },
      ],
    }))).toBe(4);
  });
});
