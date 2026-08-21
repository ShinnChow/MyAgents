import {
  PLAYWRIGHT_BROWSER_SETTINGS_SCHEMA_VERSION,
  type PlaywrightBrowserMode,
  type PlaywrightBrowserSettings,
} from './config-types';

export const DEFAULT_PLAYWRIGHT_BROWSER_SETTINGS: PlaywrightBrowserSettings = {
  schemaVersion: PLAYWRIGHT_BROWSER_SETTINGS_SCHEMA_VERSION,
  mode: 'isolated',
  headless: false,
  capabilities: ['storage'],
  extraArgs: [],
};

function createDefaultPlaywrightBrowserSettings(): PlaywrightBrowserSettings {
  return {
    ...DEFAULT_PLAYWRIGHT_BROWSER_SETTINGS,
    capabilities: [...DEFAULT_PLAYWRIGHT_BROWSER_SETTINGS.capabilities],
    extraArgs: [],
  };
}

const OWNED_FLAG_PREFIXES = [
  '--browser=',
  '--device=',
  '--user-data-dir=',
  '--storage-state=',
  '--caps=',
] as const;

const SUPPORTED_ADVANCED_FLAGS = new Set([
  '--block-service-workers',
  '--ignore-https-errors',
  '--no-sandbox',
  '--sandbox',
  '--save-session',
  '--save-trace',
]);

const SUPPORTED_ADVANCED_PREFIXES = [
  '--proxy-server=',
  '--proxy-bypass=',
  '--user-agent=',
  '--viewport-size=',
  '--grant-permissions=',
  '--allowed-origins=',
  '--blocked-origins=',
  '--codegen=',
  '--console-level=',
  '--image-responses=',
  '--snapshot-mode=',
  '--test-id-attribute=',
  '--timeout-action=',
  '--timeout-navigation=',
  '--save-video=',
] as const;

export const PLAYWRIGHT_ADDITIONAL_CAPABILITIES = [
  'storage',
  'vision',
  'pdf',
  'devtools',
] as const;

const PLAYWRIGHT_ADDITIONAL_CAPABILITY_SET = new Set<string>(PLAYWRIGHT_ADDITIONAL_CAPABILITIES);

export function isSupportedPlaywrightCapability(value: string): boolean {
  return PLAYWRIGHT_ADDITIONAL_CAPABILITY_SET.has(value);
}

export function isSupportedPlaywrightAdvancedArg(arg: string): boolean {
  return SUPPORTED_ADVANCED_FLAGS.has(arg)
    || SUPPORTED_ADVANCED_PREFIXES.some(prefix => arg.startsWith(prefix));
}

export type PlaywrightBrowserConfigSource = 'typed' | 'legacy' | 'default';

export interface ResolvedPlaywrightBrowserConfig {
  settings: PlaywrightBrowserSettings;
  source: PlaywrightBrowserConfigSource;
  /** A migration error leaves the legacy argv in place for explicit recovery. */
  migrationError?: string;
}

function hashRevisionInput(value: string): string {
  let fnv = 0x811c9dc5;
  let djb = 0x1505;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    fnv ^= code;
    fnv = Math.imul(fnv, 0x01000193);
    djb = Math.imul(djb, 33) ^ code;
  }
  return `${(fnv >>> 0).toString(16).padStart(8, '0')}${(djb >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Non-secret desired-state revision used to invalidate a live Runtime when
 * Browser Host settings change. The raw settings may contain proxy credentials
 * and therefore must never be copied into MCP definitions, logs, or snapshots.
 */
export function playwrightBrowserSettingsRevision(config: PlaywrightConfigRecord): string {
  const resolved = resolvePlaywrightBrowserConfig(config);
  const revisionInput = resolved.migrationError
    ? { state: 'migration-error', error: resolved.migrationError }
    : { state: 'ready', settings: resolved.settings };
  return `playwright-browser-v1-${hashRevisionInput(JSON.stringify(revisionInput))}`;
}

interface PlaywrightConfigRecord {
  playwrightBrowser?: unknown;
  mcpServerArgs?: Record<string, string[]>;
}

function uniqueNonEmptyStrings(values: unknown, required: string[] = []): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const input = Array.isArray(values) ? values : [];
  for (const value of [...required, ...input]) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeMode(value: unknown): PlaywrightBrowserMode | undefined {
  return value === 'isolated' || value === 'persistent' ? value : undefined;
}

export function normalizePlaywrightBrowserSettings(value: unknown): PlaywrightBrowserSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== PLAYWRIGHT_BROWSER_SETTINGS_SCHEMA_VERSION) return null;
  const mode = normalizeMode(raw.mode);
  if (!mode) return null;

  const settings: PlaywrightBrowserSettings = {
    schemaVersion: PLAYWRIGHT_BROWSER_SETTINGS_SCHEMA_VERSION,
    mode,
    headless: raw.headless === true,
    capabilities: uniqueNonEmptyStrings(
      raw.capabilities,
      mode === 'isolated' ? ['storage'] : [],
    ),
    extraArgs: uniqueNonEmptyStrings(raw.extraArgs),
  };
  if (settings.capabilities.some(capability => !isSupportedPlaywrightCapability(capability))) {
    return null;
  }
  if (settings.extraArgs.some(arg => (
    !isSupportedPlaywrightAdvancedArg(arg)
    || arg === '--isolated'
    || arg === '--headless'
    || OWNED_FLAG_PREFIXES.some(prefix => arg.startsWith(prefix))
  ))) {
    return null;
  }

  const browser = optionalTrimmedString(raw.browser);
  const device = optionalTrimmedString(raw.device);
  const userDataDir = optionalTrimmedString(raw.userDataDir);
  if (browser && !['chromium', 'chrome', 'msedge', 'firefox', 'webkit'].includes(browser)) {
    return null;
  }
  if (mode === 'isolated' && userDataDir) return null;
  if (browser) settings.browser = browser;
  if (device) settings.device = device;
  if (mode === 'persistent' && userDataDir) settings.userDataDir = userDataDir;
  return settings;
}

function readLegacyFlagValue(arg: string, prefix: string): string | undefined {
  if (!arg.startsWith(prefix)) return undefined;
  const value = arg.slice(prefix.length).trim();
  return value || undefined;
}

export function migrateLegacyPlaywrightArgs(args: readonly string[]): ResolvedPlaywrightBrowserConfig {
  let mode: PlaywrightBrowserMode = 'isolated';
  let hasIsolatedFlag = false;
  let headless = false;
  let browser: string | undefined;
  let device: string | undefined;
  let userDataDir: string | undefined;
  let hasStorageState = false;
  const capabilities: string[] = [];
  const extraArgs: string[] = [];
  const conflicts: string[] = [];
  const valueFlags = new Set([
    ...OWNED_FLAG_PREFIXES.map(prefix => prefix.slice(0, -1)),
    ...SUPPORTED_ADVANCED_PREFIXES.map(prefix => prefix.slice(0, -1)),
  ]);
  const normalizedArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!valueFlags.has(arg)) {
      normalizedArgs.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      conflicts.push(`legacy config is missing a value for argument: ${arg}`);
      continue;
    }
    normalizedArgs.push(`${arg}=${value}`);
    index += 1;
  }

  for (const arg of normalizedArgs) {
    if (arg === '--isolated') {
      hasIsolatedFlag = true;
      mode = 'isolated';
      continue;
    }
    if (arg === '--headless') {
      headless = true;
      continue;
    }
    if (arg === '--vision') {
      capabilities.push('vision');
      continue;
    }
    const browserValue = readLegacyFlagValue(arg, '--browser=');
    if (browserValue) {
      browser = browserValue;
      continue;
    }
    const deviceValue = readLegacyFlagValue(arg, '--device=');
    if (deviceValue) {
      device = deviceValue;
      continue;
    }
    const profileValue = readLegacyFlagValue(arg, '--user-data-dir=');
    if (profileValue) {
      userDataDir = profileValue;
      mode = 'persistent';
      continue;
    }
    if (arg.startsWith('--storage-state=')) {
      hasStorageState = true;
      continue;
    }
    const capsValue = readLegacyFlagValue(arg, '--caps=');
    if (capsValue) {
      const parsed = capsValue.split(',').map(value => value.trim()).filter(Boolean);
      const unsupported = parsed.filter(value => !isSupportedPlaywrightCapability(value));
      if (unsupported.length > 0) {
        conflicts.push(`legacy config contains unsupported capability: ${unsupported.join(',')}`);
      }
      capabilities.push(...parsed.filter(isSupportedPlaywrightCapability));
      continue;
    }
    if (isSupportedPlaywrightAdvancedArg(arg)) {
      extraArgs.push(arg);
    } else {
      conflicts.push(`legacy config contains unsupported argument: ${arg}`);
    }
  }

  if (hasIsolatedFlag && userDataDir) {
    conflicts.push('legacy config combines --isolated with --user-data-dir');
  }
  if (hasStorageState) {
    conflicts.push('legacy config overrides the product-owned --storage-state');
  }

  const settings = normalizePlaywrightBrowserSettings({
    schemaVersion: PLAYWRIGHT_BROWSER_SETTINGS_SCHEMA_VERSION,
    mode,
    headless,
    browser,
    device,
    userDataDir,
    capabilities,
    extraArgs,
  }) ?? createDefaultPlaywrightBrowserSettings();

  return {
    settings,
    source: 'legacy',
    ...(conflicts.length > 0 ? { migrationError: conflicts.join('; ') } : {}),
  };
}

/**
 * Resolve desired state without mutating the caller. Explicit typed config
 * wins; otherwise a present legacy argv entry is migrated. A completely
 * absent mode is a new/default install and therefore uses isolated mode.
 */
export function resolvePlaywrightBrowserConfig(config: PlaywrightConfigRecord): ResolvedPlaywrightBrowserConfig {
  if (config.playwrightBrowser !== undefined) {
    const normalized = normalizePlaywrightBrowserSettings(config.playwrightBrowser);
    if (normalized) return { settings: normalized, source: 'typed' };
    return {
      settings: createDefaultPlaywrightBrowserSettings(),
      source: 'typed',
      migrationError: 'playwrightBrowser has an unsupported or malformed schema',
    };
  }

  const legacyArgs = config.mcpServerArgs?.playwright;
  if (legacyArgs !== undefined) return migrateLegacyPlaywrightArgs(legacyArgs);
  return { settings: createDefaultPlaywrightBrowserSettings(), source: 'default' };
}

/**
 * Idempotent load-boundary migration. Legacy argv is deleted only after a
 * lossless conversion; malformed/conflicting input stays visible and cannot
 * be silently replaced by defaults.
 */
export function normalizePlaywrightBrowserConfig<T extends PlaywrightConfigRecord>(config: T): T {
  const resolved = resolvePlaywrightBrowserConfig(config);
  // A failed migration must remain failed and visible. Publishing a typed
  // default beside the legacy argv would make the next resolution prefer the
  // typed value and silently erase the conflict signal.
  if (resolved.migrationError) return config;
  config.playwrightBrowser = resolved.settings;
  if (resolved.source !== 'legacy') return config;

  const nextArgs = { ...(config.mcpServerArgs ?? {}) };
  delete nextArgs.playwright;
  config.mcpServerArgs = Object.keys(nextArgs).length > 0 ? nextArgs : undefined;
  return config;
}

/** Compile the subset of upstream flags that does not own lifecycle state. */
export function compilePlaywrightHostArgs(settings: PlaywrightBrowserSettings): string[] {
  const normalized = normalizePlaywrightBrowserSettings(settings);
  if (!normalized) throw new Error('Invalid Playwright browser settings');

  const args: string[] = [];
  if (normalized.headless) args.push('--headless');
  if (normalized.browser) args.push(`--browser=${normalized.browser}`);
  if (normalized.device) args.push(`--device=${normalized.device}`);
  if (normalized.capabilities.length > 0) {
    args.push(`--caps=${normalized.capabilities.join(',')}`);
  }
  args.push(...normalized.extraArgs.filter(arg => (
    arg !== '--isolated'
    && arg !== '--headless'
    && !OWNED_FLAG_PREFIXES.some(prefix => arg.startsWith(prefix))
  )));
  return args;
}
