import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('managed Browser runtime identity contract', () => {
  it('keys Browser Host replacement to the managed tool rather than standard Playwright', () => {
    const source = readFileSync(new URL('agent-session.ts', import.meta.url), 'utf8');

    expect(source).toContain('Object.hasOwn(servers, MANAGED_BROWSER_MCP_ID)');
    expect(source).not.toContain('browser-storage-state.json');
  });

  it('projects the managed tool ID through Codex startup and recovery', () => {
    const source = readFileSync(new URL('runtimes/codex.ts', import.meta.url), 'utf8');

    expect(source).toContain('...(usesManagedBrowserHost ? [MANAGED_BROWSER_MCP_ID] : [])');
    expect(source).toContain('serverId: MANAGED_BROWSER_MCP_ID');
    expect(source).not.toContain("usesManagedBrowserHost ? ['playwright']");
  });
});
