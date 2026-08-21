import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createConnection } from '@playwright/mcp';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Explicit release smoke for the package-root API used by Browser Host.
 *
 * Run against a prepared Playwright runtime, or a local Chrome installation:
 *   MYAGENTS_PLAYWRIGHT_BROWSER_SMOKE=1 \
 *   MYAGENTS_PLAYWRIGHT_BROWSER_CHANNEL=chrome \
 *   npm run test:credentialed -- playwright-browser-host
 */
describe.runIf(process.env.MYAGENTS_PLAYWRIGHT_BROWSER_SMOKE === '1')(
  '@playwright/mcp Browser Host release smoke',
  () => {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;

    afterEach(async () => {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    });

    it('navigates and snapshots through the public createConnection API', async () => {
      const channel = process.env.MYAGENTS_PLAYWRIGHT_BROWSER_CHANNEL;
      browser = await chromium.launch({
        headless: true,
        ...(channel ? { channel } : {}),
      });
      context = await browser.newContext();

      const server = await createConnection(
        {
          browser: { isolated: true },
          capabilities: ['core'],
          allowUnrestrictedFileAccess: false,
          outputMode: 'stdout',
        },
        async () => context!,
      );
      const serverTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      });
      await server.connect(serverTransport);
      const clientTransport = new StreamableHTTPClientTransport(
        new URL('http://127.0.0.1/internal/playwright'),
        { fetch: (input, init) => serverTransport.handleRequest(new Request(input, init)) },
      );
      const client = new Client({ name: 'myagents-browser-host-smoke', version: '0.4.10' });

      try {
        await client.connect(clientTransport);
        const navigate = await client.callTool({
          name: 'browser_navigate',
          arguments: {
            url: 'data:text/html,<title>MyAgents Browser Host</title><h1>ready</h1>',
          },
        });
        const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });

        expect(navigate.isError).not.toBe(true);
        expect(snapshot.isError).not.toBe(true);
        expect(JSON.stringify(snapshot.content)).toContain('ready');
      } finally {
        await client.close();
        await server.close();
      }
    });
  },
);
