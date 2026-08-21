import { existsSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'path';

import { createConnection } from '@playwright/mcp';
import type { BrowserContextOptions, LaunchOptions } from 'playwright';

import type { PlaywrightBrowserSettings } from '../../shared/config-types';
import {
  isSupportedPlaywrightAdvancedArg,
  normalizePlaywrightBrowserSettings,
} from '../../shared/playwrightBrowser';

export type PlaywrightConnectionConfig = NonNullable<Parameters<typeof createConnection>[0]>;

export interface CompiledBrowserRuntimeSettings {
  browserName: 'chromium' | 'firefox' | 'webkit';
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
  connectionConfig: PlaywrightConnectionConfig;
}

function parseViewport(value: string): { width: number; height: number } | null {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 100 || height < 100 || width > 16_384 || height > 16_384) return null;
  return { width, height };
}

function parseInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`BROWSER_CONFIG_UNSUPPORTED: ${flag} requires a non-negative integer`);
  }
  return number;
}

function assertArtifactRoot(workspacePath: string, productSessionId: string): string {
  const canonicalizeExistingPrefix = (path: string): string => {
    const suffix: string[] = [];
    let cursor = resolve(path);
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
    return resolve(realpathSync(cursor), ...suffix);
  };
  const workspace = canonicalizeExistingPrefix(workspacePath);
  const safeSession = productSessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
  const output = canonicalizeExistingPrefix(
    resolve(workspace, '.myagents', 'browser-artifacts', safeSession || 'session'),
  );
  const relativeOutput = relative(workspace, output);
  if (relativeOutput === '..' || relativeOutput.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativeOutput)) {
    throw new Error('BROWSER_ARTIFACT_ROOT_INVALID');
  }
  return output;
}

/**
 * Compile historical advanced flags into public Playwright/MCP configuration.
 * Transport, profile, storage, output-root, extension and unrestricted-file
 * flags are lifecycle/security authorities owned by MyAgents and are rejected.
 */
export function compileBrowserRuntimeSettings(
  rawSettings: PlaywrightBrowserSettings,
  productSessionId: string,
  workspacePath: string,
): CompiledBrowserRuntimeSettings {
  const settings = normalizePlaywrightBrowserSettings(rawSettings);
  if (!settings) throw new Error('BROWSER_CONFIG_UNSUPPORTED: malformed typed settings');

  let browserName: 'chromium' | 'firefox' | 'webkit' = 'chromium';
  const launchOptions: LaunchOptions = { headless: settings.headless };
  if (settings.browser === 'firefox' || settings.browser === 'webkit') {
    browserName = settings.browser;
  } else if (settings.browser === 'chrome' || settings.browser === 'msedge') {
    launchOptions.channel = settings.browser;
  } else if (settings.browser && settings.browser !== 'chromium') {
    throw new Error(`BROWSER_CONFIG_UNSUPPORTED: unknown browser ${settings.browser}`);
  }

  const contextOptions: BrowserContextOptions = {};
  const connectionConfig: PlaywrightConnectionConfig = {
    capabilities: settings.capabilities as PlaywrightConnectionConfig['capabilities'],
    allowUnrestrictedFileAccess: false,
    outputDir: assertArtifactRoot(workspacePath, productSessionId),
    outputMode: 'stdout',
  };
  let proxyServer: string | undefined;
  let proxyBypass: string | undefined;

  for (const arg of settings.extraArgs) {
    if (!isSupportedPlaywrightAdvancedArg(arg)) {
      throw new Error(`BROWSER_CONFIG_UNSUPPORTED: unsupported advanced option ${arg}`);
    }
    if (arg === '--block-service-workers') {
      contextOptions.serviceWorkers = 'block';
    } else if (arg === '--ignore-https-errors') {
      contextOptions.ignoreHTTPSErrors = true;
    } else if (arg === '--no-sandbox') {
      launchOptions.chromiumSandbox = false;
    } else if (arg === '--sandbox') {
      launchOptions.chromiumSandbox = true;
    } else if (arg === '--save-session') {
      connectionConfig.saveSession = true;
    } else if (arg === '--save-trace') {
      connectionConfig.saveTrace = true;
    } else if (arg.startsWith('--save-video=')) {
      const viewport = parseViewport(arg.slice('--save-video='.length));
      if (!viewport) throw new Error('BROWSER_CONFIG_UNSUPPORTED: invalid --save-video');
      connectionConfig.saveVideo = viewport;
    } else if (arg.startsWith('--proxy-server=')) {
      proxyServer = arg.slice('--proxy-server='.length).trim();
    } else if (arg.startsWith('--proxy-bypass=')) {
      proxyBypass = arg.slice('--proxy-bypass='.length).trim();
    } else if (arg.startsWith('--user-agent=')) {
      contextOptions.userAgent = arg.slice('--user-agent='.length);
    } else if (arg.startsWith('--viewport-size=')) {
      const viewport = parseViewport(arg.slice('--viewport-size='.length));
      if (!viewport) throw new Error('BROWSER_CONFIG_UNSUPPORTED: invalid --viewport-size');
      contextOptions.viewport = viewport;
    } else if (arg.startsWith('--grant-permissions=')) {
      contextOptions.permissions = arg
        .slice('--grant-permissions='.length)
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--allowed-origins=')) {
      connectionConfig.network = {
        ...connectionConfig.network,
        allowedOrigins: arg.slice('--allowed-origins='.length).split(';').filter(Boolean),
      };
    } else if (arg.startsWith('--blocked-origins=')) {
      connectionConfig.network = {
        ...connectionConfig.network,
        blockedOrigins: arg.slice('--blocked-origins='.length).split(';').filter(Boolean),
      };
    } else if (arg.startsWith('--codegen=')) {
      const value = arg.slice('--codegen='.length);
      if (value !== 'typescript' && value !== 'none') {
        throw new Error('BROWSER_CONFIG_UNSUPPORTED: invalid --codegen');
      }
      connectionConfig.codegen = value;
    } else if (arg.startsWith('--console-level=')) {
      const value = arg.slice('--console-level='.length);
      if (!['error', 'warning', 'info', 'debug'].includes(value)) {
        throw new Error('BROWSER_CONFIG_UNSUPPORTED: invalid --console-level');
      }
      connectionConfig.console = {
        level: value as NonNullable<PlaywrightConnectionConfig['console']>['level'],
      };
    } else if (arg.startsWith('--image-responses=')) {
      const value = arg.slice('--image-responses='.length);
      if (value !== 'allow' && value !== 'omit') {
        throw new Error('BROWSER_CONFIG_UNSUPPORTED: invalid --image-responses');
      }
      connectionConfig.imageResponses = value;
    } else if (arg.startsWith('--snapshot-mode=')) {
      const value = arg.slice('--snapshot-mode='.length);
      if (value !== 'incremental' && value !== 'full' && value !== 'none') {
        throw new Error('BROWSER_CONFIG_UNSUPPORTED: invalid --snapshot-mode');
      }
      connectionConfig.snapshot = { mode: value };
    } else if (arg.startsWith('--test-id-attribute=')) {
      connectionConfig.testIdAttribute = arg.slice('--test-id-attribute='.length);
    } else if (arg.startsWith('--timeout-action=')) {
      connectionConfig.timeouts = {
        ...connectionConfig.timeouts,
        action: parseInteger(arg.slice('--timeout-action='.length), '--timeout-action'),
      };
    } else if (arg.startsWith('--timeout-navigation=')) {
      connectionConfig.timeouts = {
        ...connectionConfig.timeouts,
        navigation: parseInteger(arg.slice('--timeout-navigation='.length), '--timeout-navigation'),
      };
    }
  }

  if (proxyServer) launchOptions.proxy = { server: proxyServer, ...(proxyBypass ? { bypass: proxyBypass } : {}) };
  else if (proxyBypass) throw new Error('BROWSER_CONFIG_UNSUPPORTED: --proxy-bypass requires --proxy-server');

  connectionConfig.browser = {
    browserName,
    isolated: settings.mode === 'isolated',
    launchOptions,
    contextOptions,
  };
  return { browserName, launchOptions, contextOptions, connectionConfig };
}
