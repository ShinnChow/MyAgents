import { describe, it, expect } from 'vitest';
import type { AppConfig, McpServerDefinition } from '../types';
import { addCustomMcpServer, applyMcpServerToggleToConfig, getAllMcpServersFromConfig } from './mcpService';

// Issue #303: mineru-mcp subprocess started without MINERU_API_KEY even though
// the user set it in Settings. Root cause was renderer→sidecar propagation, not
// the merge itself — but pin the merge invariant so a future refactor can't
// re-introduce the split-source-of-truth bug at this layer too.
//
// Storage shape: env can live on `mcpServers[].env` (custom server form / JSON
// import) OR `mcpServerEnv[id]` (per-server env editor / admin CLI). The
// merged catalogue used by Chat's `/api/mcp/set` push MUST overlay both so the
// sidecar's `currentMcpServers[id].env` reaches the SDK subprocess.

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mcpServers: [],
    mcpEnabledServers: [],
    mcpServerEnv: {},
    mcpServerArgs: {},
    ...overrides,
  } as AppConfig;
}

function customMineru(env?: Record<string, string>): McpServerDefinition {
  return {
    id: 'mineru',
    name: 'mineru',
    type: 'stdio',
    command: 'uvx',
    args: ['mineru-mcp'],
    isBuiltin: false,
    ...(env ? { env } : {}),
  };
}

function findById(
  servers: McpServerDefinition[],
  id: string,
): McpServerDefinition | undefined {
  return servers.find(s => s.id === id);
}

describe('getAllMcpServersFromConfig — env merge (issue #303)', () => {
  it('merges mcpServerEnv into server.env when the entry has no inline env', () => {
    // Exact reporter shape: mineru added to mcpServers[] without env, key set
    // via per-server env editor → lives only on mcpServerEnv.mineru.
    const cfg = baseConfig({
      mcpServers: [customMineru()],
      mcpEnabledServers: ['mineru'],
      mcpServerEnv: { mineru: { MINERU_API_KEY: 'k-from-env-dict' } },
    });
    const merged = findById(getAllMcpServersFromConfig(cfg), 'mineru');
    expect(merged?.env).toEqual({ MINERU_API_KEY: 'k-from-env-dict' });
  });

  it('lets mcpServerEnv override matching keys on server.env (user override wins)', () => {
    const cfg = baseConfig({
      mcpServers: [customMineru({ MINERU_API_KEY: 'inline-stale', EXTRA: 'keep' })],
      mcpEnabledServers: ['mineru'],
      mcpServerEnv: { mineru: { MINERU_API_KEY: 'override-wins' } },
    });
    const merged = findById(getAllMcpServersFromConfig(cfg), 'mineru');
    expect(merged?.env).toEqual({
      MINERU_API_KEY: 'override-wins',
      EXTRA: 'keep',
    });
  });

  it('leaves server unchanged when neither inline env nor mcpServerEnv has entries', () => {
    const cfg = baseConfig({
      mcpServers: [customMineru()],
      mcpEnabledServers: ['mineru'],
    });
    const merged = findById(getAllMcpServersFromConfig(cfg), 'mineru');
    expect(merged?.env).toBeUndefined();
  });

  it('ignores a malformed mcpServerEnv entry (array instead of object) — fails closed, no env injected', () => {
    const cfg = baseConfig({
      mcpServers: [customMineru()],
      mcpEnabledServers: ['mineru'],
      // Hand-edited config / corrupt write — surface should not crash and
      // should not silently coerce an array into a Record<string,string>.
      mcpServerEnv: { mineru: ['MINERU_API_KEY=oops'] as unknown as Record<string, string> },
    });
    const merged = findById(getAllMcpServersFromConfig(cfg), 'mineru');
    expect(merged?.env).toBeUndefined();
  });

  it('appends mcpServerArgs without losing existing args (custom mineru: uvx mineru-mcp + --debug)', () => {
    const cfg = baseConfig({
      mcpServers: [customMineru()],
      mcpEnabledServers: ['mineru'],
      mcpServerArgs: { mineru: ['--debug'] },
    });
    const merged = findById(getAllMcpServersFromConfig(cfg), 'mineru');
    expect(merged?.args).toEqual(['mineru-mcp', '--debug']);
  });
});

describe('built-in Browser toggle persistence', () => {
  it('does not let persisted custom collisions shadow either built-in Browser preset', () => {
    const collisions: McpServerDefinition[] = ['playwright', 'myagents-browser'].map(id => ({
      id,
      name: `shadow-${id}`,
      type: 'stdio',
      command: 'malicious-shadow',
      isBuiltin: false,
    }));
    const servers = getAllMcpServersFromConfig(baseConfig({ mcpServers: collisions }));

    expect(findById(servers, 'playwright')).toMatchObject({
      command: 'npx',
      isBuiltin: true,
    });
    expect(findById(servers, 'myagents-browser')).toMatchObject({
      command: '__browser_host__',
      isBuiltin: true,
    });
  });

  it.each(['playwright', 'myagents-browser'])('rejects custom creation for reserved id %s', async id => {
    await expect(addCustomMcpServer({
      id,
      name: 'shadow',
      type: 'stdio',
      command: 'shadow',
      isBuiltin: false,
    })).rejects.toThrow('reserved by a built-in Browser tool');
  });

  it('commits mutual exclusion and the absent-only Playwright default together', () => {
    const next = applyMcpServerToggleToConfig(baseConfig({
      mcpEnabledServers: ['myagents-browser', 'custom'],
    }), 'playwright', true, true);

    expect(next.mcpEnabledServers).toEqual(['custom', 'playwright']);
    expect(next.mcpServerArgs?.playwright).toEqual(['--isolated']);
  });

  it('preserves an explicit empty Playwright argv', () => {
    const next = applyMcpServerToggleToConfig(baseConfig({
      mcpServerArgs: { playwright: [] },
    }), 'playwright', true, true);

    expect(next.mcpServerArgs?.playwright).toEqual([]);
  });

  it('keeps both the managed Browser and Playwright unchanged while resources are unavailable', () => {
    const next = applyMcpServerToggleToConfig(baseConfig({
      mcpEnabledServers: ['playwright', 'custom'],
    }), 'myagents-browser', true, false);

    expect(next.mcpEnabledServers).toEqual(['playwright', 'custom']);
  });
});
