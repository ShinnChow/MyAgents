import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAllMcpServers, resolveWorkspaceConfig } from './admin-config';

const scratchDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe('server MCP catalogue merge', () => {
  it('projects legacy Playwright args onto the Browser Host preset', () => {
    const servers = getAllMcpServers({
      mcpServers: [],
      mcpEnabledServers: ['playwright'],
      mcpServerArgs: {
        playwright: ['--user-data-dir=/tmp/playwright-profile'],
      },
    });

    expect(servers.find((server) => server.id === 'playwright')).toMatchObject({
      command: '__browser_host__',
      args: ['--user-data-dir=/tmp/playwright-profile'],
    });
  });

  it('resolves owned Session IDs against current definitions and global enablement', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'myagents-admin-config-'));
    scratchDirs.push(scratch);
    const configDir = join(scratch, '.myagents');
    mkdirSync(configDir, { recursive: true });
    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', scratch);
    const configPath = join(configDir, 'config.json');
    const writeConfig = (enabledIds: string[], command: string): void => {
      writeFileSync(configPath, JSON.stringify({
        mcpServers: [
          { id: 'owned', name: 'Owned', type: 'stdio', command, isBuiltin: false },
          { id: 'workspace-default', name: 'Workspace default', type: 'stdio', command: 'workspace', isBuiltin: false },
        ],
        mcpEnabledServers: enabledIds,
      }), 'utf8');
    };
    const metadata = {
      configSnapshotAt: '2026-08-05T00:00:00.000Z',
      mcpEnabledServers: ['owned'],
    } as never;

    writeConfig(['owned', 'workspace-default'], 'current-command');
    expect(resolveWorkspaceConfig('/workspace', metadata, { includeMcp: true }).mcpServers)
      .toEqual([expect.objectContaining({ id: 'owned', command: 'current-command' })]);

    writeConfig(['workspace-default'], 'newer-but-disabled-command');
    expect(resolveWorkspaceConfig('/workspace', metadata, { includeMcp: true }).mcpServers)
      .toEqual([]);
  });
});
