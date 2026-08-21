import { describe, expect, it } from 'vitest';

import type { AppConfig } from './config-types';

import {
  DEFAULT_PLAYWRIGHT_BROWSER_SETTINGS,
  compilePlaywrightHostArgs,
  migrateLegacyPlaywrightArgs,
  normalizePlaywrightBrowserConfig,
  resolvePlaywrightBrowserConfig,
} from './playwrightBrowser';

describe('Playwright Browser desired-state migration', () => {
  it('defaults a new or never-configured install to isolated mode', () => {
    expect(resolvePlaywrightBrowserConfig({})).toEqual({
      settings: DEFAULT_PLAYWRIGHT_BROWSER_SETTINGS,
      source: 'default',
    });
    expect(migrateLegacyPlaywrightArgs([]).settings.mode).toBe('isolated');
    expect(migrateLegacyPlaywrightArgs(['--headless']).settings.mode).toBe('isolated');
  });

  it('preserves an explicitly persistent legacy profile', () => {
    const config: Pick<AppConfig, 'mcpServerArgs' | 'playwrightBrowser'> = {
      mcpServerArgs: {
        playwright: ['--user-data-dir=/profiles/pw', '--browser=chrome', '--headless'],
        keep: ['--verbose'],
      },
    };

    const normalized = normalizePlaywrightBrowserConfig(config);

    expect(normalized.playwrightBrowser).toMatchObject({
      mode: 'persistent',
      userDataDir: '/profiles/pw',
      browser: 'chrome',
      headless: true,
    });
    expect(config.mcpServerArgs).toEqual({ keep: ['--verbose'] });
  });

  it('migrates supported legacy flags in split argv form', () => {
    expect(migrateLegacyPlaywrightArgs([
      '--browser', 'chrome',
      '--device', 'iPhone 15',
      '--user-data-dir', '/profiles/pw',
      '--proxy-server', 'http://127.0.0.1:8080',
    ])).toMatchObject({
      settings: {
        mode: 'persistent',
        browser: 'chrome',
        device: 'iPhone 15',
        userDataDir: '/profiles/pw',
        extraArgs: ['--proxy-server=http://127.0.0.1:8080'],
      },
    });
  });

  it('preserves isolated capabilities and supported upstream args', () => {
    expect(migrateLegacyPlaywrightArgs([
      '--isolated',
      '--caps=pdf,storage',
      '--device=iPhone 15',
      '--proxy-server=http://127.0.0.1:8080',
    ])).toMatchObject({
      source: 'legacy',
      settings: {
        mode: 'isolated',
        device: 'iPhone 15',
        capabilities: ['storage', 'pdf'],
        extraArgs: ['--proxy-server=http://127.0.0.1:8080'],
      },
    });
  });

  it('keeps unsupported legacy arguments visible instead of guessing', () => {
    const config: Pick<AppConfig, 'mcpServerArgs' | 'playwrightBrowser'> = {
      mcpServerArgs: { playwright: ['--isolated', '--future-owner=/unknown'] },
    };

    normalizePlaywrightBrowserConfig(config);

    expect(config.playwrightBrowser).toBeUndefined();
    expect(config.mcpServerArgs?.playwright).toEqual(['--isolated', '--future-owner=/unknown']);
    expect(resolvePlaywrightBrowserConfig(config).migrationError).toContain(
      'unsupported argument: --future-owner=/unknown',
    );
  });

  it('does not delete conflicting legacy lifecycle input', () => {
    const config: Pick<AppConfig, 'mcpServerArgs' | 'playwrightBrowser'> = {
      mcpServerArgs: {
        playwright: ['--isolated', '--user-data-dir=/profiles/conflict'],
      },
    };

    normalizePlaywrightBrowserConfig(config);

    expect(config.mcpServerArgs?.playwright).toEqual([
      '--isolated',
      '--user-data-dir=/profiles/conflict',
    ]);
    expect(resolvePlaywrightBrowserConfig(config).migrationError).toContain(
      'combines --isolated with --user-data-dir',
    );
    expect(config.playwrightBrowser).toBeUndefined();
  });

  it('normalizes typed settings and compiles lifecycle-safe host args', () => {
    const resolved = resolvePlaywrightBrowserConfig({
      playwrightBrowser: {
        schemaVersion: 1,
        mode: 'isolated',
        headless: true,
        browser: ' chrome ',
        capabilities: ['pdf', 'storage', 'pdf'],
        extraArgs: [
          '--proxy-server=http://127.0.0.1:8080',
        ],
      },
    });

    expect(compilePlaywrightHostArgs(resolved.settings)).toEqual([
      '--headless',
      '--browser=chrome',
      '--caps=storage,pdf',
      '--proxy-server=http://127.0.0.1:8080',
    ]);
  });

  it('rejects typed settings that try to smuggle lifecycle or unknown arguments', () => {
    for (const extraArg of ['--isolated', '--user-data-dir=/must-not-leak', '--future-flag']) {
      expect(resolvePlaywrightBrowserConfig({
        playwrightBrowser: {
          schemaVersion: 1,
          mode: 'isolated',
          headless: false,
          capabilities: ['storage'],
          extraArgs: [extraArg],
        },
      }).migrationError).toContain('unsupported or malformed schema');
    }
  });

  it('rejects an unknown schema, browser, or isolated Profile path without silently dropping it', () => {
    for (const playwrightBrowser of [
      {
        schemaVersion: 2,
        mode: 'isolated',
        headless: false,
        capabilities: ['storage'],
        extraArgs: [],
      },
      {
        schemaVersion: 1,
        mode: 'isolated',
        headless: false,
        browser: 'future-browser',
        capabilities: ['storage'],
        extraArgs: [],
      },
      {
        schemaVersion: 1,
        mode: 'isolated',
        headless: false,
        userDataDir: '/must-not-be-dropped',
        capabilities: ['storage'],
        extraArgs: [],
      },
    ]) {
      expect(resolvePlaywrightBrowserConfig({ playwrightBrowser }).migrationError)
        .toContain('unsupported or malformed schema');
    }
  });

  it('rejects unknown capabilities and preserves a failed legacy migration', () => {
    expect(resolvePlaywrightBrowserConfig({
      playwrightBrowser: {
        schemaVersion: 1,
        mode: 'isolated',
        headless: false,
        capabilities: ['storage', 'future-capability'],
        extraArgs: [],
      },
    }).migrationError).toContain('unsupported or malformed schema');

    const legacy = migrateLegacyPlaywrightArgs(['--isolated', '--caps=vision,future-capability']);
    expect(legacy.settings.capabilities).toEqual(['storage', 'vision']);
    expect(legacy.migrationError).toContain('unsupported capability: future-capability');
  });

  it('migrates the legacy vision alias and supported video capture option', () => {
    expect(migrateLegacyPlaywrightArgs([
      '--isolated',
      '--vision',
      '--save-video=1280x720',
    ])).toMatchObject({
      settings: {
        capabilities: ['storage', 'vision'],
        extraArgs: ['--save-video=1280x720'],
      },
    });
  });
});
