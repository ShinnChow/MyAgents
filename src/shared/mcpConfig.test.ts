import { describe, expect, it } from 'vitest';

import type { McpServerDefinition } from './config-types';
import {
  applyMcpServerConfigAdditions,
  promoteAgentMcpJsonToGlobal,
  removeMcpServerFromAppConfig,
  type McpConfigContainer,
} from './mcpConfig';

function remote(id: string): McpServerDefinition {
  return {
    id,
    name: id,
    type: 'http',
    url: `https://mcp.example.com/${id}`,
    headers: { Authorization: 'Bearer token' },
    isBuiltin: false,
  };
}

describe('MCP config helpers', () => {
  it('projects Browser Host desired settings as an opaque Runtime revision', () => {
    const playwright: McpServerDefinition = {
      id: 'playwright',
      name: 'Playwright',
      type: 'stdio',
      command: '__browser_host__',
      args: [],
      isBuiltin: true,
    };
    const isolated = applyMcpServerConfigAdditions([playwright], {
      playwrightBrowser: {
        schemaVersion: 1,
        mode: 'isolated',
        headless: false,
        capabilities: ['storage'],
        extraArgs: [],
      },
    });
    const persistent = applyMcpServerConfigAdditions([playwright], {
      playwrightBrowser: {
        schemaVersion: 1,
        mode: 'persistent',
        headless: false,
        capabilities: [],
        extraArgs: [],
      },
    });

    expect(isolated[0].runtimeConfigRevision).toMatch(/^playwright-browser-v1-[a-f0-9]{16}$/);
    expect(persistent[0].runtimeConfigRevision).not.toBe(isolated[0].runtimeConfigRevision);
    expect(JSON.stringify(isolated[0])).not.toContain('mode');
  });

  it('promotes selected Agent-only HTTP definitions into the global catalogue', () => {
    const server = remote('remote-http');
    const config: McpConfigContainer = {
      agents: [{
        id: 'agent-1',
        mcpEnabledServers: ['remote-http'],
        mcpServersJson: JSON.stringify([server]),
      }],
      mcpServers: [],
      mcpEnabledServers: [],
    };

    expect(promoteAgentMcpJsonToGlobal(config)).toBe(true);
    expect(config.mcpServers).toEqual([server]);
    expect(config.mcpEnabledServers).toEqual(['remote-http']);
  });

  it('removes a custom MCP server from global and Agent legacy payloads', () => {
    const target = remote('yuandian-law');
    const keep = remote('keep-law');
    const config: McpConfigContainer = {
      mcpServers: [target, keep],
      mcpEnabledServers: ['yuandian-law', 'keep-law'],
      mcpServerEnv: { 'yuandian-law': { TOKEN: 'secret' }, 'keep-law': { TOKEN: 'keep' } },
      mcpServerArgs: { 'yuandian-law': ['--stale'], 'keep-law': ['--keep'] },
      agents: [{
        id: 'agent-1',
        mcpEnabledServers: ['yuandian-law', 'keep-law'],
        mcpServersJson: JSON.stringify([target, keep]),
      }],
    };

    const next = removeMcpServerFromAppConfig(config, 'yuandian-law');
    const agent = next.agents?.[0] as { mcpEnabledServers?: string[]; mcpServersJson?: string };

    expect(next.mcpServers?.map(s => s.id)).toEqual(['keep-law']);
    expect(next.mcpEnabledServers).toEqual(['keep-law']);
    expect(next.mcpServerEnv).toEqual({ 'keep-law': { TOKEN: 'keep' } });
    expect(next.mcpServerArgs).toEqual({ 'keep-law': ['--keep'] });
    expect(agent.mcpEnabledServers).toEqual(['keep-law']);
    expect(JSON.parse(String(agent.mcpServersJson)).map((s: McpServerDefinition) => s.id))
      .toEqual(['keep-law']);
  });

  it('removes an empty Agent MCP JSON payload instead of leaving a resurrection source', () => {
    const target = remote('yuandian-law');
    const config: McpConfigContainer = {
      mcpServers: [target],
      mcpEnabledServers: ['yuandian-law'],
      agents: [{
        id: 'agent-1',
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([target]),
      }],
    };

    const next = removeMcpServerFromAppConfig(config, 'yuandian-law');
    const agent = next.agents?.[0] as { mcpEnabledServers?: string[]; mcpServersJson?: string };

    expect(next.mcpServers).toEqual([]);
    expect(next.mcpEnabledServers).toEqual([]);
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
  });

  it('removes matching Agent MCP JSON entries even when they are not promotable remote servers', () => {
    const stdio = {
      id: 'stdio-tool',
      name: 'stdio-tool',
      type: 'stdio',
      command: 'node',
      isBuiltin: false,
    };
    const config: McpConfigContainer = {
      mcpServers: [stdio as McpServerDefinition],
      mcpEnabledServers: ['stdio-tool'],
      agents: [{
        id: 'agent-1',
        mcpEnabledServers: ['stdio-tool'],
        mcpServersJson: JSON.stringify([stdio]),
      }],
    };

    const next = removeMcpServerFromAppConfig(config, 'stdio-tool');
    const agent = next.agents?.[0] as { mcpEnabledServers?: string[]; mcpServersJson?: string };

    expect(next.mcpServers).toEqual([]);
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
  });

  it('removes legacy IM Bot refs, runtime payloads, and launcher cache entries', () => {
    const target = remote('bot-tool');
    const keep = remote('keep-tool');
    const config: McpConfigContainer = {
      mcpServers: [target, keep],
      mcpEnabledServers: ['bot-tool', 'keep-tool'],
      imBotConfig: {
        id: 'legacy-single',
        mcpEnabledServers: ['bot-tool', 'keep-tool'],
        mcpServersJson: JSON.stringify([target, keep]),
      },
      imBotConfigs: [{
        id: 'legacy-list',
        mcpEnabledServers: ['bot-tool'],
        mcpServersJson: JSON.stringify([target]),
      }],
      launcherLastUsed: {
        mcpEnabledServers: ['bot-tool', 'keep-tool'],
      },
    };

    const next = removeMcpServerFromAppConfig(config, 'bot-tool');
    const legacySingle = next.imBotConfig as { mcpEnabledServers?: string[]; mcpServersJson?: string };
    const legacyList = next.imBotConfigs?.[0] as { mcpEnabledServers?: string[]; mcpServersJson?: string };
    const launcher = next.launcherLastUsed as { mcpEnabledServers?: string[] };

    expect(next.mcpServers?.map(s => s.id)).toEqual(['keep-tool']);
    expect(next.mcpEnabledServers).toEqual(['keep-tool']);
    expect(legacySingle.mcpEnabledServers).toEqual(['keep-tool']);
    expect(JSON.parse(String(legacySingle.mcpServersJson)).map((s: McpServerDefinition) => s.id))
      .toEqual(['keep-tool']);
    expect(legacyList.mcpEnabledServers).toEqual([]);
    expect(legacyList.mcpServersJson).toBeUndefined();
    expect(launcher.mcpEnabledServers).toEqual(['keep-tool']);
  });
});
