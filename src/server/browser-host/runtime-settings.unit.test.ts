import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import type { PlaywrightBrowserSettings } from '../../shared/config-types';
import { compileBrowserRuntimeSettings } from './runtime-settings';

function settings(patch: Partial<PlaywrightBrowserSettings> = {}): PlaywrightBrowserSettings {
  return {
    schemaVersion: 1,
    mode: 'isolated',
    headless: false,
    capabilities: ['storage'],
    extraArgs: [],
    ...patch,
  };
}

describe('compileBrowserRuntimeSettings', () => {
  it('maps supported advanced settings through public Playwright config', () => {
    const compiled = compileBrowserRuntimeSettings(settings({
      browser: 'chrome',
      headless: true,
      extraArgs: [
        '--proxy-server=http://127.0.0.1:8123',
        '--proxy-bypass=.internal',
        '--viewport-size=1280x720',
        '--block-service-workers',
        '--save-trace',
      ],
    }), 'session-a', '/workspace/a');

    expect(compiled).toMatchObject({
      browserName: 'chromium',
      launchOptions: {
        channel: 'chrome',
        headless: true,
        proxy: { server: 'http://127.0.0.1:8123', bypass: '.internal' },
      },
      contextOptions: {
        viewport: { width: 1280, height: 720 },
        serviceWorkers: 'block',
      },
      connectionConfig: {
        allowUnrestrictedFileAccess: false,
        saveTrace: true,
        outputDir: '/workspace/a/.myagents/browser-artifacts/session-a',
      },
    });
  });

  it.each([
    '--allow-unrestricted-file-access',
    '--shared-browser-context',
    '--storage-state=/tmp/foreign.json',
    '--output-dir=/tmp/foreign',
  ])('rejects lifecycle or security authority %s', option => {
    expect(() => compileBrowserRuntimeSettings(
      settings({ extraArgs: [option] }),
      'session-a',
      '/workspace/a',
    )).toThrow('BROWSER_CONFIG_UNSUPPORTED');
  });

  it('compiles bounded video capture through the public MCP config', () => {
    expect(compileBrowserRuntimeSettings(settings({
      extraArgs: ['--save-video=1280x720'],
    }), 'session-a', '/workspace/a').connectionConfig.saveVideo).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it('rejects an artifact directory symlink that escapes the authorized workspace', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'myagents-browser-root-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(join(workspace, '.myagents'), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, '.myagents', 'browser-artifacts'));
    try {
      expect(() => compileBrowserRuntimeSettings(
        settings(),
        'session-a',
        workspace,
      )).toThrow('BROWSER_ARTIFACT_ROOT_INVALID');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
