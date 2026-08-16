import type {
  AppConfig,
  McpServerDefinition,
  McpServerType,
} from "./config-types";
import { PRESET_MCP_SERVERS } from "./config-types";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 4 * 1024;
const MAX_COLLECTION_ITEMS = 128;

export const RESERVED_SPACE_MCP_SERVER_IDS = new Set(
  PRESET_MCP_SERVERS.map((server) => server.id),
);

export type PortableMcpManifestV1 = {
  schemaVersion: 1;
  serverId: string;
  transport: "stdio" | "http" | "sse";
  stdio?: {
    command: string;
    args: string[];
    envTemplates: Record<string, string>;
  };
  remote?: {
    urlTemplate: string;
    headerTemplates: Record<string, string>;
  };
  requiredConfigKeys: string[];
};

export type SpaceMcpPublishStatus = "safe" | "warning" | "blocked";

export type SpaceMcpPolicyCode =
  | "preset_reserved"
  | "name_required"
  | "name_too_long"
  | "description_too_long"
  | "schema_invalid"
  | "absolute_path"
  | "shell_trampoline"
  | "secret_candidate"
  | "invalid_url"
  | "invalid_template"
  | "manifest_too_large"
  | "runtime_dependency"
  | "localhost_dependency"
  | "platform_dependency";

export type SpaceMcpPolicyResult = {
  status: SpaceMcpPublishStatus;
  codes: SpaceMcpPolicyCode[];
  manifest?: PortableMcpManifestV1;
};

export type SpaceMcpInstallOutcome =
  | "identical"
  | "installed"
  | "replaced"
  | "conflict";

export type SpaceMcpInstallResult = {
  config: AppConfig;
  outcome: SpaceMcpInstallOutcome;
};

export class SpaceMcpPolicyError extends Error {
  readonly code: SpaceMcpPolicyCode;

  constructor(code: SpaceMcpPolicyCode, message: string) {
    super(message);
    this.name = "SpaceMcpPolicyError";
    this.code = code;
  }
}

function reject(code: SpaceMcpPolicyCode, message: string): never {
  throw new SpaceMcpPolicyError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    reject("schema_invalid", `${label} contains unsupported fields`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string")
    reject("schema_invalid", `${label} must be a string`);
  if (value.length > MAX_STRING_LENGTH)
    reject("schema_invalid", `${label} is too long`);
  if (!allowEmpty && value.length === 0)
    reject("schema_invalid", `${label} is required`);
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 0 || code === 127 || (code < 32 && ![9, 10, 13].includes(code))
      );
    })
  ) {
    reject(
      "schema_invalid",
      `${label} contains unsupported control characters`,
    );
  }
  return value;
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) {
    reject("schema_invalid", `${label} must be a bounded string array`);
  }
  return value.map((item, index) =>
    boundedString(item, `${label}[${index}]`, true),
  );
}

function boundedStringMap(
  value: unknown,
  label: string,
  keyPattern: RegExp,
): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > MAX_COLLECTION_ITEMS) {
    reject("schema_invalid", `${label} must be a bounded string map`);
  }
  const result: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    if (!keyPattern.test(key))
      reject("schema_invalid", `${label} contains an invalid key`);
    result[key] = boundedString(value[key], `${label}.${key}`, true);
  }
  return result;
}

function placeholderKeys(value: string, label: string): string[] {
  const keys = [...value.matchAll(/\{\{([A-Z][A-Z0-9_]{0,127})\}\}/g)].map(
    (match) => match[1]!,
  );
  const remainder = value.replace(/\{\{[A-Z][A-Z0-9_]{0,127}\}\}/g, "");
  if (remainder.includes("{{") || remainder.includes("}}")) {
    reject("invalid_template", `${label} contains an invalid placeholder`);
  }
  return keys;
}

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\/.test(value) ||
    /^~[\\/]/.test(value) ||
    /^file:\/\//i.test(value)
  );
}

function containsAbsolutePath(value: string): boolean {
  return (
    isAbsolutePath(value) ||
    /(?:^|[=\s])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\|~[\\/]|file:\/\/)/i.test(value)
  );
}

function containsSecretCandidate(value: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return true;
  if (
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s{][^\s]*/i.test(
      value,
    )
  )
    return true;
  if (/\bBearer\s+(?!\{\{)[A-Za-z0-9._~+/=-]{8,}/i.test(value)) return true;
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(value)) return true;
  return /^[A-Za-z0-9+/]{512,}={0,2}$/.test(value);
}

function isSensitiveName(value: string): boolean {
  return /(?:auth(?:orization)?|api[-_]?key|token|password|passwd|secret|cookie|session)/i.test(
    value,
  );
}

function isPlaceholderOnlyCredentialTemplate(value: string): boolean {
  return /^(?:(?:Bearer|Basic)\s+)?\{\{[A-Z][A-Z0-9_]{0,127}\}\}$/.test(
    value.trim(),
  );
}

function isInlineScriptExecution(command: string, args: string[]): boolean {
  const normalized = command.toLowerCase().replace(/\.exe$/, "");
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  if (["sh", "bash", "zsh", "fish"].includes(normalized)) {
    return lowerArgs.some((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
  }
  if (normalized === "cmd") return lowerArgs.includes("/c");
  if (["powershell", "pwsh"].includes(normalized)) {
    return lowerArgs.some((arg) =>
      ["-command", "--command", "-c", "/c"].includes(arg),
    );
  }
  const inlineFlags: Record<string, readonly string[]> = {
    node: ["-e", "--eval", "-p", "--print"],
    python: ["-c"],
    python3: ["-c"],
    ruby: ["-e"],
    perl: ["-e"],
    php: ["-r"],
    deno: ["eval"],
    bun: ["-e", "--eval"],
    npm: ["-c", "--call"],
    npx: ["-c", "--call"],
  };
  return lowerArgs.some((arg) => inlineFlags[normalized]?.includes(arg));
}

function validateStdio(value: unknown): PortableMcpManifestV1["stdio"] {
  if (!isRecord(value)) reject("schema_invalid", "stdio is required");
  exactKeys(value, ["command", "args", "envTemplates"], "stdio");
  const command = boundedString(value.command, "stdio.command").trim();
  const args = boundedStringArray(value.args, "stdio.args");
  const envTemplates = boundedStringMap(
    value.envTemplates,
    "stdio.envTemplates",
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/,
  );
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/.test(command) ||
    isAbsolutePath(command)
  ) {
    reject("absolute_path", "stdio.command must be a portable executable name");
  }
  if (isInlineScriptExecution(command, args)) {
    reject("shell_trampoline", "Shell command trampolines cannot be published");
  }
  for (const [index, arg] of args.entries()) {
    if (containsAbsolutePath(arg))
      reject("absolute_path", "stdio.args contains a local path");
    if (containsSecretCandidate(arg))
      reject("secret_candidate", "stdio.args contains a credential");
    const placeholders = placeholderKeys(arg, `stdio.args[${index}]`);
    const previous = args[index - 1] ?? "";
    if (sensitiveArgumentName(previous) && placeholders.length === 0) {
      reject(
        "secret_candidate",
        "stdio.args contains an inline credential value",
      );
    }
    const inlineAssignment = arg.match(/^(?:--?|\/)([^=]+)=(.*)$/);
    if (
      inlineAssignment &&
      isSensitiveName(inlineAssignment[1] ?? "") &&
      placeholderKeys(
        inlineAssignment[2] ?? "",
        `stdio.args[${index}] value`,
      ).length === 0
    ) {
      reject(
        "secret_candidate",
        "stdio.args contains an inline credential value",
      );
    }
    if (/^https?:\/\//i.test(arg)) {
      let parsed: URL;
      try {
        parsed = new URL(
          arg.replace(/\{\{[A-Z][A-Z0-9_]{0,127}\}\}/g, "placeholder"),
        );
      } catch {
        reject("invalid_url", "stdio.args contains an invalid URL");
      }
      if (parsed.username || parsed.password || parsed.search) {
        reject(
          "secret_candidate",
          "stdio.args URL contains non-portable credentials",
        );
      }
    }
  }
  for (const [key, template] of Object.entries(envTemplates)) {
    if (containsAbsolutePath(template))
      reject("absolute_path", `env ${key} contains a local path`);
    if (containsSecretCandidate(template))
      reject("secret_candidate", `env ${key} contains a credential`);
    const placeholders = placeholderKeys(template, `stdio.envTemplates.${key}`);
    if (isSensitiveName(key) && placeholders.length === 0) {
      reject("secret_candidate", `env ${key} must use a placeholder`);
    }
  }
  return { command, args, envTemplates };
}

function validateRemote(value: unknown): PortableMcpManifestV1["remote"] {
  if (!isRecord(value)) reject("schema_invalid", "remote is required");
  exactKeys(value, ["urlTemplate", "headerTemplates"], "remote");
  const urlTemplate = boundedString(
    value.urlTemplate,
    "remote.urlTemplate",
  ).trim();
  const headerTemplates = boundedStringMap(
    value.headerTemplates,
    "remote.headerTemplates",
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/,
  );
  placeholderKeys(urlTemplate, "remote.urlTemplate");
  let parsed: URL;
  try {
    parsed = new URL(
      urlTemplate.replace(/\{\{[A-Z][A-Z0-9_]{0,127}\}\}/g, "placeholder"),
    );
  } catch {
    reject("invalid_url", "remote.urlTemplate must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    reject("invalid_url", "remote URL must use HTTP");
  if (parsed.username || parsed.password || parsed.search) {
    reject(
      "secret_candidate",
      "remote URL cannot contain userinfo or query values",
    );
  }
  if (containsSecretCandidate(urlTemplate))
    reject("secret_candidate", "remote URL contains a credential");
  for (const [name, template] of Object.entries(headerTemplates)) {
    placeholderKeys(template, `remote.headerTemplates.${name}`);
    if (
      (isSensitiveName(name) &&
        !isPlaceholderOnlyCredentialTemplate(template)) ||
      containsSecretCandidate(template)
    ) {
      reject("secret_candidate", `header ${name} contains a credential`);
    }
  }
  return { urlTemplate, headerTemplates };
}

export function validatePortableMcpManifest(
  value: unknown,
): PortableMcpManifestV1 {
  if (!isRecord(value))
    reject("schema_invalid", "portable MCP manifest must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "serverId",
      "transport",
      "stdio",
      "remote",
      "requiredConfigKeys",
    ],
    "manifest",
  );
  if (value.schemaVersion !== 1)
    reject("schema_invalid", "unsupported manifest schema");
  const serverId = boundedString(value.serverId, "serverId").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serverId))
    reject("schema_invalid", "invalid serverId");
  if (RESERVED_SPACE_MCP_SERVER_IDS.has(serverId))
    reject("preset_reserved", "preset MCP cannot be published");
  if (
    value.transport !== "stdio" &&
    value.transport !== "http" &&
    value.transport !== "sse"
  ) {
    reject("schema_invalid", "invalid transport");
  }
  const transport = value.transport;
  const stdio = transport === "stdio" ? validateStdio(value.stdio) : undefined;
  const remote =
    transport === "stdio" ? undefined : validateRemote(value.remote);
  if (
    (transport === "stdio" && value.remote !== undefined) ||
    (transport !== "stdio" && value.stdio !== undefined)
  ) {
    reject("schema_invalid", "transport fields are mutually exclusive");
  }
  const requiredConfigKeys = boundedStringArray(
    value.requiredConfigKeys,
    "requiredConfigKeys",
  );
  if (requiredConfigKeys.some((key) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key))) {
    reject("invalid_template", "requiredConfigKeys contains an invalid key");
  }
  const normalizedRequired = [...new Set(requiredConfigKeys)].sort();
  if (normalizedRequired.length !== requiredConfigKeys.length)
    reject("invalid_template", "duplicate config key");
  const discovered = new Set<string>();
  const collect = (template: string, label: string) => {
    placeholderKeys(template, label).forEach((key) => discovered.add(key));
  };
  stdio?.args.forEach((arg, index) => collect(arg, `stdio.args[${index}]`));
  Object.entries(stdio?.envTemplates ?? {}).forEach(([key, template]) =>
    collect(template, `stdio.envTemplates.${key}`),
  );
  if (remote) {
    collect(remote.urlTemplate, "remote.urlTemplate");
    Object.entries(remote.headerTemplates).forEach(([key, template]) =>
      collect(template, `remote.headerTemplates.${key}`),
    );
  }
  if (
    JSON.stringify(normalizedRequired) !==
    JSON.stringify([...discovered].sort())
  ) {
    reject("invalid_template", "requiredConfigKeys must match placeholders");
  }
  const manifest: PortableMcpManifestV1 = {
    schemaVersion: 1,
    serverId,
    transport,
    ...(stdio ? { stdio } : {}),
    ...(remote ? { remote } : {}),
    requiredConfigKeys: normalizedRequired,
  };
  if (
    new TextEncoder().encode(JSON.stringify(manifest)).byteLength >
    MAX_MANIFEST_BYTES
  ) {
    reject("manifest_too_large", "portable MCP manifest exceeds 64 KiB");
  }
  return manifest;
}

function placeholderName(source: string): string {
  let normalized = source
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized || !/^[A-Z]/.test(normalized))
    normalized = `CONFIG_${normalized || "VALUE"}`;
  return normalized.slice(0, 128);
}

function templateFor(source: string): string {
  return `{{${placeholderName(source)}}}`;
}

function sanitizeFixedTemplate(
  value: string,
  source: string,
  forcePlaceholder: boolean,
): string {
  boundedString(value, source, true);
  if (containsAbsolutePath(value))
    reject("absolute_path", `${source} contains a local path`);
  const placeholders = placeholderKeys(value, source);
  if (placeholders.length > 0) return value;
  if (!value) return value;
  if (
    forcePlaceholder ||
    isSensitiveName(source) ||
    containsSecretCandidate(value)
  ) {
    return templateFor(source);
  }
  return value;
}

function sensitiveArgumentName(flag: string): string | null {
  const match = flag.match(/^(?:--?|\/)([^=]+)(?:=|$)/);
  if (!match || !isSensitiveName(match[1]!)) return null;
  return placeholderName(match[1]!);
}

function sanitizeArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    boundedString(arg, `args[${index}]`, true);
    if (containsAbsolutePath(arg))
      reject("absolute_path", "MCP args contains a local path");
    const inline = arg.match(/^((?:--?|\/)([^=]+)=)(.*)$/);
    if (inline && isSensitiveName(inline[2]!)) {
      return `${inline[1]}{{${placeholderName(inline[2]!)}}}`;
    }
    const previousSensitive =
      index > 0 ? sensitiveArgumentName(args[index - 1]!) : null;
    if (previousSensitive) return `{{${previousSensitive}}}`;
    placeholderKeys(arg, `args[${index}]`);
    if (containsSecretCandidate(arg))
      reject("secret_candidate", "MCP args contains an inline credential");
    if (/^https?:\/\//i.test(arg)) {
      let parsed: URL;
      try {
        parsed = new URL(
          arg.replace(/\{\{[A-Z][A-Z0-9_]{0,127}\}\}/g, "placeholder"),
        );
      } catch {
        reject("invalid_url", "MCP args contains an invalid URL");
      }
      if (parsed.username || parsed.password || parsed.search) {
        reject("secret_candidate", "MCP args URL contains non-portable values");
      }
    }
    return arg;
  });
}

function buildManifest(
  server: McpServerDefinition,
  config: Pick<AppConfig, "mcpServerArgs" | "mcpServerEnv">,
): PortableMcpManifestV1 {
  if (server.isBuiltin || RESERVED_SPACE_MCP_SERVER_IDS.has(server.id)) {
    reject("preset_reserved", "preset MCP cannot be published");
  }
  const name = server.name?.trim() ?? "";
  if (!name) reject("name_required", "MCP name is required");
  if (name.length > 100)
    reject("name_too_long", "MCP name must not exceed 100 characters");
  if ((server.description?.trim().length ?? 0) > 1000) {
    reject(
      "description_too_long",
      "MCP description must not exceed 1000 characters",
    );
  }
  const requiredConfigKeys = new Set<string>();
  const collect = (value: string, label: string) => {
    placeholderKeys(value, label).forEach((key) => requiredConfigKeys.add(key));
    return value;
  };
  if (server.type === "stdio") {
    const command = server.command?.trim() ?? "";
    const extraArgs = config.mcpServerArgs?.[server.id];
    const args = sanitizeArgs([
      ...(Array.isArray(server.args) ? server.args : []),
      ...(Array.isArray(extraArgs) ? extraArgs : []),
    ]);
    if (isInlineScriptExecution(command, args))
      reject("shell_trampoline", "shell trampoline is not portable");
    const envTemplates: Record<string, string> = {};
    const configuredEnv = config.mcpServerEnv?.[server.id] ?? {};
    for (const [key, value] of Object.entries({
      ...(server.env ?? {}),
      ...configuredEnv,
    }).sort(([a], [b]) => a.localeCompare(b))) {
      const forcePlaceholder = Object.prototype.hasOwnProperty.call(
        configuredEnv,
        key,
      );
      envTemplates[key] = collect(
        sanitizeFixedTemplate(String(value ?? ""), key, forcePlaceholder),
        `env.${key}`,
      );
    }
    args.forEach((arg, index) => collect(arg, `args[${index}]`));
    return validatePortableMcpManifest({
      schemaVersion: 1,
      serverId: server.id,
      transport: "stdio",
      stdio: { command, args, envTemplates },
      requiredConfigKeys: [...requiredConfigKeys].sort(),
    });
  }

  const urlTemplate = collect(
    sanitizeFixedTemplate(server.url?.trim() ?? "", "REMOTE_URL", false),
    "remote.urlTemplate",
  );
  const headerTemplates: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers ?? {}).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    headerTemplates[name] = collect(
      sanitizeFixedTemplate(String(value ?? ""), name, true),
      `headers.${name}`,
    );
  }
  return validatePortableMcpManifest({
    schemaVersion: 1,
    serverId: server.id,
    transport: server.type,
    remote: { urlTemplate, headerTemplates },
    requiredConfigKeys: [...requiredConfigKeys].sort(),
  });
}

export function analyzeSpaceMcpCandidate(
  server: McpServerDefinition,
  config: Pick<AppConfig, "mcpServerArgs" | "mcpServerEnv">,
): SpaceMcpPolicyResult {
  try {
    const manifest = buildManifest(server, config);
    const warnings = new Set<SpaceMcpPolicyCode>();
    if (server.type === "stdio") warnings.add("runtime_dependency");
    if (server.platforms?.length) warnings.add("platform_dependency");
    if (manifest.remote) {
      const parsed = new URL(
        manifest.remote.urlTemplate.replace(
          /\{\{[A-Z][A-Z0-9_]{0,127}\}\}/g,
          "placeholder",
        ),
      );
      if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))
        warnings.add("localhost_dependency");
    }
    return {
      status: warnings.size ? "warning" : "safe",
      codes: [...warnings],
      manifest,
    };
  } catch (error) {
    return {
      status: "blocked",
      codes: [
        error instanceof SpaceMcpPolicyError ? error.code : "schema_invalid",
      ],
    };
  }
}

export function buildPortableMcpManifest(
  server: McpServerDefinition,
  config: Pick<AppConfig, "mcpServerArgs" | "mcpServerEnv">,
): PortableMcpManifestV1 {
  return buildManifest(server, config);
}

export function canonicalPortableMcpManifest(manifest: unknown): string {
  return JSON.stringify(validatePortableMcpManifest(manifest));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function priorMatchesTemplate(template: string, prior: string): boolean {
  const pattern = escapeRegExp(template).replace(
    /\\\{\\\{[A-Z][A-Z0-9_]{0,127}\\\}\\\}/g,
    "(.+?)",
  );
  return new RegExp(`^${pattern}$`).test(prior);
}

function hydrateTemplate(
  template: string,
  prior: string | undefined,
  configEnv: Record<string, string>,
): string {
  if (prior && priorMatchesTemplate(template, prior)) return prior;
  const keys = placeholderKeys(template, "install template");
  if (keys.length === 0) return template;
  if (
    keys.every(
      (key) => typeof configEnv[key] === "string" && configEnv[key] !== "",
    )
  ) {
    return template.replace(
      /\{\{([A-Z][A-Z0-9_]{0,127})\}\}/g,
      (_match, key: string) => configEnv[key]!,
    );
  }
  return template;
}

function hydrateArgumentTemplate(
  template: string,
  index: number,
  templates: string[],
  priorArgs: string[],
  configEnv: Record<string, string>,
): string {
  const prior = priorArgs[index];
  const barePlaceholder = template.match(
    /^\{\{([A-Z][A-Z0-9_]{0,127})\}\}$/,
  );
  if (!barePlaceholder) {
    return hydrateTemplate(template, prior, configEnv);
  }

  const key = barePlaceholder[1]!;
  const precedingTemplate = index > 0 ? templates[index - 1] : undefined;
  const precedingPrior = index > 0 ? priorArgs[index - 1] : undefined;
  const sameNamedArgument =
    precedingTemplate !== undefined &&
    precedingTemplate === precedingPrior &&
    sensitiveArgumentName(precedingTemplate) === key;
  return hydrateTemplate(
    template,
    sameNamedArgument ? prior : undefined,
    configEnv,
  );
}

function withoutRecordKey<T>(
  record: Record<string, T> | undefined,
  key: string,
): Record<string, T> | undefined {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key))
    return record;
  const next = { ...record };
  delete next[key];
  return Object.keys(next).length ? next : undefined;
}

function definitionFromManifest(
  manifest: PortableMcpManifestV1,
  metadata: { name: string; description?: string | null },
  existing: McpServerDefinition | undefined,
  existingExtraArgs: string[],
  existingConfigEnv: Record<string, string>,
): McpServerDefinition {
  const base: McpServerDefinition = {
    id: manifest.serverId,
    name: metadata.name,
    description: metadata.description?.trim() || undefined,
    type: manifest.transport as McpServerType,
    isBuiltin: false,
    ...(manifest.requiredConfigKeys.length
      ? { requiresConfig: manifest.requiredConfigKeys }
      : {}),
  };
  if (manifest.stdio) {
    const priorArgs = [...(existing?.args ?? []), ...existingExtraArgs];
    const env: Record<string, string> = {};
    for (const [key, template] of Object.entries(manifest.stdio.envTemplates)) {
      env[key] = hydrateTemplate(
        template,
        existing?.env?.[key],
        existingConfigEnv,
      );
    }
    return {
      ...base,
      command: manifest.stdio.command,
      args: manifest.stdio.args.map((template, index, templates) =>
        hydrateArgumentTemplate(
          template,
          index,
          templates,
          priorArgs,
          existingConfigEnv,
        ),
      ),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(
    manifest.remote!.headerTemplates,
  )) {
    headers[name] = hydrateTemplate(
      template,
      existing?.headers?.[name],
      existingConfigEnv,
    );
  }
  return {
    ...base,
    url: hydrateTemplate(
      manifest.remote!.urlTemplate,
      existing?.url,
      existingConfigEnv,
    ),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

export function applyPortableMcpInstall(
  config: AppConfig,
  rawManifest: unknown,
  metadata: { name: string; description?: string | null },
  allowReplace: boolean,
): SpaceMcpInstallResult {
  const manifest = validatePortableMcpManifest(rawManifest);
  const servers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
  const existingIndex = servers.findIndex(
    (server) => server.id === manifest.serverId,
  );
  const existing = existingIndex >= 0 ? servers[existingIndex] : undefined;
  if (existing) {
    const local = analyzeSpaceMcpCandidate(existing, config);
    if (
      local.manifest &&
      canonicalPortableMcpManifest(local.manifest) ===
        canonicalPortableMcpManifest(manifest)
    ) {
      return { config, outcome: "identical" };
    }
    if (!allowReplace) return { config, outcome: "conflict" };
  }

  const existingConfigEnv = config.mcpServerEnv?.[manifest.serverId] ?? {};
  const definition = definitionFromManifest(
    manifest,
    metadata,
    existing,
    config.mcpServerArgs?.[manifest.serverId] ?? [],
    existingConfigEnv,
  );
  const nextServers = [...servers];
  if (existingIndex >= 0) nextServers[existingIndex] = definition;
  else nextServers.push(definition);

  const retainedConfigEnv = Object.fromEntries(
    manifest.requiredConfigKeys
      .filter((key) =>
        Object.prototype.hasOwnProperty.call(existingConfigEnv, key),
      )
      .map((key) => [key, existingConfigEnv[key]!]),
  );
  const nextEnvByServer = { ...(config.mcpServerEnv ?? {}) };
  if (Object.keys(retainedConfigEnv).length)
    nextEnvByServer[manifest.serverId] = retainedConfigEnv;
  else delete nextEnvByServer[manifest.serverId];

  return {
    config: {
      ...config,
      mcpServers: nextServers,
      mcpEnabledServers: (Array.isArray(config.mcpEnabledServers)
        ? config.mcpEnabledServers
        : []
      ).filter((id) => id !== manifest.serverId),
      mcpServerEnv: Object.keys(nextEnvByServer).length
        ? nextEnvByServer
        : undefined,
      mcpServerArgs: withoutRecordKey(config.mcpServerArgs, manifest.serverId),
    },
    outcome: existing ? "replaced" : "installed",
  };
}
