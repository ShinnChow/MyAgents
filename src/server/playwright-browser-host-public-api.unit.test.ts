import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createConnection } from '@playwright/mcp';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';

/**
 * Release gate for the only upstream surface Browser Host is allowed to use.
 * It deliberately exercises package-root createConnection over a public MCP
 * Streamable HTTP transport without launching a browser or touching network.
 */
describe('@playwright/mcp public Browser Host API', () => {
  it('connects through Streamable HTTP and publishes browser tools', async () => {
    let contextRequested = false;
    const server = await createConnection(
      {
        browser: { isolated: true },
        capabilities: ['core', 'storage'],
        allowUnrestrictedFileAccess: false,
        outputMode: 'stdout',
      },
      async () => {
        contextRequested = true;
        throw new Error('tool listing must not launch or request a BrowserContext');
      },
    );
    const serverTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });
    await server.connect(serverTransport);

    const clientTransport = new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1/internal/playwright'),
      {
        fetch: (input, init) => serverTransport.handleRequest(new Request(input, init)),
      },
    );
    const client = new Client({ name: 'myagents-browser-host-spike', version: '0.4.10' });

    try {
      await client.connect(clientTransport);
      const catalog = await client.listTools();
      expect(catalog.tools.some(tool => tool.name === 'browser_navigate')).toBe(true);
      expect(catalog.tools.some(tool => tool.name === 'browser_storage_state')).toBe(true);
      expect(contextRequested).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('accepts a public BrowserContext getter type', async () => {
    const contextGetter = async (): Promise<BrowserContext> => {
      throw new Error('not invoked in this type contract');
    };
    const server = await createConnection({}, contextGetter);
    await server.close();
  });
});
