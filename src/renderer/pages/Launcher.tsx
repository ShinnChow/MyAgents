/**
 * Launcher - Main entry page for MyAgents
 * Lightweight new-work page. Global navigation and workspace/session history
 * live in the App Shell sidebar; this page owns only launch composition.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { perfMark } from '@/utils/perfMark';
import { RENDERER_PERF_PHASE } from '../../shared/perfTrace';
import { open } from '@tauri-apps/plugin-dialog';

import { track } from '@/analytics';
import type { EntryIntent, Surface } from '@/analytics';
import { type ImageAttachment } from '@/components/SimpleChatInput';
import { projectTaskExecutionOverrides } from '@/utils/taskProviderProjection';
import { coerceRuntimeBirthPermissionMode } from '../../shared/runtimeBirthFields';
import { useToast } from '@/components/Toast';
import PathInputDialog from '@/components/PathInputDialog';
import { BrandSection } from '@/components/launcher';
import RecordingSourceDialog from '@/components/task-center/RecordingSourceDialog';
import { useConfig } from '@/hooks/useConfig';
import { useBrowserResourceReady } from '@/hooks/useBrowserResourceReady';
import {
  type Project,
  type PermissionMode,
  type McpServerDefinition,
  isProjectActiveForUser,
  isProjectVisibleToUser,
} from '@/config/types';
import { CUSTOM_EVENTS } from '../../shared/constants';
import {
  applyBuiltinBrowserExecutionToolToggle,
  MANAGED_BROWSER_MCP_ID,
} from '../../shared/browserTools';
import { workspacePathsEqual } from '../../shared/workspacePath';
import {
  getAllMcpServers,
  getEnabledMcpServerIds,
  isImageUnderstandingSelectionAvailable,
  resolveProvider,
  pairBuiltinSelection,
} from '@/config/configService';
import {
  patchAgentConfig,
  patchAgentProjectConfig,
  getAgentById,
} from '@/config/services/agentConfigService';
import { persistInputOptionChange } from '@/api/persistInputOption';
import { createCronTask, startCronTask } from '@/api/cronTaskClient';
import type {
  RuntimeType,
  RuntimeModelInfo,
  RuntimePermissionMode,
  RuntimeDetections,
} from '../../shared/types/runtime';
import {
  CC_MODELS,
  CC_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  GEMINI_PERMISSION_MODES,
  buildRuntimeChangePatch,
} from '../../shared/types/runtime';
import {
  agentUsesManagedCodexProvider,
  isRuntimeBackedProvider,
  toProviderExecutionIntent,
} from '../../shared/providerExecution';
import {
  IMAGE_UNDERSTANDING_TOOL_ID,
  OFFICIAL_TOOLS,
  normalizeOfficialToolIds,
  type OfficialToolId,
} from '../../shared/official-tools';
import { apiGetJson } from '@/api/apiFetch';
import { runtimeModelCatalogPath } from '@/utils/runtimeModelCatalog';
import { isBrowserDevMode, pickFolderForDialog } from '@/utils/browserMock';
import { resolveLauncherProvider } from '@/utils/optionResolve';
import type { InitialMessage, LaunchSessionBirthHint } from '@/types/tab';
import { speechModelPackStatus } from '@/api/recording';
import type { RecordingSourceSelection } from '../../shared/types/record';

interface LauncherProps {
  onLaunchProject: (
    project: Project,
    initialMessage?: InitialMessage,
    analyticsContext?: { surface?: Surface; entryIntent?: EntryIntent },
    sessionBirthHint?: LaunchSessionBirthHint,
  ) => Promise<boolean>;
  isStarting?: boolean;
  startError?: string | null;
  isActive: boolean;
  attachmentSessionId?: string | null;
  selectedWorkspacePath?: string | null;
  onWorkspaceSelectionChange?: (workspacePath: string | null) => void;
  onStartRecording: (selection: RecordingSourceSelection) => Promise<void>;
  onOpenRecord: (recordId: string) => void;
  recordingBusy?: boolean;
}

export default function Launcher({
  onLaunchProject,
  isStarting,
  startError: _startError,
  isActive,
  attachmentSessionId,
  selectedWorkspacePath,
  onWorkspaceSelectionChange,
  onStartRecording,
  onOpenRecord,
  recordingBusy = false,
}: LauncherProps) {
  const { t } = useTranslation('launcher');
  const { t: tSettings } = useTranslation('settings');
  const toast = useToast();
  const managedBrowserReady = useBrowserResourceReady();
  const toastRef = useRef(toast);
  const {
    config,
    projects,
    providers,
    isLoading,
    error: _error,
    addProject,
    patchProject,
    touchProject,
    apiKeys,
    providerVerifyStatus,
    refreshProviderData,
    updateConfig,
  } = useConfig();

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const visibleProjects = useMemo(
    () =>
      projects.filter(isProjectVisibleToUser).filter(isProjectActiveForUser),
    [projects],
  );

  const [_addError, setAddError] = useState<string | null>(null);
  const [launchingProjectId, setLaunchingProjectId] = useState<string | null>(
    null,
  );
  const [recordingRequestBusy, setRecordingRequestBusy] = useState(false);
  const [recordingSourceDialog, setRecordingSourceDialog] = useState<{
    mode: 'start' | 'settings';
    initialSelection: RecordingSourceSelection;
    modelPackUsable?: boolean;
    error?: string;
  } | null>(null);

  // ===== Launcher-specific state for BrandSection =====

  // Fallback chain: defaultWorkspacePath → mino project → first project → null
  const resolveDefaultWorkspace = useCallback(
    (projs: Project[]): Project | null => {
      if (config.defaultWorkspacePath) {
        const def = projs.find((p) =>
          workspacePathsEqual(p.path, config.defaultWorkspacePath),
        );
        if (def) return def;
      }
      // Fallback: find mino project by path suffix
      const mino = projs.find((p) =>
        p.path.replace(/\\/g, '/').endsWith('/mino'),
      );
      if (mino) return mino;
      return projs[0] ?? null;
    },
    [config.defaultWorkspacePath],
  );

  const selectedWorkspace = useMemo(() => {
    if (selectedWorkspacePath) {
      const selected = visibleProjects.find((project) =>
        workspacePathsEqual(project.path, selectedWorkspacePath),
      );
      if (selected) return selected;
    }
    return resolveDefaultWorkspace(visibleProjects);
  }, [resolveDefaultWorkspace, selectedWorkspacePath, visibleProjects]);

  useEffect(() => {
    const resolvedPath = selectedWorkspace?.path ?? null;
    const selectionMatches =
      resolvedPath === null
        ? selectedWorkspacePath == null
        : workspacePathsEqual(resolvedPath, selectedWorkspacePath);
    if (!selectionMatches) onWorkspaceSelectionChange?.(resolvedPath);
  }, [
    onWorkspaceSelectionChange,
    selectedWorkspace?.path,
    selectedWorkspacePath,
  ]);

  // P0/P4: mark when the Launcher shell first commits, for the new-tab timeline
  // (new_tab_reveal → tab_shell_painted → tab_data_ready).
  useEffect(() => {
    perfMark(RENDERER_PERF_PHASE.tabShellPainted, { surface: 'launcher' });
  }, []);

  // A6 (instant-nav): warm the lazy Chat chunk while the user is on the
  // Launcher — opening a chat IS the Launcher's purpose, so the Launcher→Chat
  // flip should never hit a cold lazy chunk (paper Suspense flash). Only Chat,
  // NOT the whole route graph — a blind preload of every route caused the
  // WKWebView "preloaded but not used" warning storm removed in c465b2a9.
  // Idle-scheduled so it never competes with first paint.
  useEffect(() => {
    if (!isActive) return;
    // Warm the Chat chunk IMMEDIATELY (useEffect is post-paint, so this never
    // blocks the Launcher's first paint). NOT requestIdleCallback: idle keeps
    // losing the race — the Launcher's initial data fetches (task-center 6-way,
    // config) keep the thread busy, and the user clicks a workspace card within
    // ~0.7s, before the ~800ms cold Chat-chunk finishes. Measured: 1st launch
    // flip→Chat-mount ~900ms cold vs ~25ms warm. Starting the fetch the instant
    // the Launcher mounts gives it the most head start. Logs bracket the load so
    // we can see whether it beats the click. Only Chat (not the route graph).
    let cancelled = false;
    console.log('[Launcher] Chat-chunk preload START');
    void import('@/pages/Chat')
      .then(() => {
        if (!cancelled) console.log('[Launcher] Chat-chunk preload DONE');
      })
      .catch(() => {
        /* non-fatal: the real lazy() retries on open */
      });
    return () => {
      cancelled = true;
    };
  }, [isActive]);

  const [launcherPermissionMode, setLauncherPermissionMode] =
    useState<PermissionMode>(config.defaultPermissionMode);
  const [launcherProviderId, setLauncherProviderId] = useState<
    string | undefined
  >();
  const [launcherSelectedModel, setLauncherSelectedModel] = useState<
    string | undefined
  >();
  // #324 — 推理强度 setting ('default' | level). Seeded from the agent in the
  // workspace-sync effect below; persisted via persistInputOptionChange.
  const [launcherReasoningEffort, setLauncherReasoningEffort] =
    useState<string>('default');

  // Runtime state — adapts model/permission selectors when workspace uses external runtime
  const multiAgentRuntimeEnabled = !!config.multiAgentRuntime;

  // PRD 0.2.7 D6 / Phase F: Launcher exposes Runtime selector in the row
  // below the input. We detect once on mount, mirroring Chat.tsx's pattern.
  const [runtimeDetections, setRuntimeDetections] = useState<RuntimeDetections>(
    {
      builtin: { installed: true },
      'claude-code': { installed: false },
      codex: { installed: false },
      gemini: { installed: false },
    },
  );
  useEffect(() => {
    if (!multiAgentRuntimeEnabled) return;
    let cancelled = false;
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<
        Record<string, { installed: boolean; version?: string; path?: string }>
      >('cmd_detect_runtimes')
        .then((d) => {
          if (!cancelled) setRuntimeDetections(d as RuntimeDetections);
        })
        .catch(() => {
          /* non-fatal */
        });
    });
    return () => {
      cancelled = true;
    };
  }, [multiAgentRuntimeEnabled]);

  // MCP state
  const [launcherMcpServers, setLauncherMcpServers] = useState<
    McpServerDefinition[]
  >([]);
  const [launcherGlobalMcpEnabled, setLauncherGlobalMcpEnabled] = useState<
    string[]
  >([]);
  const [launcherWorkspaceMcpEnabled, setLauncherWorkspaceMcpEnabled] =
    useState<string[]>([]);
  // PRD 0.2.17 — Launcher's per-session plugin selection. Default seeded
  // from launcherLastUsed once config loads (effect below); transient
  // selection is carried into the new Tab via InitialMessage.
  const [launcherEnabledPlugins, setLauncherEnabledPlugins] = useState<
    string[]
  >([]);
  const [launcherOfficialToolEnabled, setLauncherOfficialToolEnabled] =
    useState<OfficialToolId[]>([]);
  const launcherGlobalOfficialToolEnabled = useMemo(
    () => normalizeOfficialToolIds(config.enabledOfficialToolIds ?? []),
    [config.enabledOfficialToolIds],
  );

  // Resolve AgentConfig for selected workspace (source of truth for AI settings)
  const selectedAgent = useMemo(() => {
    if (!selectedWorkspace?.agentId) return undefined;
    return getAgentById(config, selectedWorkspace.agentId);
  }, [selectedWorkspace?.agentId, config]);

  // Ref for runtimeConfig — avoids stale closure in rapid write-back handlers
  const runtimeConfigRef = useRef(selectedAgent?.runtimeConfig);
  runtimeConfigRef.current = selectedAgent?.runtimeConfig;

  // Runtime-aware model/permission lists — adapts input bar for external runtimes
  const selectedAgentUsesManagedCodexProvider =
    agentUsesManagedCodexProvider(selectedAgent);
  const launcherRuntime: RuntimeType = selectedAgentUsesManagedCodexProvider
    ? 'builtin'
    : multiAgentRuntimeEnabled
      ? (selectedAgent?.runtime as RuntimeType) || 'builtin'
      : 'builtin';
  const isExternalRuntime = launcherRuntime !== 'builtin';

  // Codex + Gemini models are dynamic (fetched from the CLI); CC models are static
  const [codexModels, setCodexModels] = useState<RuntimeModelInfo[]>([]);
  const [geminiModels, setGeminiModels] = useState<RuntimeModelInfo[]>([]);
  useEffect(() => {
    if (!multiAgentRuntimeEnabled || launcherRuntime !== 'codex') {
      setCodexModels([]);
      return;
    }
    let cancelled = false;
    apiGetJson<{ models?: RuntimeModelInfo[] }>(
      runtimeModelCatalogPath('codex', 'system-cli'),
    )
      .then((res) => {
        if (!cancelled && res?.models?.length) setCodexModels(res.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [multiAgentRuntimeEnabled, launcherRuntime]);
  useEffect(() => {
    if (!multiAgentRuntimeEnabled || launcherRuntime !== 'gemini') {
      setGeminiModels([]);
      return;
    }
    let cancelled = false;
    apiGetJson<{ models?: RuntimeModelInfo[] }>(
      runtimeModelCatalogPath('gemini'),
    )
      .then((res) => {
        if (!cancelled && res?.models?.length) setGeminiModels(res.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [multiAgentRuntimeEnabled, launcherRuntime]);

  const launcherRuntimeModels: RuntimeModelInfo[] | undefined =
    launcherRuntime === 'claude-code'
      ? CC_MODELS
      : launcherRuntime === 'codex'
        ? codexModels
        : launcherRuntime === 'gemini'
          ? geminiModels
          : undefined;
  const launcherRuntimePermissionModes: RuntimePermissionMode[] | undefined =
    launcherRuntime === 'claude-code'
      ? CC_PERMISSION_MODES
      : launcherRuntime === 'codex'
        ? CODEX_PERMISSION_MODES
        : launcherRuntime === 'gemini'
          ? GEMINI_PERMISSION_MODES
          : undefined;

  // Derive provider for launcher — only select providers with valid credentials
  const launcherProvider = useMemo(() => {
    const id =
      launcherProviderId ??
      selectedAgent?.providerId ??
      selectedWorkspace?.providerId ??
      config.defaultProviderId;
    return resolveProvider(id, providers, apiKeys, providerVerifyStatus);
  }, [
    launcherProviderId,
    selectedAgent,
    selectedWorkspace,
    config.defaultProviderId,
    providers,
    apiKeys,
    providerVerifyStatus,
  ]);
  const imageUnderstandingConfiguredForInput = useMemo(() => {
    return isImageUnderstandingSelectionAvailable(
      providers,
      apiKeys,
      providerVerifyStatus,
      config.officialToolSettings,
    );
  }, [apiKeys, config.officialToolSettings, providerVerifyStatus, providers]);
  const launcherOfficialToolNeedsConfig = useMemo(
    () => ({
      [IMAGE_UNDERSTANDING_TOOL_ID]: !imageUnderstandingConfiguredForInput,
    }),
    [imageUnderstandingConfiguredForInput],
  );

  // Load MCP servers when workspace changes
  useEffect(() => {
    const load = async () => {
      try {
        const servers = await getAllMcpServers();
        const enabled = await getEnabledMcpServerIds();
        setLauncherMcpServers(servers);
        setLauncherGlobalMcpEnabled(enabled);
        setLauncherWorkspaceMcpEnabled(
          selectedAgent?.mcpEnabledServers ??
            selectedWorkspace?.mcpEnabledServers ??
            [],
        );
      } catch (err) {
        console.warn('[Launcher] Failed to load MCP servers:', err);
      }
    };
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspace?.id]);

  // Refresh MCP local state when tab becomes active (inactive → active transition).
  // Config/projects/providers/apiKeys are shared via ConfigProvider and auto-sync.
  // MCP servers are local state, so we reload them from disk on tab activation.
  const prevIsActiveRef = useRef(isActive);
  useEffect(() => {
    const wasInactive = !prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;
    if (!wasInactive || !isActive) return;

    void (async () => {
      try {
        const servers = await getAllMcpServers();
        const enabled = await getEnabledMcpServerIds();
        setLauncherMcpServers(servers);
        setLauncherGlobalMcpEnabled(enabled);
      } catch (err) {
        console.warn(
          '[Launcher] Failed to reload MCP servers on activation:',
          err,
        );
      }
    })();
  }, [isActive]);

  // PRD 0.2.17 — Launcher plugin toggle (local state only; persisted via
  // launcherLastUsed at send time and carried to the new Tab via
  // InitialMessage.enabledPluginIds). No disk write here — Launcher
  // has no Agent context to write the per-Agent enable list against.
  const handleLauncherPluginToggle = useCallback(
    (pluginId: string, enabled: boolean) => {
      setLauncherEnabledPlugins((prev) =>
        enabled ? [...prev, pluginId] : prev.filter((id) => id !== pluginId),
      );
    },
    [],
  );

  const handleLauncherOfficialToolToggle = useCallback(
    (toolId: OfficialToolId, enabled: boolean) => {
      setLauncherOfficialToolEnabled((prev) => {
        const newEnabled = normalizeOfficialToolIds(
          enabled ? [...prev, toolId] : prev.filter((id) => id !== toolId),
        );
        if (selectedWorkspace) {
          void persistInputOptionChange({
            workspaceId: selectedWorkspace.id,
            agentId: selectedWorkspace.agentId ?? null,
            isExternalRuntime,
            currentRuntimeConfig: runtimeConfigRef.current,
            currentProviderId:
              selectedAgent?.providerId ?? selectedWorkspace.providerId,
            fields: { enabledOfficialToolIds: newEnabled },
            patchProject,
            patchAgentConfig,
            patchAgentProjectConfig,
          });
        }
        return newEnabled;
      });
    },
    [
      selectedWorkspace,
      selectedAgent?.providerId,
      patchProject,
      isExternalRuntime,
    ],
  );

  // Handle workspace MCP toggle — delegates to the shared dual-write helper
  // (PRD 0.2.7) so launcher and chat-tab persist identical fields.
  const handleWorkspaceMcpToggle = useCallback(
    (serverId: string, enabled: boolean) => {
      if (
        serverId === MANAGED_BROWSER_MCP_ID &&
        enabled &&
        !managedBrowserReady
      ) {
        toastRef.current.warning(
          tSettings('toolbox.browserResource.installFirst'),
        );
        return;
      }
      setLauncherWorkspaceMcpEnabled((prev) => {
        const newEnabled = applyBuiltinBrowserExecutionToolToggle(
          prev,
          serverId,
          enabled,
          managedBrowserReady,
        );
        if (selectedWorkspace) {
          void persistInputOptionChange({
            workspaceId: selectedWorkspace.id,
            agentId: selectedWorkspace.agentId ?? null,
            isExternalRuntime,
            currentRuntimeConfig: runtimeConfigRef.current,
            currentProviderId:
              selectedAgent?.providerId ?? selectedWorkspace.providerId,
            fields: { mcpEnabledServers: newEnabled },
            patchProject,
            patchAgentConfig,
            patchAgentProjectConfig,
            // Launcher has no Sidecar — sidecar push happens after handoff.
          });
        }
        return newEnabled;
      });
    },
    [
      selectedWorkspace,
      selectedAgent?.providerId,
      patchProject,
      isExternalRuntime,
      managedBrowserReady,
      tSettings,
    ],
  );

  // Restore launcherLastUsed settings once config finishes loading from disk.
  // useState initializers run before async config load completes (config = DEFAULT_CONFIG
  // at that point), so we must sync saved values via effect after isLoading becomes false.
  const lastUsedAppliedRef = useRef(false);
  useEffect(() => {
    if (isLoading || lastUsedAppliedRef.current) return;
    lastUsedAppliedRef.current = true;
    const lastUsed = config.launcherLastUsed;
    if (!lastUsed) return;
    if (lastUsed.permissionMode)
      setLauncherPermissionMode(lastUsed.permissionMode);
    // #234: launcherLastUsed is a global, workspace-agnostic snapshot of the
    // last provider/model the user picked from the launcher. Restoring it
    // verbatim shadows the selected agent's CURRENT default (the launcherProvider
    // memo prefers launcherProviderId), so after the user changes an Agent's
    // provider in Settings (e.g. MiniMax → DeepSeek) the launcher kept opening
    // sessions on the stale provider → request timeouts. Only restore the cached
    // provider/model when it's still consistent with the agent default; otherwise
    // the agent default wins (and the stale model is dropped with it).
    const resolved = resolveLauncherProvider({
      lastUsedProviderId: lastUsed.providerId,
      lastUsedModel: lastUsed.model,
      agentProviderId: selectedAgent?.providerId,
      agentModel: selectedAgent?.model,
      workspaceProviderId: selectedWorkspace?.providerId,
      workspaceModel: selectedWorkspace?.model,
      defaultProviderId: config.defaultProviderId,
    });
    if (resolved.providerId) setLauncherProviderId(resolved.providerId);
    if (resolved.model) setLauncherSelectedModel(resolved.model);
    if (lastUsed.mcpEnabledServers)
      setLauncherWorkspaceMcpEnabled(lastUsed.mcpEnabledServers);
    if (lastUsed.enabledPluginIds)
      setLauncherEnabledPlugins(lastUsed.enabledPluginIds);
    if (lastUsed.enabledOfficialToolIds)
      setLauncherOfficialToolEnabled(
        normalizeOfficialToolIds(lastUsed.enabledOfficialToolIds),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time restore; selected agent/workspace read at apply time, intentionally not deps
  }, [isLoading, config.launcherLastUsed]);

  // Extract runtimeConfig primitives for stable useEffect deps (avoid object reference)
  const agentRuntimeModel = (
    selectedAgent?.runtimeConfig as { model?: string } | undefined
  )?.model;
  const agentRuntimePermMode = (
    selectedAgent?.runtimeConfig as { permissionMode?: string } | undefined
  )?.permissionMode;
  const agentRuntimeReasoningEffort = (
    selectedAgent?.runtimeConfig as { reasoningEffort?: string } | undefined
  )?.reasoningEffort;

  // Sync launcher settings from selected workspace's per-project config.
  // Declared AFTER launcherLastUsed effect so project settings take priority on initial load.
  // Priority: project setting > global default (launcherLastUsed is global, not per-workspace)
  // Depends on individual fields (not just .id) so it re-runs when Chat's patchProject updates them.
  // NOTE (#234): when a workspace is selected this effect is the primary author
  // of launcherProviderId (always agent → project default), so it already keeps
  // the launcher current after an agent-provider change. The consistency check
  // in the launcherLastUsed restore effect above is load-bearing for the
  // no-workspace / pre-this-effect window — both must agree; don't "simplify"
  // by deleting one.
  useEffect(() => {
    if (isLoading || !selectedWorkspace) return;
    // For external runtimes, model and permission come from runtimeConfig.
    // Branch on isExternalRuntime alone — empty runtimeConfig is valid (uses runtime defaults).
    if (isExternalRuntime) {
      setLauncherSelectedModel(agentRuntimeModel ?? undefined);
      setLauncherPermissionMode(
        (agentRuntimePermMode as PermissionMode | undefined) ??
          config.defaultPermissionMode,
      );
      setLauncherReasoningEffort(agentRuntimeReasoningEffort ?? 'default');
    } else {
      setLauncherPermissionMode(
        (selectedAgent?.permissionMode as PermissionMode | undefined) ??
          selectedWorkspace.permissionMode ??
          config.defaultPermissionMode,
      );
      setLauncherSelectedModel(
        selectedAgent?.model ?? selectedWorkspace.model ?? undefined,
      );
      setLauncherReasoningEffort(selectedAgent?.reasoningEffort ?? 'default');
    }
    setLauncherProviderId(
      selectedAgent?.providerId ?? selectedWorkspace.providerId ?? undefined,
    );
    setLauncherWorkspaceMcpEnabled(
      selectedAgent?.mcpEnabledServers ??
        selectedWorkspace.mcpEnabledServers ??
        [],
    );
    setLauncherOfficialToolEnabled(
      normalizeOfficialToolIds(
        selectedAgent?.enabledOfficialToolIds ??
          selectedWorkspace.enabledOfficialToolIds ??
          [],
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on specific agent/project fields, not object ref
  }, [
    isLoading,
    selectedWorkspace?.id,
    selectedAgent?.permissionMode,
    selectedAgent?.model,
    selectedAgent?.providerId,
    selectedAgent?.mcpEnabledServers,
    selectedAgent?.enabledOfficialToolIds,
    selectedAgent?.runtime,
    selectedAgent?.reasoningEffort,
    agentRuntimeModel,
    agentRuntimePermMode,
    agentRuntimeReasoningEffort,
    selectedWorkspace?.permissionMode,
    selectedWorkspace?.model,
    selectedWorkspace?.providerId,
    selectedWorkspace?.mcpEnabledServers,
    selectedWorkspace?.enabledOfficialToolIds,
    config.defaultPermissionMode,
    multiAgentRuntimeEnabled,
    isExternalRuntime,
  ]);

  // Write-back handlers: persist Launcher setting changes to the selected project

  const handleLauncherPermissionModeChange = useCallback(
    (mode: PermissionMode) => {
      setLauncherPermissionMode(mode);
      if (selectedWorkspace) {
        const model = launcherSelectedModel ?? launcherProvider?.primaryModel;
        const intent =
          selectedAgentUsesManagedCodexProvider && launcherProvider && model
            ? toProviderExecutionIntent(launcherProvider, model)
            : undefined;
        void persistInputOptionChange({
          workspaceId: selectedWorkspace.id,
          agentId: selectedWorkspace.agentId ?? null,
          isExternalRuntime,
          currentRuntimeConfig: runtimeConfigRef.current,
          currentProviderId:
            selectedAgent?.providerId ?? selectedWorkspace.providerId,
          fields:
            intent?.kind === 'runtime-backed-provider'
              ? { runtimeBackedProviderSelection: intent, permissionMode: mode }
              : { permissionMode: mode },
          patchProject,
          patchAgentConfig,
          patchAgentProjectConfig,
        });
      }
    },
    [
      selectedWorkspace,
      selectedAgent?.providerId,
      patchProject,
      isExternalRuntime,
      launcherSelectedModel,
      launcherProvider,
      selectedAgentUsesManagedCodexProvider,
    ],
  );

  const handleLauncherModelChange = useCallback(
    (model: string | undefined) => {
      setLauncherSelectedModel(model);
      if (selectedWorkspace) {
        const providerExecutionIntent =
          !isExternalRuntime && launcherProvider && model
            ? toProviderExecutionIntent(launcherProvider, model)
            : undefined;
        void persistInputOptionChange({
          workspaceId: selectedWorkspace.id,
          agentId: selectedWorkspace.agentId ?? null,
          isExternalRuntime,
          currentRuntimeConfig: runtimeConfigRef.current,
          currentProviderId:
            selectedAgent?.providerId ?? selectedWorkspace.providerId,
          fields: isExternalRuntime
            ? { runtimeModel: model ?? null }
            : providerExecutionIntent?.kind === 'runtime-backed-provider'
              ? { runtimeBackedProviderSelection: providerExecutionIntent }
              : { builtinModel: model ?? null },
          patchProject,
          patchAgentConfig,
          patchAgentProjectConfig,
        });
      }
    },
    [
      selectedWorkspace,
      selectedAgent?.providerId,
      patchProject,
      isExternalRuntime,
      launcherProvider,
    ],
  );

  // #324 — 推理强度 write-back. Same dual-write shape as model/permission;
  // no live sidecar in launcher, so disk persistence is the whole job (the
  // handed-off Chat tab seeds from the agent and pushes on connect).
  const handleLauncherReasoningEffortChange = useCallback(
    (effort: string) => {
      setLauncherReasoningEffort(effort);
      if (selectedWorkspace) {
        void persistInputOptionChange({
          workspaceId: selectedWorkspace.id,
          agentId: selectedWorkspace.agentId ?? null,
          isExternalRuntime,
          currentRuntimeConfig: runtimeConfigRef.current,
          currentProviderId:
            selectedAgent?.providerId ?? selectedWorkspace.providerId,
          fields: { reasoningEffort: effort },
          patchProject,
          patchAgentConfig,
          patchAgentProjectConfig,
        });
      }
    },
    [
      selectedWorkspace,
      selectedAgent?.providerId,
      patchProject,
      isExternalRuntime,
    ],
  );

  // PRD 0.2.7 D6: Runtime change in launcher persists to Agent.runtime so the
  // next Chat session boots in the chosen runtime. No live sidecar to fork —
  // the next handoff creates a fresh sidecar with the persisted runtime.
  const handleLauncherRuntimeChange = useCallback(
    async (runtime: RuntimeType) => {
      if (!selectedWorkspace?.agentId) {
        toastRef.current.warning(t('toasts.runtimeNeedsAgent'));
        return;
      }
      try {
        // buildRuntimeChangePatch scrubs cross-runtime non-portable fields
        // (model / permissionMode / additionalArgs). All 4 runtime-change
        // callsites funnel through this helper. See doc in
        // shared/types/runtime.ts.
        await patchAgentConfig(
          selectedWorkspace.agentId,
          buildRuntimeChangePatch(selectedAgent?.runtimeConfig, runtime),
        );
      } catch (err) {
        console.error('[Launcher] runtime change failed:', err);
        toastRef.current.error(t('toasts.runtimeSwitchFailed'));
      }
    },
    [selectedWorkspace?.agentId, selectedAgent?.runtimeConfig, t],
  );

  const handleLauncherProviderChange = useCallback(
    (providerId: string | undefined, targetModel?: string) => {
      setLauncherProviderId(providerId);
      const newProvider = providerId
        ? providers.find((p) => p.id === providerId)
        : undefined;
      const model = targetModel ?? newProvider?.primaryModel;
      if (model) {
        setLauncherSelectedModel(model);
      }
      if (selectedWorkspace) {
        const providerExecutionIntent =
          newProvider && model
            ? toProviderExecutionIntent(newProvider, model)
            : undefined;
        void persistInputOptionChange({
          workspaceId: selectedWorkspace.id,
          agentId: selectedWorkspace.agentId ?? null,
          isExternalRuntime,
          currentRuntimeConfig: runtimeConfigRef.current,
          currentProviderId:
            selectedAgent?.providerId ?? selectedWorkspace.providerId,
          fields: {
            ...(providerExecutionIntent?.kind === 'runtime-backed-provider'
              ? { runtimeBackedProviderSelection: providerExecutionIntent }
              : {
                  providerId: providerId ?? undefined,
                  builtinModel: model ?? undefined,
                }),
          },
          patchProject,
          patchAgentConfig,
          patchAgentProjectConfig,
        });
      }
    },
    [
      selectedWorkspace,
      selectedAgent?.providerId,
      patchProject,
      providers,
      isExternalRuntime,
    ],
  );

  // Navigate to Settings > Providers page
  const handleGoToSettings = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
        detail: { section: 'providers' },
      }),
    );
  }, []);

  const handleOpenSpeechSettings = useCallback(() => {
    setRecordingSourceDialog(null);
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
        detail: {
          section: 'mcp',
          officialToolId: 'speech-recognition',
        },
      }),
    );
  }, []);

  const handleRequestRecording = useCallback(async () => {
    const initialSelection = config.recordingSourceSelection ?? {
      microphone: true,
      system: true,
    };
    setRecordingRequestBusy(true);
    if (config.recordingSourceSelection) {
      try {
        await onStartRecording(initialSelection);
      } catch (error) {
        setRecordingSourceDialog({
          mode: 'start',
          initialSelection,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setRecordingRequestBusy(false);
      }
      return;
    }
    let modelPackUsable: boolean | undefined;
    try {
      modelPackUsable = (await speechModelPackStatus()).usable;
    } catch {
      // Resource status is advisory for start; capture remains available.
    }
    setRecordingSourceDialog({
      mode: 'start',
      initialSelection,
      modelPackUsable,
    });
    setRecordingRequestBusy(false);
  }, [config.recordingSourceSelection, onStartRecording]);

  const handleRecordingSourceConfirm = useCallback(
    async (selection: RecordingSourceSelection) => {
      const dialog = recordingSourceDialog;
      if (!dialog) return;
      setRecordingRequestBusy(true);
      try {
        await updateConfig({ recordingSourceSelection: selection });
        if (dialog.mode === 'start') {
          await onStartRecording(selection);
        }
        setRecordingSourceDialog(null);
      } catch (error) {
        setRecordingSourceDialog({
          ...dialog,
          initialSelection: selection,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setRecordingRequestBusy(false);
      }
    },
    [onStartRecording, recordingSourceDialog, updateConfig],
  );

  // Promote a project to the global default workspace. Same code path as
  // Settings → 通用设置 → 默认工作区 (`updateConfig({ defaultWorkspacePath })`)
  // — keeps the WorkspaceSelector dropdown in sync with the existing config
  // surface so a change made here shows up in Settings on next open and
  // vice versa. Failure is non-fatal — toast a warning but keep the dropdown
  // usable; the user can retry.
  const handleSetDefault = useCallback(
    async (project: Project) => {
      try {
        await updateConfig({ defaultWorkspacePath: project.path });
      } catch (err) {
        console.error('[Launcher] failed to set default workspace:', err);
        toastRef.current.warning(t('toasts.setDefaultFailed'));
      }
    },
    [t, updateConfig],
  );

  // Handle send from BrandSection — `cron` is the launcher-staged cron config
  // (PRD 0.2.7 D1); when present, Chat's autoSend dispatches startCronTask
  // instead of sendMessage.
  const handleBrandSend = useCallback(
    async (
      text: string,
      images?: ImageAttachment[],
      cron?: import('@/types/tab').InitialMessageCron,
    ) => {
      if (!selectedWorkspace) {
        toastRef.current.error(t('toasts.selectWorkspaceFirst'));
        return;
      }

      // PRD 0.2.3 + cross-review: split provider/model by runtime dimension. For builtin,
      // pairBuiltinSelection enforces model ∈ provider.models — closing the
      // "stale agent.model paired with first-available fallback provider" hole when the
      // primary provider's key was deleted between agent setup and send.
      const launcherModelForProvider =
        launcherSelectedModel ?? launcherProvider?.primaryModel;
      const providerExecutionIntent =
        !isExternalRuntime && launcherProvider && launcherModelForProvider
          ? toProviderExecutionIntent(
              launcherProvider,
              launcherModelForProvider,
            )
          : undefined;
      const runtimeBackedProviderIdentity =
        providerExecutionIntent?.kind === 'runtime-backed-provider'
          ? providerExecutionIntent
          : undefined;
      const builtinSelection =
        !isExternalRuntime &&
        launcherProvider &&
        !isRuntimeBackedProvider(launcherProvider)
          ? pairBuiltinSelection(launcherProvider, launcherSelectedModel)
          : undefined;
      const runtimeModel = isExternalRuntime
        ? launcherSelectedModel
        : runtimeBackedProviderIdentity?.model;
      // PRD 0.2.17 — only carry plugins that are still globally visible
      // (Settings 开关 ON) to avoid silently re-enabling hidden plugins
      // when Launcher's last-used list is older than the current visibility
      // state.
      const launcherVisiblePluginIds = new Set(
        (config.plugins ?? [])
          .filter((p) => config.enabledPlugins?.[p.id] === true)
          .map((p) => p.id),
      );
      const carriedEnabledPlugins = launcherEnabledPlugins.filter((id) =>
        launcherVisiblePluginIds.has(id),
      );
      const carriedOfficialTools = launcherOfficialToolEnabled.filter(
        (id) =>
          launcherGlobalOfficialToolEnabled.includes(id) &&
          (id !== IMAGE_UNDERSTANDING_TOOL_ID ||
            imageUnderstandingConfiguredForInput),
      );

      const initialMessage: InitialMessage = {
        text,
        images,
        permissionMode: launcherPermissionMode,
        mcpEnabledServers: launcherWorkspaceMcpEnabled.filter((id) =>
          launcherGlobalMcpEnabled.includes(id),
        ),
        ...(carriedEnabledPlugins.length > 0
          ? { enabledPluginIds: carriedEnabledPlugins }
          : {}),
        enabledOfficialToolIds: carriedOfficialTools,
        ...(builtinSelection ? { builtinSelection } : {}),
        ...(runtimeModel ? { runtimeModel } : {}),
        ...(runtimeBackedProviderIdentity
          ? { providerExecutionIdentity: runtimeBackedProviderIdentity }
          : {}),
        // #324 — hand-carry: don't bet the async agent-config write wins
        // the race against the new tab's mount/seed.
        ...(launcherReasoningEffort !== 'default'
          ? { reasoningEffort: launcherReasoningEffort }
          : {}),
        ...(cron ? { cron } : {}),
      };

      // Persist launcher settings for next app launch
      updateConfig({
        launcherLastUsed: {
          providerId: launcherProvider?.id,
          model: launcherSelectedModel,
          permissionMode: launcherPermissionMode,
          mcpEnabledServers: launcherWorkspaceMcpEnabled,
          enabledPluginIds: launcherEnabledPlugins,
          enabledOfficialToolIds: launcherOfficialToolEnabled,
        },
      }).catch((err) =>
        console.warn('[Launcher] Failed to save launcherLastUsed:', err),
      );

      setLaunchingProjectId(selectedWorkspace.id);
      touchProject(selectedWorkspace.id).catch(() => {});

      // Bug 1 fix — "新开对话" launcher cron should NOT pop a chat tab.
      // The modal's promise to the user: "创建独立定时任务，不占用当前对话".
      // Chat.tsx already has the in-chat equivalent (line ~2056: when
      // `executionTarget === 'new_task'` it creates a standalone task and
      // toasts "定时任务已创建" instead of dispatching as a chat message).
      // Mirror that behavior here so the launcher path honors the same
      // user-visible promise.
      //
      // Path:
      //   1. createCronTask with a freshly-minted standalone session id
      //      (matches `cron-standalone-<uuid>` convention from Chat.tsx)
      //   2. startCronTask (persists running and arms the scheduler)
      //   3. toast + clear loading; stay on launcher
      // Failure → fall through to the regular tab-launch path so the user
      // doesn't lose their input — same recovery contract Chat.tsx
      // autoSend uses.
      if (cron?.taskKind === 'cron' && cron.executionTarget === 'new_task') {
        try {
          const standaloneSessionId = `cron-standalone-${crypto.randomUUID()}`;
          // Send provider identity only. TaskStore never persists
          // credential env; a new execution Session resolves it live.
          //
          // External runtimes don't carry a providerId (they manage
          // their own provider via their CLI). When the runtime is
          // external, providerId is undefined → sidecar follows the
          // agent's runtime resolution.
          const launcherProviderId =
            !isExternalRuntime && launcherProvider
              ? launcherProvider.id
              : undefined;
          const cronExecution = projectTaskExecutionOverrides({
            providers,
            runtime: launcherRuntime,
            providerId: launcherProviderId,
            model: builtinSelection?.model ?? runtimeModel,
            runtimeConfig: isExternalRuntime
              ? runtimeConfigRef.current
              : undefined,
          });
          const cronPermissionMode = coerceRuntimeBirthPermissionMode(
            launcherPermissionMode,
            cronExecution.runtime ?? launcherRuntime,
          );
          const created = await createCronTask({
            workspacePath: selectedWorkspace.path,
            sessionId: standaloneSessionId,
            prompt: text,
            intervalMinutes: cron.intervalMinutes,
            endConditions: cron.endConditions,
            runMode: 'new_session',
            notifyEnabled: cron.notifyEnabled,
            schedule: cron.schedule,
            delivery: cron.delivery,
            name: cron.name,
            permissionMode: cronPermissionMode,
            model: cronExecution.model,
            providerId: cronExecution.providerId,
            runtime: cronExecution.runtime,
            runtimeConfig: cronExecution.runtimeConfig,
            // A standalone Task has no existing Session, so the
            // launcher's MCP selection initializes its first Session.
            mcpEnabledServers: launcherWorkspaceMcpEnabled,
          });
          await startCronTask(created.id);
          track('launcher_cron_create_standalone', {
            interval_minutes: cron.intervalMinutes,
            schedule_kind: cron.schedule.kind,
          });
          toastRef.current.success(t('toasts.standaloneCronCreated'));
          setLaunchingProjectId(null);
          return;
        } catch (err) {
          console.error(
            '[Launcher] Failed to create standalone cron task:',
            err,
          );
          toastRef.current.error(
            t('toasts.createCronFailed', {
              message: err instanceof Error ? err.message : String(err),
            }),
          );
          setLaunchingProjectId(null);
          return;
        }
      }

      onLaunchProject(selectedWorkspace, initialMessage, {
        surface: 'launcher_input',
        entryIntent: 'send_message',
      });
    },
    [
      selectedWorkspace,
      launcherProvider,
      launcherPermissionMode,
      launcherSelectedModel,
      launcherReasoningEffort,
      launcherWorkspaceMcpEnabled,
      launcherGlobalMcpEnabled,
      launcherEnabledPlugins,
      launcherOfficialToolEnabled,
      launcherGlobalOfficialToolEnabled,
      imageUnderstandingConfiguredForInput,
      config.plugins,
      config.enabledPlugins,
      isExternalRuntime,
      launcherRuntime,
      providers,
      t,
      touchProject,
      onLaunchProject,
      updateConfig,
    ],
  );

  // Path input dialog state (for browser dev mode)
  const [pathDialogOpen, setPathDialogOpen] = useState(false);
  const [pendingFolderName, setPendingFolderName] = useState('');
  const [pendingDefaultPath, setPendingDefaultPath] = useState('');

  const handleAddProject = async () => {
    setAddError(null);
    console.log('[Launcher] handleAddProject called');

    try {
      if (isBrowserDevMode()) {
        const folderInfo = await pickFolderForDialog();
        if (folderInfo) {
          setPendingFolderName(folderInfo.folderName);
          setPendingDefaultPath(folderInfo.defaultPath);
          setPathDialogOpen(true);
        } else {
          console.log('[Launcher] Folder picker cancelled');
        }
      } else {
        const selected = await open({
          directory: true,
          multiple: false,
          title: t('dialogs.pickProjectFolder'),
        });
        console.log('[Launcher] Dialog result:', selected);

        if (selected && typeof selected === 'string') {
          console.log('[Launcher] Adding project:', selected);
          const project = await addProject(selected);
          console.log('[Launcher] Project added:', project);
        } else {
          console.log('[Launcher] No folder selected or dialog cancelled');
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Launcher] Failed to add project:', errorMsg);
      setAddError(errorMsg);
      toast.error(t('toasts.addProjectFailed', { message: errorMsg }));
    }
  };

  const handlePathConfirm = async (path: string) => {
    setPathDialogOpen(false);
    console.log('[Launcher] Path confirmed:', path);

    try {
      const project = await addProject(path);
      console.log('[Launcher] Project added:', project);
      // Normalize path separators for cross-platform support
      const normalizedPath = path.replace(/\\/g, '/');
      const parentDir = normalizedPath.split('/').slice(0, -1).join('/');
      if (parentDir) {
        localStorage.setItem('myagents:lastProjectDir', parentDir);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Launcher] Failed to add project:', errorMsg);
      setAddError(errorMsg);
      toast.error(t('toasts.addProjectFailed', { message: errorMsg }));
    }
  };

  const handlePathCancel = () => {
    setPathDialogOpen(false);
    console.log('[Launcher] Path dialog cancelled');
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      {/* Path Input Dialog (browser dev mode) */}
      <PathInputDialog
        isOpen={pathDialogOpen}
        folderName={pendingFolderName}
        defaultPath={pendingDefaultPath}
        onConfirm={handlePathConfirm}
        onCancel={handlePathCancel}
      />
      {recordingSourceDialog && (
        <RecordingSourceDialog
          mode={recordingSourceDialog.mode}
          initialSelection={recordingSourceDialog.initialSelection}
          modelPackUsable={recordingSourceDialog.modelPackUsable}
          error={recordingSourceDialog.error}
          busy={recordingRequestBusy}
          onConfirm={handleRecordingSourceConfirm}
          onCancel={() => setRecordingSourceDialog(null)}
          onOpenSpeechSettings={handleOpenSpeechSettings}
        />
      )}

      <main className="relative flex flex-1 items-center justify-center overflow-hidden">
        <section className="launcher-brand relative flex h-full w-full items-center justify-center overflow-hidden">
          <BrandSection
            projects={visibleProjects}
            selectedProject={selectedWorkspace}
            defaultWorkspacePath={config.defaultWorkspacePath}
            onSelectWorkspace={(project) =>
              onWorkspaceSelectionChange?.(project.path)
            }
            onAddFolder={handleAddProject}
            onSetDefaultWorkspace={handleSetDefault}
            onSend={handleBrandSend}
            onStartRecording={handleRequestRecording}
            onOpenRecord={onOpenRecord}
            recordingBusy={recordingBusy || recordingRequestBusy}
            attachmentSessionId={attachmentSessionId}
            isStarting={
              launchingProjectId === selectedWorkspace?.id && isStarting
            }
            provider={launcherProvider}
            providers={providers}
            selectedModel={launcherSelectedModel}
            onProviderChange={handleLauncherProviderChange}
            onModelChange={handleLauncherModelChange}
            reasoningEffort={launcherReasoningEffort}
            onReasoningEffortChange={handleLauncherReasoningEffortChange}
            permissionMode={launcherPermissionMode}
            onPermissionModeChange={handleLauncherPermissionModeChange}
            apiKeys={apiKeys}
            providerVerifyStatus={providerVerifyStatus}
            workspaceMcpEnabled={launcherWorkspaceMcpEnabled}
            globalMcpEnabled={launcherGlobalMcpEnabled}
            mcpServers={launcherMcpServers}
            onWorkspaceMcpToggle={handleWorkspaceMcpToggle}
            officialTools={OFFICIAL_TOOLS}
            workspaceOfficialToolEnabled={launcherOfficialToolEnabled}
            globalOfficialToolEnabled={launcherGlobalOfficialToolEnabled}
            officialToolNeedsConfig={launcherOfficialToolNeedsConfig}
            onWorkspaceOfficialToolToggle={handleLauncherOfficialToolToggle}
            // PRD 0.2.17 — same plugin props as Chat. Source from
            // AppConfig (Layer 1 visibility gate); Layer 2 is
            // Launcher's transient selection (handed off to new
            // Tab via InitialMessage.enabledPluginIds).
            globallyVisiblePlugins={(config.plugins ?? [])
              .filter((p) => config.enabledPlugins?.[p.id] === true)
              .map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description,
              }))}
            workspaceEnabledPlugins={launcherEnabledPlugins}
            onWorkspacePluginToggle={handleLauncherPluginToggle}
            onRefreshProviders={refreshProviderData}
            onGoToSettings={handleGoToSettings}
            runtime={isExternalRuntime ? launcherRuntime : undefined}
            runtimeModels={
              isExternalRuntime ? launcherRuntimeModels : undefined
            }
            runtimePermissionModes={
              isExternalRuntime ? launcherRuntimePermissionModes : undefined
            }
            /* PRD 0.2.7 Phase F: runtime selector lives below the input
             * (LauncherInputContextRow) when the experimental gate is on. */
            multiAgentRuntimeEnabled={multiAgentRuntimeEnabled}
            runtimeDetections={runtimeDetections}
            onRuntimeChange={handleLauncherRuntimeChange}
            activeRuntime={launcherRuntime}
            isActive={isActive}
          />
        </section>
      </main>
    </div>
  );
}
