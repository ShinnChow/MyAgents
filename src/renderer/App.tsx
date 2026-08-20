import { useCallback, useEffect, useMemo, useState, useRef, memo, lazy, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ChatBootOverlay from '@/components/ChatBootOverlay';
import { arrayMove } from '@dnd-kit/sortable';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import {
  initAnalytics,
  track,
  setAnalyticsContext,
  clearAnalyticsContext,
  setPendingSessionBirth,
  clearPendingSessionBirth,
  birthContextForSurface,
  hashAgentName,
  hashAgentNameSync,
} from '@/analytics';
import type { AssistantEntry, EntryIntent, HistoryEntrySource, PendingSessionBirthContext, Surface } from '@/analytics';
import { stopTabSidecar, startGlobalSidecar, initGlobalSidecarReadyPromise, markGlobalSidecarReady, ensureSessionSidecar, releaseTabSession, reconcileSessionTabActivation, upgradeSessionId, hasSessionSidecar, getSessionGeneration, stopSseProxy, startBackgroundCompletion, startBackgroundCompletionForDeletion, canRestoreSession, getUserSchedulerLifecycleSnapshot, querySessionHasPersistentOwners, sessionHasPersistentOwners, setAppActiveCorrelation } from '@/api/tauriClient';
import ConfirmDialog from '@/components/ConfirmDialog';
import BugReportOverlay from '@/components/BugReportOverlay';
import { DispatchTaskDialog } from '@/components/task-center/DispatchTaskDialog';
import CustomTitleBar from '@/components/CustomTitleBar';
import GlobalSidebar, { type CapabilitySection } from '@/components/global-sidebar/GlobalSidebar';
import LinkContextMenuProvider from '@/components/LinkContextMenuProvider';
import TabBar from '@/components/TabBar';
import { SessionDeletionContext } from '@/context/SessionDeletionContext';
import TabProvider from '@/context/TabProvider';
import type { AdoptMigratedSessionOptions } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import type { HelperRequestDetail } from '@/utils/dispatchHelperRequest';
import { useUpdater } from '@/hooks/useUpdater';
import { useTrayEvents } from '@/hooks/useTrayEvents';
import { useHelperAgentModelDefaults } from '@/hooks/useHelperAgentModelDefaults';
import { useConfig } from '@/hooks/useConfig';
import { useSpaceBuildCapability } from '@/hooks/useSpaceBuildCapability';
import { useTabSwipeGesture } from '@/hooks/useTabSwipeGesture';
import { actions as taskCenterActions } from '@/hooks/taskCenterStore';
import Launcher from '@/pages/Launcher'; // eager: default first view → no cold-start fallback
// Route-split (P1): heavy / non-initial pages load on demand. lazy-Chat moves the
// entire markdown/mermaid/katex/syntax-highlighter chain out of the entry chunk
// (reachable only via Chat). Launcher stays eager (default first view → no
// cold-start fallback).
//
// NOTE: we deliberately do NOT idle-preload these. A blind idle preload made
// WKWebView warn "<chunk> was preloaded but not used within a few seconds" for
// the whole route graph on every startup, AND eagerly pulled Monaco/Markdown
// (several MB) at boot even when the user never opened those pages. In Tauri the
// chunks are LOCAL assets, so first-open is fast and just shows the same paper
// Suspense fallback the deferred-mount placeholder already uses. (If first Chat
// open ever feels slow, add a targeted preload on launch intent — not a blind
// idle preload of every route.)
const Chat = lazy(() => import('@/pages/Chat'));
const Settings = lazy(() => import('@/pages/Settings'));
const TaskCenter = lazy(() => import('@/pages/TaskCenter'));
const Space = lazy(() => import('@/pages/Space'));

/** Layout-compatible Suspense fallback for a lazy page chunk — same paper fill
 *  as the deferred-mount placeholder, so a chunk-load is never a jarring blank. */
const PAGE_FALLBACK = <div className="h-full w-full bg-[var(--paper)]" />;
import {
  isProjectVisibleToUser,
  type Project,
} from '@/config/types';
import { type Tab, type InitialMessage, type LaunchSessionBirthHint, type SidecarConfigDisposition, type FilePreviewIntent, createNewTab, getFolderName, buildChatFlipPatch, MAX_TABS } from '@/types/tab';
import { buildRestoredTabs, saveOpenTabs, hydratePersistedState, pickDurableOverride, shouldOfferRestore, planRestoreTabs } from '@/utils/tabPersistence';
import { persistOpenTabsDurable, loadAndClearOpenTabsDurable, clearOpenTabsDurable } from '@/utils/tabPersistenceDurable';
import { consumeCleanExitMarker } from '@/utils/lastExitMarker';
import { tabContentKind } from '@/utils/tabContentKind';
import { runAfterNextPaint } from '@/utils/afterPaint';
import { perfMark } from '@/utils/perfMark';
import { RENDERER_PERF_PHASE } from '../shared/perfTrace';
import { type CronRecoverySummaryPayload, type CronTaskRecoveredPayload, CRON_EVENTS } from '@/types/cronEvents';
import { isBrowserDevMode, isTauriEnvironment } from '@/utils/browserMock';
import { apiGetJson } from '@/api/apiFetch';
import { createSession, getSessions, updateSession } from '@/api/sessionClient';
import { dismissTopmost } from '@/utils/closeLayer';
import { dispatchAppShortcut } from '@/utils/appShortcuts';
import { handleSelectAllKeydown } from '@/utils/selectAllRouter';
import { forceFlushLogs, setLogServerReady, clearLogServerUrl, setAppActiveTabId } from '@/utils/frontendLogger';
import { normalizeRuntime, resolveEffectiveRuntime, planSessionOpen, sessionRuntimeIdentityFromMetadataForOpen } from '@/utils/sessionOpenPlan';
import { resolveNotificationClickRoute } from '@/utils/notificationClickRoute';
import {
  acknowledgeNotificationBadgeTarget,
  buildSessionNotificationBadgeCounts,
  countNotificationBadgeItems,
  isNotificationBadgeTargetVisible,
  normalizeNotificationBadgeIncrementPayload,
  upsertNotificationBadgeItem,
  type NotificationBadgeIncrementPayload,
  type NotificationBadgeItem,
  type NotificationBadgeTarget,
} from '@/utils/notificationBadgeRegistry';
import { applyTerminalSessionToTabs, resetTabToLauncher } from '@/utils/sessionTermination';
import {
  createSessionResourceTransitionState,
  deleteSessionThroughAppOwner,
  isSessionOpening,
  tryClaimSessionResourceTransition,
} from '@/utils/sessionDeletionCoordinator';
import { getSessionDisplayText } from '@/utils/sessionDisplay';
import { listenWithCleanup } from '@/utils/tauriListen';
import { migrateFloatingBallSessionBinding } from '@/floating-ball/sessionBinding';
import { CUSTOM_EVENTS, createPendingSessionId, isPendingSessionId } from '../shared/constants';
import { buildTaskDiscussionReminder } from '../shared/systemReminder';
import { TASK_ALIGNMENT_SKILL_REQUIREMENT } from '../shared/systemSkills';
import type {
  PreparedTaskDiscussion,
  TaskCreateIntent,
  TaskCreateRequest,
  TaskDiscussionRequest,
} from '../shared/taskDiscussion';
import { normalizeOfficialToolIds, type OfficialToolId } from '../shared/official-tools';
import { CODEX_SUBSCRIPTION_PROVIDER_ID, getManagedCodexProviderReadiness } from '../shared/config-types';
import { workspacePathsEqual } from '../shared/workspacePath';
import type { CapabilityInitialSelect } from '../shared/skillsTypes';
import { ensureSelfAwarenessWorkspace, resolveBuiltinSelection, pairBuiltinSelection, isProviderAvailable } from '@/config/configService';
import { getProjectAgent, getAgentById } from '@/config/services/agentConfigService';
import type { SessionMetadata } from '@/api/sessionClient';
import type { RuntimeSource, RuntimeType } from '../shared/types/runtime';
import {
  agentUsesManagedCodexProvider,
  createRuntimeBackedProviderIdentity,
  isRuntimeBackedProvider,
  toProviderExecutionIntent,
  type RuntimeBackedProviderIdentity,
} from '../shared/providerExecution';
import {
  originAnalyticsFields,
  originFromDesktopSurface,
  originFromSessionMetadataLike,
} from '../shared/session-origin';
import { buildRuntimeBackedInitialSessionBirth } from '@/utils/providerSwitchSessionBirth';
import { resolveGlobalSidebarWorkspace } from '@/utils/globalSidebarProjection';
import {
  nowForSpaceMetric,
  trackSpaceToolMutation,
} from '@/pages/space/spaceMetrics';
import {
  serializeAppRoute,
  type AppRoute,
  type PendingAppRoute,
} from '../shared/appRoute';

// ============================================================
// User Support Prompt Builder
// ============================================================

function buildSupportPrompt(description: string, appVersion: string): string {
  return [
    `## 用户反馈`,
    ``,
    `**App 版本**: ${appVersion}`,
    ``,
    `> ${description}`,
    ``,
    `请使用 /support skill 帮助用户解决这个问题。`,
  ].join('\n');
}

function normalizeInitialPermissionMode(value: unknown): InitialMessage['permissionMode'] | undefined {
  return value === 'auto' || value === 'plan' || value === 'fullAgency'
    ? value
    : undefined;
}

function isRendererForegrounded(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

function resolveInitialPermissionMode(args: {
  project: Pick<Project, 'permissionMode'>;
  agent?: { permissionMode?: unknown };
  defaultPermissionMode?: unknown;
}): InitialMessage['permissionMode'] | undefined {
  return normalizeInitialPermissionMode(args.agent?.permissionMode)
    ?? normalizeInitialPermissionMode(args.project.permissionMode)
    ?? normalizeInitialPermissionMode(args.defaultPermissionMode);
}

function normalizeStringSetting(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function cloneStringArray(value: string[] | undefined): string[] | undefined {
  return value ? [...value] : undefined;
}

interface SessionRuntimeOpenIdentity {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
}

function fallbackRuntimeForOpen(
  fallbackRuntime: RuntimeType,
  multiAgentRuntime: boolean | undefined,
): RuntimeType {
  return multiAgentRuntime ? fallbackRuntime : 'builtin';
}

function normalizeRuntimeSourceForOpen(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): RuntimeSource | undefined {
  if (runtime === 'builtin') return undefined;
  return runtimeSource ?? 'system-cli';
}

function analyticsRuntimeSource(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | undefined,
): RuntimeSource | null {
  if (runtime === 'builtin') return null;
  return runtimeSource ?? 'system-cli';
}

async function resolveSessionRuntimeIdentityForOpen(
  sessionId: string | null | undefined,
  fallbackRuntime: RuntimeType,
  multiAgentRuntime: boolean | undefined,
): Promise<SessionRuntimeOpenIdentity> {
  const fallback = fallbackRuntimeForOpen(fallbackRuntime, multiAgentRuntime);
  if (!sessionId || isPendingSessionId(sessionId)) {
    return { runtime: fallback, runtimeSource: normalizeRuntimeSourceForOpen(fallback, undefined) };
  }
  try {
    const meta = await apiGetJson<{ success: boolean; session?: SessionMetadata }>(`/sessions/${encodeURIComponent(sessionId)}?limit=1`);
    return sessionRuntimeIdentityFromMetadataForOpen(meta.session, fallback);
  } catch (error) {
    // Non-fatal: runtime is used only for history-open analytics.
    console.warn(`[App] Failed to resolve runtime for session ${sessionId}, using fallback ${fallback}:`, error);
    return { runtime: fallback, runtimeSource: normalizeRuntimeSourceForOpen(fallback, undefined) };
  }
}

export interface LaunchProjectAnalyticsContext {
  surface?: Surface;
  entryIntent?: EntryIntent;
  assistantEntry?: AssistantEntry;
}

// ============================================================
// MemoizedTabContent — prevents re-rendering tabs whose props haven't changed.
// When switching tabs, only the newly active and previously active tabs re-render.
// ============================================================

interface TabContentProps {
  tab: Tab;
  isActive: boolean;
  isWindowFocused: boolean;
  isLoading: boolean;
  error: string | null;
  /**
   * When true, postpone the heavy view subtree. Non-Chat tabs render a cheap
   * placeholder; Chat tabs still mount their real TabProvider so Session/SSE/
   * owner lifecycle is live, but render only ChatBootOverlay until reveal.
   * Set for a freshly created tab so its full subtree (e.g. the Launcher:
   * BrandSection + SimpleChatInput + selectors) does NOT mount inside the
   * synchronous click commit —
   * that mount is what janked the "+" / Cmd+T action. Active-tab projection clears
   * the flag right after the placeholder paints (runAfterNextPaint), so React
   * mounts the real content in a prompt normal-priority commit off the click
   * frame. (NOT a low-priority transition — that gets starved by background
   * tabs' SSE/poll updates → 1-2s blank; see openNewTabDeferred.)
   */
  isDeferredMount: boolean;
  onLauncherWorkspaceSelectionChange: (tabId: string, workspacePath: string | null) => void;
  settingsInitialSection: string | undefined;
  capabilityInitialSection: CapabilitySection;
  capabilityNavigationNonce: number;
  capabilityInitialMcpId: string | undefined;
  capabilityInitialOfficialToolId: OfficialToolId | undefined;
  capabilityInitialSelect: CapabilityInitialSelect | undefined;
  // Launcher callbacks
  onLaunchProject: (project: Project, initialMessage?: InitialMessage, analyticsContext?: LaunchProjectAnalyticsContext, sessionBirthHint?: LaunchSessionBirthHint) => Promise<boolean>;
  // Chat callbacks
  onOpenHistorySession: (tabId: string, sessionId: string, title: string, historyEntrySource?: HistoryEntrySource) => Promise<void>;
  onNewSession: (tabId: string) => Promise<boolean>;
  onLaunchRuntimeBackedProviderSession: (
    project: Project,
    sessionBirthHint: LaunchSessionBirthHint & { providerExecutionIdentity: RuntimeBackedProviderIdentity },
    title: string,
  ) => Promise<string | null>;
  onUpdateGenerating: (tabId: string, isGenerating: boolean) => void;
  onUpdateTitle: (tabId: string, title: string) => void;
  onUpdateUnread: (tabId: string, hasUnread: boolean) => void;
  onRenameSession: (tabId: string, newTitle: string) => void;
  onForkSession: (tabId: string, newSessionId: string, agentDir: string, title: string, initialMessage?: string) => Promise<boolean>;
  onUpdateSessionId: (tabId: string, newSessionId: string, options?: AdoptMigratedSessionOptions) => Promise<boolean>;
  claimSessionOpeningTransition: (sessionId: string, ownerId: string) => (() => void) | null;
  onClearInitialMessage: (tabId: string) => void;
  onSidecarConfigAdopted: (tabId: string) => void;
  onFilePreviewIntentConsumed?: (tabId: string, intentId: string) => void;
  onSettingsSectionChange: () => void;
  updateReady: boolean;
  updateVersion: string | null;
  updateChecking: boolean;
  updateDownloading: boolean;
  updateInstalling: boolean;
  updatePreparing: boolean;
  onCheckForUpdate: () => Promise<'up-to-date' | 'downloading' | 'error'>;
  onRestartAndUpdate: () => void;
  sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
  // Task Center intent carried by the most recent OPEN_TASK_CENTER event.
  // Only read by the `taskcenter` tab; other tab views ignore it.
  taskCenterPendingIntent: { autofocusSearch?: boolean; nonce: number } | null;
  taskCenterCurrentSessionId?: string | null;
  taskPendingRoute?: PendingAppRoute | null;
  onTaskRouteConsumed?: (generation: number) => void;
  spacePendingRoute?: PendingAppRoute | null;
  onSpaceRouteConsumed?: (generation: number) => void;
}

// Exported for focused content-mount behavior tests.
export const MemoizedTabContent = memo(function TabContent({
  tab, isActive, isWindowFocused, isLoading, error, isDeferredMount,
  onLaunchProject, onOpenHistorySession, onNewSession, onLaunchRuntimeBackedProviderSession,
  onUpdateGenerating, onUpdateTitle, onUpdateUnread, onRenameSession, onForkSession, onUpdateSessionId, onClearInitialMessage,
  claimSessionOpeningTransition,
  onSidecarConfigAdopted, onFilePreviewIntentConsumed,
  onLauncherWorkspaceSelectionChange,
  settingsInitialSection,
  capabilityInitialSection,
  capabilityNavigationNonce,
  capabilityInitialMcpId,
  capabilityInitialOfficialToolId,
  capabilityInitialSelect,
  onSettingsSectionChange,
  updateReady,
  updateVersion,
  updateChecking,
  updateDownloading,
  updateInstalling,
  updatePreparing,
  onCheckForUpdate,
  onRestartAndUpdate,
  sessionNotificationBadgeCounts,
  taskCenterPendingIntent,
  taskCenterCurrentSessionId,
  taskPendingRoute,
  onTaskRouteConsumed,
  spacePendingRoute,
  onSpaceRouteConsumed,
}: TabContentProps) {
  const kind = tabContentKind(tab, isDeferredMount);
  const handleLauncherWorkspaceChange = useCallback(
    (workspacePath: string | null) => onLauncherWorkspaceSelectionChange(tab.id, workspacePath),
    [onLauncherWorkspaceSelectionChange, tab.id],
  );
  const claimTabSessionOpeningTransition = useCallback(
    (sessionId: string) => claimSessionOpeningTransition(sessionId, tab.id),
    [claimSessionOpeningTransition, tab.id],
  );
  return (
    <div
      className={`absolute inset-0 ${isActive ? '' : 'pointer-events-none invisible'}`}
      style={isActive ? undefined : { contentVisibility: 'hidden' }}
    >
      {kind === 'deferred' ? (
        // One-frame placeholder: paper-colored fill so the just-activated
        // tab paints instantly with no flash, while the real subtree mounts
        // on the next normal-priority commit (runAfterNextPaint; see
        // openNewTabDeferred).
        <div className="h-full w-full bg-[var(--paper)]" />
      ) : kind === 'launcher' ? (
        <Launcher
          onLaunchProject={onLaunchProject}
          isStarting={isLoading}
          startError={error}
          isActive={isActive}
          attachmentSessionId={createPendingSessionId(tab.id)}
          selectedWorkspacePath={tab.launcherWorkspacePath}
          onWorkspaceSelectionChange={handleLauncherWorkspaceChange}
        />
      ) : kind === 'settings' || kind === 'capabilities' ? (
        <Suspense fallback={PAGE_FALLBACK}>
          <Settings
            mode={kind}
            initialSection={kind === 'capabilities' ? capabilityInitialSection : (settingsInitialSection ?? 'providers')}
            navigationNonce={kind === 'capabilities' ? capabilityNavigationNonce : undefined}
            initialMcpId={kind === 'capabilities' ? capabilityInitialMcpId : undefined}
            initialOfficialToolId={kind === 'capabilities' ? capabilityInitialOfficialToolId : undefined}
            initialSelect={kind === 'capabilities' ? capabilityInitialSelect : undefined}
            onSectionChange={onSettingsSectionChange}
            isActive={isActive}
            updateReady={updateReady}
            updateVersion={updateVersion}
            updateChecking={updateChecking}
            updateDownloading={updateDownloading}
            updateInstalling={updateInstalling}
            updatePreparing={updatePreparing}
            onCheckForUpdate={onCheckForUpdate}
            onRestartAndUpdate={onRestartAndUpdate}
          />
        </Suspense>
      ) : kind === 'taskcenter' ? (
        <Suspense fallback={PAGE_FALLBACK}>
          <TaskCenter
            isActive={isActive}
            pendingIntent={taskCenterPendingIntent}
            currentSessionId={taskCenterCurrentSessionId}
            pendingRoute={taskPendingRoute ?? null}
            onRouteConsumed={onTaskRouteConsumed}
          />
        </Suspense>
      ) : kind === 'space' ? (
        <Suspense fallback={PAGE_FALLBACK}>
          <Space
            isActive={isActive}
            pendingRoute={spacePendingRoute ?? null}
            onRouteConsumed={onSpaceRouteConsumed}
          />
        </Suspense>
      ) : (
        <TabProvider
          tabId={tab.id}
          agentDir={tab.agentDir ?? ''}
          sessionId={tab.sessionId}
          sessionTitle={tab.title}
          isActive={isActive}
          onGeneratingChange={(isGenerating) => onUpdateGenerating(tab.id, isGenerating)}
          onTitleChange={(title) => onUpdateTitle(tab.id, title)}
          onUnreadChange={(hasUnread) => onUpdateUnread(tab.id, hasUnread)}
          onSessionIdChange={(newSessionId, options) => onUpdateSessionId(tab.id, newSessionId, options)}
          claimSessionOpeningTransition={claimTabSessionOpeningTransition}
        >
          {kind === 'deferred-chat' ? (
            <ChatBootOverlay />
          ) : (
            <Suspense fallback={<ChatBootOverlay />}>
              <Chat
                isWindowFocused={isWindowFocused}
                onOpenSession={(sessionId, title, historyEntrySource) => onOpenHistorySession(tab.id, sessionId, title, historyEntrySource)}
                onOpenSessionInNewTab={(sessionId, title) => onOpenHistorySession(tab.id, sessionId, title, 'chat_dropdown_new_tab')}
                onNewSession={() => onNewSession(tab.id)}
                onLaunchRuntimeBackedProviderSession={onLaunchRuntimeBackedProviderSession}
                initialMessage={tab.initialMessage}
                onInitialMessageConsumed={() => onClearInitialMessage(tab.id)}
                sidecarConfigDisposition={tab.sidecarConfigDisposition}
                onSidecarConfigAdopted={() => onSidecarConfigAdopted(tab.id)}
                pendingFilePreview={tab.pendingFilePreview}
                onFilePreviewIntentConsumed={(intentId) => onFilePreviewIntentConsumed?.(tab.id, intentId)}
                sessionTitle={tab.title}
                onRenameSession={(newTitle: string) => onRenameSession(tab.id, newTitle)}
                onForkSession={(newSessionId: string, agentDir: string, title: string, initialMessage?: string) => onForkSession(tab.id, newSessionId, agentDir, title, initialMessage)}
                sessionNotificationBadgeCounts={sessionNotificationBadgeCounts}
              />
            </Suspense>
          )}
        </TabProvider>
      )}
    </div>
  );
}, (prev, next) => {
  // Return true = skip re-render
  // All callbacks are stable (via tabsRef/activeTabIdRef), so we only compare data props
  return (
    prev.tab === next.tab &&
    prev.isActive === next.isActive &&
    // Desktop focus only affects the active Chat's geometry boundary. Keep
    // inactive heavy Tab subtrees out of every app-switch render.
    (next.tab.view !== 'chat' || !next.isActive || prev.isWindowFocused === next.isWindowFocused) &&
    prev.isLoading === next.isLoading &&
    prev.error === next.error &&
    // Drives the deferred-mount → real-content transition for new tabs.
    prev.isDeferredMount === next.isDeferredMount &&
    prev.settingsInitialSection === next.settingsInitialSection &&
    prev.capabilityInitialSection === next.capabilityInitialSection &&
    prev.capabilityNavigationNonce === next.capabilityNavigationNonce &&
    prev.capabilityInitialMcpId === next.capabilityInitialMcpId &&
    prev.capabilityInitialOfficialToolId === next.capabilityInitialOfficialToolId &&
    prev.capabilityInitialSelect === next.capabilityInitialSelect &&
    prev.updateReady === next.updateReady &&
    prev.updateVersion === next.updateVersion &&
    prev.updateChecking === next.updateChecking &&
    prev.updateDownloading === next.updateDownloading &&
    prev.updateInstalling === next.updateInstalling &&
    prev.updatePreparing === next.updatePreparing &&
    prev.sessionNotificationBadgeCounts === next.sessionNotificationBadgeCounts &&
    // Reference equality — each OPEN_TASK_CENTER dispatch allocates a
    // fresh intent object (or `null`), so identity comparison is enough.
    // Without this line, a user re-clicking the Launcher's search icon
    // while Task Center is already active would see their new intent
    // dropped: isActive stays true, tab ref stays the same, so memo
    // returns true and the new `pendingIntent` prop never reaches the
    // TaskCenter tab. (v0.1.69 cross-review C1)
    prev.taskCenterPendingIntent === next.taskCenterPendingIntent &&
    prev.taskCenterCurrentSessionId === next.taskCenterCurrentSessionId &&
    prev.spacePendingRoute === next.spacePendingRoute
  );
});

export default function App() {
  const { t } = useTranslation('app');
  // Auto-update state (silent background updates)
  const { updateReady, updateVersion, restartAndUpdate, checking: updateChecking, downloading: updateDownloading, installing: updateInstalling, preparing: updatePreparing, checkForUpdate, pendingUpdateOnStartup, dismissPendingUpdate } = useUpdater();

  // Stable callback for Settings prop — ref pattern ensures memo comparator correctness
  const restartAndUpdateRef = useRef(restartAndUpdate);
  restartAndUpdateRef.current = restartAndUpdate;

  // handleRestartAndUpdate is defined further down (after toastRef is declared)
  // — see the `// Update install handler` block.

  // App config for tray behavior (shared via ConfigProvider — no CONFIG_CHANGED event needed)
  // Also get projects + CRUD actions for bug report (ensureSelfAwarenessWorkspace needs them)
  const { config, isLoading: configLoading, providers: appProviders, apiKeys: appApiKeys, providerVerifyStatus: appProviderVerifyStatus, projects: configProjects, addProject: configAddProject, patchProject: configPatchProject } = useConfig();
  const spaceBuildCapability = useSpaceBuildCapability(config.spaceEnvironment);
  const teamSpaceAvailable = spaceBuildCapability.available && config.teamSpaceEnabled === true;
  const [isWindowFocused, setIsWindowFocused] = useState(isRendererForegrounded);

  // Helper Agent's persisted model defaults — used by BugReportOverlay for
  // initial picker selection + persist on pick. The LAUNCH_BUG_REPORT handler
  // intentionally does NOT read this: when no explicit hint is supplied, the
  // helper Tab autoSend resolves provider/model via currentAgent (= helper
  // Agent) — same path as opening ~/.myagents from the Launcher.
  const helperAgentDefaults = useHelperAgentModelDefaults();

  // Settings initial section state (for deep linking to specific section)
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>(undefined);
  const [capabilityInitialMcpId, setCapabilityInitialMcpId] = useState<string | undefined>(undefined);
  const [capabilityInitialOfficialToolId, setCapabilityInitialOfficialToolId] = useState<OfficialToolId | undefined>(undefined);
  const [capabilityInitialSelect, setCapabilityInitialSelect] = useState<CapabilityInitialSelect | undefined>(undefined);
  const [capabilityInitialSection, setCapabilityInitialSection] = useState<CapabilitySection>('skills');
  const [capabilityNavigationNonce, setCapabilityNavigationNonce] = useState(0);

  // Bug report overlay state (triggered from titlebar feedback button)
  const [showBugReport, setShowBugReport] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    if (isTauriEnvironment()) {
      import('@tauri-apps/api/app').then(m => m.getVersion()).then(setAppVersion).catch(() => setAppVersion('unknown'));
    } else {
      setAppVersion('dev');
    }
  }, []);

  // Multi-tab state.
  //
  // Startup behaviour (Issue #309): boot is ALWAYS a clean new launcher — we no
  // longer auto-restore the previous session. Restoring is opt-in via the
  // title-bar "恢复对话" pill, surfaced only when the last exit was NOT a
  // deliberate quit (i.e. a crash or an update-restart — see the boot-decision
  // effect below). `buildRestoredTabs()` still runs synchronously here to
  // CAPTURE the prior session's restorable tabs BEFORE the post-commit persist
  // effect overwrites localStorage with this fresh launcher; the captured set
  // becomes the pill's restore candidate. Those Tabs are not mounted until the
  // user accepts the pill; the click path validates them before committing the
  // final live Chat projection.
  const [restoreCandidate] = useState(() => buildRestoredTabs());
  const [tabs, setTabs] = useState<Tab[]>(() => [createNewTab()]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(() => tabs[0]?.id ?? null);
  const [externalNotificationBadges, setExternalNotificationBadges] = useState<NotificationBadgeItem[]>([]);
  const [spacePendingRoute, setSpacePendingRoute] = useState<PendingAppRoute | null>(null);
  const [taskPendingRoute, setTaskPendingRoute] = useState<PendingAppRoute | null>(null);
  const appRouteGenerationRef = useRef(0);
  const spaceRouteTabIdRef = useRef<string | null>(null);

  // "恢复对话" pill (Issue #309). `restorePillCount > 0` shows it; the resolved
  // candidate is held in a ref (NOT localStorage — the persist effect clears
  // that on the fresh boot) so the user can still restore after starting work.
  const restoreCandidateRef = useRef<{ tabs: Tab[]; activeTabId: string | null } | null>(null);
  const [restorePillCount, setRestorePillCount] = useState(0);

  // Refs for stable callback access (avoids re-creating callbacks when tabs/activeTabId change)
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const handleLauncherWorkspaceSelectionChange = useCallback((tabId: string, workspacePath: string | null) => {
    setTabs((current) => current.map((tab) => (
      tab.id === tabId && tab.view === 'launcher' && tab.launcherWorkspacePath !== workspacePath
        ? { ...tab, launcherWorkspacePath: workspacePath }
        : tab
    )));
  }, []);

  const syncRendererCorrelationForTab = useCallback((tabId: string | null | undefined, nextTabs: readonly Tab[] = tabsRef.current) => {
    const activeTab = tabId ? nextTabs.find((t) => t.id === tabId) : undefined;
    setAppActiveTabId(tabId, nextTabs.map((t) => t.id));
    setAppActiveCorrelation({
      tabId,
      sessionId: activeTab?.sessionId ?? undefined,
      tabs: nextTabs.map((t) => ({ id: t.id, sessionId: t.sessionId })),
    });
  }, []);

  // Deferred-view set. Non-Chat tabs in this set render a cheap placeholder;
  // Chat tabs keep their live TabProvider but postpone the heavy Chat child.
  // Activation is the single reveal owner: every entry path (mouse, keyboard,
  // close fallback, history jump) gets the same post-paint behavior.
  const [deferredMountTabIds, setDeferredMountTabIds] = useState<Set<string>>(() => new Set());
  const revealDeferredActiveTabAfterPaint = useCallback((tabId: string | null) => {
    if (!tabId) return;
    runAfterNextPaint(() => {
      if (activeTabIdRef.current !== tabId) return;
      setDeferredMountTabIds((prev) => {
        if (!prev.has(tabId)) return prev;
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
    });
  }, []);

  const setActiveTabId = useCallback((
    next: string | null | ((current: string | null) => string | null),
    nextTabs: readonly Tab[] = tabsRef.current,
  ) => {
    if (typeof next === 'function') {
      setActiveTabIdState((current) => {
        const resolved = next(current);
        activeTabIdRef.current = resolved;
        syncRendererCorrelationForTab(resolved, nextTabs);
        revealDeferredActiveTabAfterPaint(resolved);
        return resolved;
      });
      return;
    }
    activeTabIdRef.current = next;
    syncRendererCorrelationForTab(next, nextTabs);
    setActiveTabIdState(next);
    revealDeferredActiveTabAfterPaint(next);
  }, [revealDeferredActiveTabAfterPaint, syncRendererCorrelationForTab]);

  useEffect(() => {
    if (configLoading || spaceBuildCapability.isLoading) return;
    const currentTabs = tabsRef.current;
    const routeTabId = spaceRouteTabIdRef.current;
    if (routeTabId && !currentTabs.some((tab) => tab.id === routeTabId && tab.view === 'space')) {
      spaceRouteTabIdRef.current = null;
    }
    if (
      spaceBuildCapability.available
      && (teamSpaceAvailable || currentTabs.some((tab) => tab.id === routeTabId && tab.view === 'space'))
    ) return;

    if (!currentTabs.some((tab) => tab.view === 'space')) return;

    const remainingTabs = currentTabs.filter((tab) => tab.view !== 'space');
    const nextTabs = remainingTabs.length > 0 ? remainingTabs : [createNewTab()];
    const currentActiveId = activeTabIdRef.current;
    const nextActiveId = nextTabs.some((tab) => tab.id === currentActiveId)
      ? currentActiveId
      : nextTabs[nextTabs.length - 1]?.id ?? null;

    setTabs(nextTabs);
    setActiveTabId(nextActiveId, nextTabs);
  }, [configLoading, spaceBuildCapability.available, spaceBuildCapability.isLoading, teamSpaceAvailable, setActiveTabId]);

  // Persist open chat tabs after every structural change (Issue #232). This is
  // a POST-COMMIT effect — it flushes shortly after each tabs/activeTabId change
  // (not synchronously inside the mutation). The payload is tiny (≤MAX_TABS × 4
  // fields), and we deliberately avoid `beforeunload` (unreliable in Tauri
  // WKWebView; update install + app quit both exit from the Rust side, not a
  // renderer unload handshake — see the hide/quit flush below and
  // handleRestartAndUpdate).
  useEffect(() => {
    saveOpenTabs(tabs, activeTabId);
  }, [tabs, activeTabId]);

  // Synchronous flush of the latest tab state. Used to close the narrow window
  // where the process exits (update relaunch, Cmd+Q / Dock quit) in the same
  // frame as a structural change, before the post-commit effect above runs.
  const flushOpenTabsNow = useCallback(() => {
    saveOpenTabs(tabsRef.current, activeTabIdRef.current);
  }, []);

  // Flush on window hide / pagehide — the Tauri-appropriate quit signal (the
  // analytics tracker uses the same visibilitychange→hidden hook; beforeunload
  // is unreliable here). Covers Cmd+Q / Dock-quit so a tab closed immediately
  // before quitting doesn't resurrect on next launch.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushOpenTabsNow();
    };
    const onPageHide = () => flushOpenTabsNow();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [flushOpenTabsNow]);

  // Boot startup-behaviour decision (Issue #309). Boot already rendered a fresh
  // launcher (no auto-restore); here we decide whether to OFFER restoring the
  // previous session via the title-bar pill, by the EXIT REASON:
  //   - Resolve the snapshot: the synchronous localStorage capture
  //     (restoreCandidate) wins; the fsync durable backstop — written by
  //     handleRestartAndUpdate right before the abrupt update-restart, where the
  //     async WebView localStorage flush can be lost — fills in when the local
  //     read came up EMPTY (pickDurableOverride).
  //   - Read the Rust clean-exit marker: PRESENT means the user deliberately
  //     quit (Cmd+Q / Dock / tray) → boot fresh, no pill. ABSENT means a crash
  //     or an update-restart → offer to restore (preserves the #232 intent as an
  //     opt-in, kills the #309 "stop force-restoring my session" complaint).
  // Single-shot under StrictMode via the ref; loadAndClearOpenTabsDurable +
  // consumeCleanExitMarker both delete on read, so a second pass is a no-op.
  const bootDecisionRef = useRef(false);
  useEffect(() => {
    if (bootDecisionRef.current) return;
    bootDecisionRef.current = true;
    void (async () => {
      const durable = await loadAndClearOpenTabsDurable();
      const override = pickDurableOverride(restoreCandidate != null, durable);
      const candidate = override ? hydratePersistedState(override) : restoreCandidate;
      const lastExitWasClean = await consumeCleanExitMarker();
      if (candidate && shouldOfferRestore(lastExitWasClean, candidate.tabs.length)) {
        restoreCandidateRef.current = candidate;
        setRestorePillCount(candidate.tabs.length);
      }
    })();
  }, [restoreCandidate]);

  // ✕ on the pill — dismiss without restoring (don't nag again this session).
  const handleDismissRestore = useCallback(() => {
    setRestorePillCount(0);
    restoreCandidateRef.current = null;
  }, []);

  // Single source of truth for opening a NEW tab whose view mounts a large
  // renderer-only subtree (Launcher / Settings / TaskCenter). It appends and
  // activates the tab in the urgent commit — so the chip + active highlight
  // paint instantly with only a cheap placeholder as content — then clears the
  // deferral once the placeholder has painted, letting React mount the heavy
  // subtree. This keeps the open action from janking the click frame regardless
  // of how heavy the view is (e.g. the 5.8k-line Settings tree).
  //
  // WHY runAfterNextPaint and NOT startTransition (the "新建 tab 黄屏" fix):
  // the reveal used to live inside a useTransition, i.e. at LOW priority. Every
  // still-mounted background Tab keeps firing NORMAL-priority state updates
  // (SSE token deltas, session-state polling, task notifications); a
  // low-priority transition gets repeatedly interrupted/restarted by that churn
  // and could stay pending for 1-2s, leaving the full-screen paper placeholder
  // on screen the whole time. A normal-priority commit scheduled right after
  // the placeholder paints is not starvable and reveals the content promptly —
  // the click already got its feedback from the placeholder, so the one-shot
  // mount runs off the click frame. See utils/afterPaint.ts for the double-rAF
  // rationale.
  //
  // Normal Chat/session opens are never added to this deferred set: they commit
  // the Chat owner subtree with its real Session identity immediately. Bulk
  // restore is the deliberate exception and keeps TabProvider live underneath
  // the lightweight boot surface.
  const openNewTabDeferred = useCallback((newTab: Tab) => {
    perfMark(RENDERER_PERF_PHASE.newTabReveal, { tabId: newTab.id }); // P0: new-tab timeline anchor
    const nextTabs = [...tabsRef.current, newTab];
    setDeferredMountTabIds((prev) => {
      if (prev.has(newTab.id)) return prev;
      const next = new Set(prev);
      next.add(newTab.id);
      return next;
    });
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id, nextTabs);
  }, [setActiveTabId]);

  // Helper-overlay launches must hand `handleLaunchProject` a real, committed
  // active launcher tab. Mutating activeTabIdRef before React has committed the
  // tab produces `view=undefined` and can let the new Chat auto-send while hidden.
  const openLaunchTabNow = useCallback((newTab: Tab) => {
    const nextTabs = [...tabsRef.current, newTab];
    flushSync(() => {
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id, nextTabs);
    });
  }, [setActiveTabId]);

  const removeUnusedPrecreatedLaunchTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const created = prev.find(t => t.id === tabId);
      if (created && !created.sessionId && !created.agentDir) {
        return prev.filter(t => t.id !== tabId);
      }
      return prev;
    });
  }, []);

  // Analytics Active Context — propagate active tab's sessionId/tabId so that
  // downstream track() calls auto-inject these into params (see analytics/tracker.ts).
  // Pending session ids (createPendingSessionId placeholders) are filtered out:
  // they're per-tab UI scaffolding, not the real SDK session id, and would not
  // join with session_new in the analytics pipeline.
  useEffect(() => {
    if (!activeTabId) {
      clearAnalyticsContext();
      return;
    }
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const sid = activeTab?.sessionId ?? null;
    setAnalyticsContext({
      tabId: activeTabId,
      sessionId: sid && !isPendingSessionId(sid) ? sid : null,
    });
  }, [activeTabId, tabs]);

  // Renderer correlation must follow the App-level active tab, not only mounted
  // Chat TabProviders. Launcher / Settings / TaskCenter do not mount a
  // TabProvider, but logs and proxy headers still need their tab id instead of
  // inheriting the previously-focused chat tab.
  useEffect(() => {
    syncRendererCorrelationForTab(activeTabId, tabs);
  }, [activeTabId, tabs, syncRendererCorrelationForTab]);

  // PRD 0.2.19 cross-review fix: prewarm agent_hash cache when config.agents
  // loads/changes, so the first `workspace_open` / `session_new` for each agent
  // already has agent_hash populated. Without this, `hashAgentNameSync` returns
  // null on first call (computes async + caches), creating a small tail of
  // null-hash events. Prewarm reduces the tail to near zero.
  useEffect(() => {
    const agents = config?.agents ?? [];
    for (const a of agents) {
      if (a.name) void hashAgentName(a.name);
    }
  }, [config]);

  const appProvidersRef = useRef(appProviders);
  appProvidersRef.current = appProviders;

  const appApiKeysRef = useRef(appApiKeys);
  appApiKeysRef.current = appApiKeys;

  const appProviderVerifyStatusRef = useRef(appProviderVerifyStatus);
  appProviderVerifyStatusRef.current = appProviderVerifyStatus;

  const configProjectsRef = useRef(configProjects);
  configProjectsRef.current = configProjects;

  // Stable render mirror for async App flows that need the latest config.
  const configRef = useRef(config);
  configRef.current = config;

  const unreadTabCount = tabs.reduce((count, tab) => count + (tab.hasUnread ? 1 : 0), 0);
  const externalNotificationBadgeCount = countNotificationBadgeItems(externalNotificationBadges);
  const sessionNotificationBadgeCounts = useMemo(
    () => buildSessionNotificationBadgeCounts(externalNotificationBadges),
    [externalNotificationBadges],
  );
  const notificationBadgeEnabled = config.osNotifications && (config.notificationBadge ?? false);
  const notificationBadgeCount = notificationBadgeEnabled
    ? Math.min(unreadTabCount + externalNotificationBadgeCount, 999)
    : 0;

  useEffect(() => {
    if (!notificationBadgeEnabled && externalNotificationBadges.length !== 0) {
      setExternalNotificationBadges([]);
    }
  }, [externalNotificationBadges.length, notificationBadgeEnabled]);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('cmd_set_notification_badge', {
        count: notificationBadgeCount,
        enabled: notificationBadgeEnabled,
      }))
      .catch((error) => {
        console.warn('[App] Failed to sync notification badge:', error);
      });
  }, [notificationBadgeCount, notificationBadgeEnabled]);

  const resolveSessionOriginFieldsForAnalytics = useCallback(async (sessionId: string, agentDir: string) => {
    try {
      const sessions = await getSessions(agentDir);
      const target = sessions.find((session) => session.id === sessionId);
      return originAnalyticsFields(originFromSessionMetadataLike(target));
    } catch (error) {
      console.warn(`[App] Failed to resolve session origin for ${sessionId}:`, error);
      return originAnalyticsFields(null);
    }
  }, []);

  const trackHistorySessionOpenAsync = useCallback((
    sessionId: string,
    agentDir: string,
    entrySource: HistoryEntrySource,
  ) => {
    void (async () => {
      const cfg = configRef.current;
      const agent = getProjectAgent(cfg, configProjects, agentDir);
      const runtimeIdentity = await resolveSessionRuntimeIdentityForOpen(
        sessionId,
        normalizeRuntime(agent?.runtime),
        cfg?.multiAgentRuntime,
      );
      const originFields = await resolveSessionOriginFieldsForAnalytics(sessionId, agentDir);
      track('history_open', {
        agent_hash: hashAgentNameSync(agent?.name ?? null),
        runtime: runtimeIdentity.runtime,
        runtime_source: analyticsRuntimeSource(runtimeIdentity.runtime, runtimeIdentity.runtimeSource),
        session_id: sessionId,
        entry_source: entrySource,
        ...originFields,
      });
    })().catch((error) => {
      console.warn(`[App] Failed to track history_open for session ${sessionId}:`, error);
    });
  }, [configProjects, resolveSessionOriginFieldsForAnalytics]);

  // Toast (ref-stabilized per CLAUDE.md rules)
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Update install handler — toasts on failure so the user sees their click
  // had an effect. Silent failure here was the root cause of "重启更新 button
  // does nothing" reports on Windows: a flaky network would kill the install
  // verification round-trip, the JS only console.warn-ed, and the user
  // assumed the button was broken.
  const handleRestartAndUpdate = useCallback(async () => {
    // Persist open-tab state before the install/relaunch exits the process from
    // Rust (Issue #232). flushOpenTabsNow() writes localStorage (the fast path),
    // but WebKit/WebView2 persist localStorage to disk ASYNCHRONOUSLY, so the
    // abrupt NSIS exit(0) (Windows) / relaunch() (macOS) can drop that last
    // write. persistOpenTabsDurable() additionally fsyncs a ~/.myagents/
    // open-tabs.json backstop and is AWAITED here, so the tabs the user had
    // open at the click are committed to disk before the process dies; boot
    // consumes the backstop and adopts it only if localStorage came up empty.
    flushOpenTabsNow();
    await persistOpenTabsDurable(tabsRef.current, activeTabIdRef.current);
    let outcome: Awaited<ReturnType<typeof restartAndUpdateRef.current>> | undefined;
    try {
      outcome = await restartAndUpdateRef.current();
    } finally {
      // Drop the durable handoff UNLESS the restart is actually proceeding
      // (outcome 'ok' → the process is exiting and boot will consume it). Any
      // non-'ok' outcome OR a thrown error means the process stays alive, so the
      // backstop we wrote just before must not resurrect this now-frozen snapshot
      // on a later boot. Awaited (not fire-and-forget) so it can't race a retry's
      // fresh persist, and placed in `finally` so an uncaught throw still clears.
      if (outcome !== 'ok') {
        await clearOpenTabsDurable();
      }
    }
    if (outcome === 'network-error') {
      toastRef.current?.error(t('appChrome.updateVerifyFailed'));
    } else if (outcome === 'version-mismatch') {
      toastRef.current?.info(t('appChrome.updateExpiredRedownloading'));
    } else if (outcome === 'blocked') {
      toastRef.current?.info(t('appChrome.updateInstallBlocked'));
    } else if (outcome === 'error') {
      toastRef.current?.error(t('appChrome.updateInstallFailed'));
    }
    // 'ok' → process is exiting via NSIS/relaunch, no toast needed
  }, [flushOpenTabsNow, t]);

  // Per-tab loading state (keyed by tabId)
  const [loadingTabs, setLoadingTabs] = useState<Record<string, boolean>>({});
  const [tabErrors, setTabErrors] = useState<Record<string, string | null>>({});

  // Exit confirmation state (for cron tasks)
  const [exitConfirmState, setExitConfirmState] = useState<{
    runningTaskCount: number;
    resolve: (value: boolean) => void;
  } | null>(null);

  // Content container ref for tab swipe gesture
  const contentRef = useRef<HTMLDivElement>(null);

  // Per-tab launch guard — prevents concurrent launches overwriting each other's state
  const launchingTabRef = useRef<string | null>(null);

  // Global Sidecar silent retry mechanism
  const mountedRef = useRef(true);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  // Silent background retry with exponential backoff
  const startGlobalSidecarSilent = useCallback(async () => {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 2000; // 2 seconds

    try {
      // NOTE: Do NOT reset the ready promise on retry.
      // Existing waiters (useTaskCenterData etc.) hold a reference to the original promise.
      // Resetting it would orphan those waiters — they'd wait for a dead promise until
      // the 60s timeout expires, even if the sidecar is already running.
      // Keep the original promise; markGlobalSidecarReady() resolves it for ALL waiters.

      await startGlobalSidecar();

      if (!mountedRef.current) return;

      markGlobalSidecarReady();
      retryCountRef.current = 0; // Reset on success

      setLogServerReady();
      console.log('[App] Global sidecar started; unified log sink ready');
    } catch (error) {
      if (!mountedRef.current) return;

      retryCountRef.current += 1;
      const currentRetry = retryCountRef.current;

      if (currentRetry <= MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        const delay = BASE_DELAY * Math.pow(2, currentRetry - 1);
        console.log(`[App] Global sidecar failed, retry ${currentRetry}/${MAX_RETRIES} in ${delay}ms`);

        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            void startGlobalSidecarSilent();
          }
        }, delay);
      } else {
        // Max retries reached, mark as ready to unblock waiting components
        markGlobalSidecarReady();
        console.error('[App] Global sidecar failed after max retries:', error);
      }
    }
  }, []);

  // 方案 A: Rust 统一恢复 - 前端不再主动恢复，只监听事件
  // Rust 层 initialize_cron_manager 会自动恢复所有 running 状态的任务

  // app_launch (DAU) — fire exactly once, but only AFTER config finishes loading
  // from disk. Gating on `!configLoading` makes the runtimes_active adoption
  // snapshot accurate: DEFAULT_CONFIG has no `agents` key, so a genuine no-agents
  // user would otherwise be indistinguishable from "config not loaded yet"
  // (cross-review W1). isLoading always reaches false (ConfigProvider sets it in
  // a finally), so this is DAU-safe — app_launch will always fire. initAnalytics
  // is idempotent, so awaiting it here just guarantees device_id/version preload.
  const appLaunchTrackedRef = useRef(false);
  useEffect(() => {
    if (appLaunchTrackedRef.current || configLoading) return;
    appLaunchTrackedRef.current = true;
    void initAnalytics().then(() => {
      const cfg = configRef.current;
      // distinct effective external runtimes the user has configured agents for.
      // gate-aware → '' when multiAgentRuntime is off; '' (not omitted) for a
      // loaded-but-no-agents user. Captures "configured but maybe never used"
      // runtimes that turn-level events (ai_turn_complete) can't see.
      const runtimesActive = Array.from(new Set(
        (cfg.agents ?? [])
          .map((a) => resolveEffectiveRuntime(a.runtime, !!cfg.multiAgentRuntime))
          .filter((r) => r !== 'builtin'),
      )).sort().join(',');
      track('app_launch', { launch_type: 'cold', runtimes_active: runtimesActive });
    });
  }, [configLoading]);

  // Start Global Sidecar on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    retryCountRef.current = 0;

    // Initialize analytics (async, non-blocking). app_launch itself is tracked
    // in a dedicated config-loaded effect (see above) so its runtimes_active
    // adoption snapshot reflects the real on-disk agent set, not DEFAULT_CONFIG.
    void initAnalytics();

    // Initialize the ready promise BEFORE starting the sidecar
    // This allows other components to wait for it
    initGlobalSidecarReadyPromise();

    // Start Global Sidecar immediately on app launch
    // This ensures MCP and other global API calls work from any page
    void startGlobalSidecarSilent();

    // NOTE: Bundled workspace (mino) initialization is handled by
    // ensureBundledWorkspace() inside ConfigProvider.load(), which runs
    // before loadProjects() to eliminate race conditions.

    // 方案 A: Rust 统一恢复 - 监听恢复事件（仅用于日志和 UI 反馈）
    // Rust 层会自动恢复任务，前端只需要监听结果
    const listenerAc = new AbortController();

    if (isTauriEnvironment()) {
      // Listen for background session completion events
      void listenWithCleanup<{ sessionId: string; sidecarStopped: boolean }>(
        'session:background-complete',
        (event) => {
          if (!mountedRef.current) return;
          const { sessionId, sidecarStopped } = event.payload;
          console.log(`[App] Background session completion finished: session=${sessionId}, sidecarStopped=${sidecarStopped}`);

          setTabs(prev => prev.map(tab =>
            tab.sessionId === sessionId && tab.isGenerating
              ? { ...tab, isGenerating: false }
              : tab
          ));

          const matchingTab = tabsRef.current.find(tab => tab.sessionId === sessionId && tab.agentDir);
          if (matchingTab?.agentDir) {
            getSessions(matchingTab.agentDir)
              .then((sessions) => {
                if (!mountedRef.current) return;
                const refreshed = sessions.find(session => session.id === sessionId);
                if (!refreshed) return;
                const refreshedTitle = getSessionDisplayText(refreshed);
                setTabs(prev => prev.map(tab =>
                  tab.sessionId === sessionId && tab.title !== refreshedTitle
                    ? { ...tab, title: refreshedTitle }
                    : tab
                ));
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED));
              })
              .catch(err => console.warn('[App] Failed to refresh background-completed session metadata:', err));
          }
        },
        listenerAc.signal,
      );

      // Floating ball "展开 ↗" (PRD 0.2.35): Rust raises the main window and
      // emits this; re-dispatch onto the existing OPEN_SESSION_IN_NEW_TAB
      // DOM-event path so the companion's session opens via the same
      // cron-aware plan→spawn flow as the task center.
      void listenWithCleanup<{
        sessionId: string;
        workspacePath: string;
        preview?: { path?: string; initialLineNumber?: number };
      }>(
        'fb:open-session',
        (event) => {
          if (!mountedRef.current) return;
          const { sessionId, workspacePath, preview } = event.payload ?? {};
          if (!sessionId || !workspacePath) return;
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
              detail: { sessionId, workspacePath, preview },
            }),
          );
        },
        listenerAc.signal,
      );

      void listenWithCleanup(
        'fb:open-desktop-pet-settings',
        () => {
          if (!mountedRef.current) return;
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
              detail: { section: 'desktop-pet' },
            }),
          );
        },
        listenerAc.signal,
      );

      // Listen for individual task recovered events
      void listenWithCleanup<CronTaskRecoveredPayload>(
        CRON_EVENTS.TASK_RECOVERED,
        (event) => {
          if (!mountedRef.current) return;
          const { taskId, sessionId, port } = event.payload;
          console.log(`[App] Cron task recovered: ${taskId} (session: ${sessionId}, port: ${port})`);
        },
        listenerAc.signal,
      );

      // Listen for recovery summary event
      void listenWithCleanup<CronRecoverySummaryPayload>(
        CRON_EVENTS.RECOVERY_SUMMARY,
        (event) => {
          if (!mountedRef.current) return;
          const { totalTasks, recoveredCount, failedCount, failedTasks } = event.payload;
          if (totalTasks > 0) {
            console.log(
              `[App] Cron recovery summary: ${recoveredCount}/${totalTasks} recovered, ${failedCount} failed`
            );
            if (failedTasks.length > 0) {
              console.warn('[App] Failed tasks:', failedTasks);
            }
            track('cron_recover', {
              recovered_count: recoveredCount,
              failed_count: failedCount,
            });
          }
        },
        listenerAc.signal,
      );

      // Listen for manager ready event (indicates recovery is complete)
      void listenWithCleanup(CRON_EVENTS.MANAGER_READY, () => {
        if (!mountedRef.current) return;
        console.log('[App] Cron manager ready (Rust recovery complete)');
      }, listenerAc.signal);

      void listenWithCleanup<NotificationBadgeIncrementPayload>('notification:badge-increment', (event) => {
        if (!mountedRef.current) return;
        const cfg = configRef.current;
        if (!cfg.osNotifications || !(cfg.notificationBadge ?? false)) return;
        const createdAt = Date.now();
        const fallbackId = `legacy:${createdAt}:${Math.random().toString(36).slice(2, 8)}`;
        const item = normalizeNotificationBadgeIncrementPayload(
          event.payload,
          fallbackId,
          createdAt,
        );
        if (!item) return;
        const activeTab = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
        if (isRendererForegrounded() && isNotificationBadgeTargetVisible(item.target, activeTab)) {
          return;
        }
        setExternalNotificationBadges((items) => upsertNotificationBadgeItem(items, item));
      }, listenerAc.signal);

      // Listen for Global Sidecar auto-restart by Rust health monitor
      void listenWithCleanup<string>('global-sidecar:restarted', () => {
        if (!mountedRef.current) return;
        console.log('[App] Global sidecar auto-restarted by health monitor');
        setLogServerReady();
        // Safety net: if the initial startGlobalSidecar() invoke is still blocked
        // (e.g., monitor killed the first sidecar during its TCP health check),
        // the ready promise would never resolve. Resolve it here so that components
        // waiting on waitForGlobalSidecar() can proceed with the new sidecar. (#58)
        markGlobalSidecarReady();
      }, listenerAc.signal);

      // session:sidecar-terminal — emitted by Rust ONLY when a Session
      // Sidecar is removed with no remaining owners (so the health monitor
      // will not auto-restart it). This is the single source of truth for
      // "the underlying session is gone for good"; reset any Tab whose
      // sessionId matches so the next `planSessionOpen` doesn't jump-to-tab
      // into a Tab whose sidecar has been dead for hours. The crash-with-
      // owners path stays handled by `session-sidecar:restarted` in
      // TabProvider — this listener deliberately doesn't fire for that case.
      //
      // Stale-event guard (Codex review CRIT-1): a same-session-id relaunch
      // can happen between Rust emitting and us receiving the event (user
      // clicks history → the canonical open path revives it with a higher
      // generation — Rust's `instance_counter` guarantees uniqueness). The
      // stale terminal event would then wipe a tab that's already bound to
      // the live new sidecar. Re-query Rust at handling time: if a sidecar
      // entry exists for this sessionId NOW, the event is stale and the
      // current binding must NOT be cleared.
      void listenWithCleanup<{ sessionId: string; generation: number }>(
        'session:sidecar-terminal',
        async (event) => {
          if (!mountedRef.current) return;
          const { sessionId, generation } = event.payload;
          while (mountedRef.current) {
            // `openingRevision` detects an opening that starts and finishes
            // entirely while either Rust read is in flight. An opening already
            // active here owns both its success and failure rollback.
            const openingRevision = sessionResourceTransitionsRef.current.openingRevision;
            if (isSessionOpening(sessionResourceTransitionsRef.current, sessionId)) return;

            // Generation check first: a same-session relaunch after this terminal
            // event gets a fresh generation. If that replacement is currently dead
            // but still ownerful and awaiting health-monitor recovery, a liveness
            // check alone would return false and incorrectly clear the new binding.
            const currentGeneration = await getSessionGeneration(sessionId);
            if (currentGeneration !== null && currentGeneration !== generation) {
              console.log(
                `[App] Ignoring stale terminal event for ${sessionId} (event gen=${generation}, current gen=${currentGeneration})`
              );
              return;
            }
            // Presence check for the same-generation edge case. Readiness is
            // intentionally irrelevant here; any live entry means don't clear.
            if (await hasSessionSidecar(sessionId)) {
              console.log(
                `[App] Ignoring stale terminal event for ${sessionId} (gen=${generation}) — live sidecar entry present`
              );
              return;
            }
            if (isSessionOpening(sessionResourceTransitionsRef.current, sessionId)) return;
            if (sessionResourceTransitionsRef.current.openingRevision !== openingRevision) continue;
            if (!mountedRef.current) return;

            // Commit in the same synchronous boundary as the stable revision
            // check so a later opening observes the terminal projection.
            flushSync(() => {
              setTabs((prev) => {
                const next = applyTerminalSessionToTabs(prev, sessionId);
                if (next !== prev) {
                  console.log(`[App] Tab.sessionId reset for terminated session ${sessionId}`);
                }
                return next as typeof prev;
              });
            });
            return;
          }
        },
        listenerAc.signal,
      );

      // Reconcile path — Rust emits this when its terminal_events broadcast
      // lagged (capacity 64 exceeded by a shutdown burst). Payload is the
      // currently-live session id list snapshotted at lag-detection time;
      // any Tab.sessionId NOT in that set is suspect.
      //
      // Two layers of guarding (Codex review CRIT-2):
      //  (1) The snapshot can be stale by the time we receive — for each
      //      suspect, re-query Rust's current sidecar generation and only treat
      //      it as gone if Rust has no sidecar entry for that id. A newer
      //      generation must survive even if its process is temporarily dead
      //      and waiting for health-monitor recovery.
      //  (2) Candidates are taken from a tabsRef snapshot; new tabs may
      //      appear during our async work. To avoid clearing those, we
      //      apply cleanup tab-by-tab via `applyTerminalSessionToTabs`
      //      against the *current* prev, and only for the exact session
      //      ids we definitively confirmed gone.
      void listenWithCleanup<{ liveSessionIds: string[] }>(
        'session:sidecar-terminal-reconcile',
        async (event) => {
          if (!mountedRef.current) return;
          const stillLive = new Set<string>(event.payload.liveSessionIds);
          while (mountedRef.current) {
            const openingRevision = sessionResourceTransitionsRef.current.openingRevision;
            const candidates = tabsRef.current
              .filter((tab) => (
                tab.sessionId
                && !isPendingSessionId(tab.sessionId)
                && !stillLive.has(tab.sessionId)
                && !isSessionOpening(sessionResourceTransitionsRef.current, tab.sessionId)
              ))
              .map((tab) => tab.sessionId as string);
            const goneIds = (await Promise.all(candidates.map(async (sessionId) => (
              await getSessionGeneration(sessionId) === null ? sessionId : null
            )))).filter((sessionId): sessionId is string => sessionId !== null);
            if (!mountedRef.current || goneIds.length === 0) return;
            if (sessionResourceTransitionsRef.current.openingRevision !== openingRevision) continue;
            const stableGoneIds = goneIds.filter(
              (sessionId) => !isSessionOpening(sessionResourceTransitionsRef.current, sessionId),
            );
            if (stableGoneIds.length === 0) return;

            flushSync(() => {
              setTabs((prev) => {
                let next = prev;
                for (const sessionId of stableGoneIds) {
                  next = applyTerminalSessionToTabs(next, sessionId) as typeof prev;
                }
                if (next !== prev) {
                  console.log(`[App] Reconcile cleared ${stableGoneIds.length} stale binding(s)`);
                }
                return next;
              });
            });
            return;
          }
        },
        listenerAc.signal,
      );
    }

    return () => {
      mountedRef.current = false;
      // Clear any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      // Tear down all listeners registered above (each listenWithCleanup
      // wires its own teardown on `signal.abort`, so a single abort here
      // reaches every one).
      listenerAc.abort();
      // Flush any pending frontend logs before shutdown
      forceFlushLogs();
      clearLogServerUrl();
      // NOTE: Do NOT call stopAllSidecars() here.
      // This cleanup runs on ANY unmount (including error boundary recovery),
      // not just app exit. Killing the sidecar during error recovery creates a
      // death loop: error → unmount → kill sidecar → sidecar unavailable → more errors.
      // Rust owns application cleanup on RunEvent::ExitRequested. WebView
      // destruction is window-scoped and must never stop application resources.
    };
  }, [startGlobalSidecarSilent]);

  // Update tab isGenerating state (called from TabProvider via callback)
  const updateTabGenerating = useCallback((tabId: string, isGenerating: boolean) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, isGenerating } : t
    ));
  }, []);

  // Update tab title (called from TabProvider when auto-title or rename occurs)
  const updateTabTitle = useCallback((tabId: string, title: string) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, title } : t));
  }, []);

  // Update tab unread state (called from TabProvider when message completes on non-active tab)
  const updateTabUnread = useCallback((tabId: string, hasUnread: boolean) => {
    setTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      if (tab && tab.hasUnread !== hasUnread) {
        return prev.map(t => t.id === tabId ? { ...t, hasUnread } : t);
      }
      return prev; // no-op: avoid unnecessary re-render
    });
  }, []);

  const clearActiveTabUnread = useCallback(() => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;
    updateTabUnread(activeTabId, false);
  }, [updateTabUnread]);
  const lastUnreadClearedActiveTabIdRef = useRef<string | null>(null);

  const acknowledgeNotificationTarget = useCallback((target: NotificationBadgeTarget) => {
    setExternalNotificationBadges((items) => acknowledgeNotificationBadgeTarget(items, target));
  }, []);

  const acknowledgeActiveChatSessionNotifications = useCallback(() => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;
    const activeTab = tabsRef.current.find((tab) => tab.id === activeTabId);
    if (activeTab?.view !== 'chat') return;
    const sessionId = activeTab.sessionId?.trim();
    if (!sessionId || isPendingSessionId(sessionId)) return;
    acknowledgeNotificationTarget({ type: 'session', sessionId });
  }, [acknowledgeNotificationTarget]);

  const handleWindowFocused = useCallback(() => {
    clearActiveTabUnread();
    acknowledgeActiveChatSessionNotifications();
  }, [acknowledgeActiveChatSessionNotifications, clearActiveTabUnread]);

  // App-owned admission boundary for operations that can acquire, migrate, or
  // destroy a fixed Session identity. Claims are per Session, so unrelated
  // Tabs remain fully concurrent.
  const sessionResourceTransitionsRef = useRef(createSessionResourceTransitionState());
  const tabSessionIdentityTransitionsRef = useRef<Map<string, Promise<void>>>(new Map());

  // Update tab sessionId when backend creates real session (called from TabProvider)
  // This ensures Session singleton constraint works correctly:
  // - Tab.sessionId syncs with the actual session ID
  // - History dropdown can detect if session is already open in a Tab
  // - Rust HashMap keys are upgraded from "pending-xxx" to real session ID
  const updateTabSessionId = useCallback((
    tabId: string,
    newSessionId: string,
    options?: AdoptMigratedSessionOptions,
  ): Promise<boolean> => {
    const predecessor = tabSessionIdentityTransitionsRef.current.get(tabId) ?? Promise.resolve();
    const operation = predecessor.catch(() => undefined).then(async (): Promise<boolean> => {
    // Find the current tab to get the old sessionId
    const currentTab = tabsRef.current.find(t => t.id === tabId);
    if (!currentTab) {
      console.error(`[App] Refusing to update missing tab ${tabId} sessionId to ${newSessionId}`);
      if (options?.sidecarAlreadyMigrated) {
        await Promise.allSettled([
          stopSseProxy(tabId),
          releaseTabSession(newSessionId, tabId),
        ]);
      }
      return false;
    }
    const oldSessionId = currentTab?.sessionId;
    const identityChanges = oldSessionId !== newSessionId;
    const releaseTargetTransition = identityChanges
      ? tryClaimSessionResourceTransition(
        sessionResourceTransitionsRef.current,
        newSessionId,
        'opening',
        tabId,
      )
      : null;
    if (identityChanges && !releaseTargetTransition) {
      // A concrete identity already owned by another open/delete transition
      // cannot be adopted by this creator. Pending sidecars have no safe old
      // identity to resume, so terminate that exact Tab/owner instead of
      // leaving a continuation that can republish the contested Session.
      if (options?.sidecarAlreadyMigrated) {
        if (oldSessionId && isPendingSessionId(oldSessionId)) {
          clearPendingSessionBirth(tabId);
          setTabs((current) => [...applyTerminalSessionToTabs(current, oldSessionId)]);
        }
        await Promise.allSettled([
          stopSseProxy(tabId),
          releaseTabSession(newSessionId, tabId),
        ]);
      } else if (oldSessionId && isPendingSessionId(oldSessionId)) {
        clearPendingSessionBirth(tabId);
        setTabs((current) => [...applyTerminalSessionToTabs(current, oldSessionId)]);
        await Promise.allSettled([
          stopSseProxy(tabId),
          releaseTabSession(oldSessionId, tabId),
        ]);
      }
      return false;
    }

    try {
      console.log(`[App] Tab ${tabId} sessionId updating: ${oldSessionId} -> ${newSessionId}`);

      // Ordinary Session birth upgrades the exact Tab owner here. A joint
      // channel migration has already moved the exact Tab + Agent owner set in
      // the proof-bearing Rust command, so repeating a weaker Tab-only upgrade
      // would both be redundant and violate the owner contract.
      if (oldSessionId && oldSessionId !== newSessionId && !options?.sidecarAlreadyMigrated) {
        const upgraded = await upgradeSessionId(oldSessionId, newSessionId, tabId);
        console.log(`[App] Rust HashMap upgrade: ${oldSessionId} -> ${newSessionId}, success=${upgraded}`);
        if (!upgraded) {
          console.error(`[App] Refusing to update tab ${tabId} sessionId because Rust sidecar upgrade failed: ${oldSessionId} -> ${newSessionId}`);
          return false;
        }
        if (upgraded) {
          const fbResult = await migrateFloatingBallSessionBinding(oldSessionId, newSessionId);
          if (fbResult.migrated) {
            console.log(`[App] Floating ball session binding migrated: ${oldSessionId} -> ${newSessionId}, notified=${fbResult.notified}`);
          }
        }
      }

      // Update UI state
      flushSync(() => {
        setTabs(prev => prev.map(t =>
          t.id === tabId ? { ...t, sessionId: newSessionId } : t
        ));
      });
      return true;
    } finally {
      releaseTargetTransition?.();
    }
    });
    const settled = operation.then(() => undefined, () => undefined);
    tabSessionIdentityTransitionsRef.current.set(tabId, settled);
    void settled.finally(() => {
      if (tabSessionIdentityTransitionsRef.current.get(tabId) === settled) {
        tabSessionIdentityTransitionsRef.current.delete(tabId);
      }
    });
    return operation;
  }, []);

  // Perform the actual tab close operation (pure function, no confirmation)
  // UI updates are immediate; resource cleanup runs in background (non-blocking)
  const performCloseTab = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current;

    // Double-check: tab might have been removed
    const tab = currentTabs.find(t => t.id === tabId);
    if (!tab) return;

    // Calculate actual tab_count after close:
    // - If closing the last tab, a new launcher is created, so count = 1
    // - Otherwise, count = currentTabs.length - 1
    const isLastTab = currentTabs.length === 1;
    const actualTabCount = isLastTab ? 1 : currentTabs.length - 1;

    // Track tab_close event with correct count
    track('tab_close', { view: tab.view, tab_count: actualTabCount });

    // Drop any leftover pending surface for this tab to avoid leaking it into
    // a later (unrelated) session_new — the analytics module keeps these
    // module-level until consumed.
    clearPendingSessionBirth(tabId);
    setDeferredMountTabIds((current) => {
      if (!current.has(tabId)) return current;
      const next = new Set(current);
      next.delete(tabId);
      return next;
    });

    // ========== IMMEDIATE UI UPDATE (non-blocking) ==========
    // Update UI state first for instant response
    if (isLastTab) {
      // Special case: If this is the last tab, replace with launcher (don't close the app)
      const newTab = createNewTab();
      setTabs([newTab]);
      setActiveTabId(newTab.id);
    } else {
      // Normal case: close the tab
      const newTabs = currentTabs.filter((t) => t.id !== tabId);

      // If closing the active tab, switch to the last remaining tab
      if (tabId === activeTabIdRef.current && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }

      setTabs(newTabs);
    }

    // ========== BACKGROUND CLEANUP (non-blocking) ==========
    // Capture tab data before cleanup to avoid stale closure issues
    const tabSessionId = tab.sessionId;
    const tabAgentDir = tab.agentDir;

    // Resource cleanup runs asynchronously without blocking UI
    // CRITICAL: SSE proxy must be stopped BEFORE Sidecar to avoid "unexpected EOF" errors
    // When Sidecar dies, open HTTP connections break mid-stream causing errors
    const cleanupResources = async () => {
      try {
        // Step 1: Try to start background completion if AI is running
        // This keeps the Sidecar alive so AI can finish its response
        if (tabSessionId) {
          const bgResult = await startBackgroundCompletion(tabSessionId);
          if (bgResult.started) {
            console.log(`[App] Tab ${tabId} closing: AI still running, background completion started for session ${tabSessionId}`);
          }
        }

        // Step 2: Stop SSE proxy FIRST to ensure clean disconnection
        // This prevents "unexpected EOF" errors when Sidecar is stopped
        await stopSseProxy(tabId);

        // Step 3: Release Tab's ownership of the Session Sidecar
        // If background completion is active, Sidecar continues running (BG owner keeps it alive)
        if (tabSessionId) {
          try {
            const stopped = await releaseTabSession(tabSessionId, tabId);
            console.log(`[App] Tab ${tabId} released session ${tabSessionId}, sidecar stopped: ${stopped}`);
          } catch (error) {
            console.error(`[App] Error releasing session sidecar for tab ${tabId}:`, error);
            // Fallback to legacy stopTabSidecar
            void stopTabSidecar(tabId);
          }
        } else if (tabAgentDir) {
          // No sessionId but has agentDir - legacy case, use stopTabSidecar
          void stopTabSidecar(tabId);
        }
      } catch (error) {
        console.error(`[App] Background cleanup error for tab ${tabId}:`, error);
      }
    };

    // Runs in background — catch ensures no unhandled rejection
    cleanupResources().catch(err =>
      console.error(`[App] Unhandled cleanup error for tab ${tabId}:`, err)
    );
  }, [setActiveTabId]);

  // Close tab — if AI is generating, close immediately and let it finish in background.
  // No confirmation dialog: background completion keeps the Sidecar alive.
  const closeTabWithConfirmation = useCallback(async (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);

    if (tab?.isGenerating && tab.sessionId) {
      void performCloseTab(tabId);
      toastRef.current.info(t('appChrome.backgroundCompletion'));
      return;
    }

    void performCloseTab(tabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, [setActiveTabId, t]);

  // Close current active tab (for Cmd+W)
  const closeCurrentTab = useCallback(() => {
    const currentActiveTabId = activeTabIdRef.current;
    if (!currentActiveTabId) return;

    const currentTabs = tabsRef.current;
    const activeTab = currentTabs.find(t => t.id === currentActiveTabId);

    // Special case: If only one launcher tab, do nothing
    if (currentTabs.length === 1 && activeTab?.view === 'launcher') {
      return;
    }

    // Multiple tabs OR last tab is chat/settings: use the unified confirmation logic
    void closeTabWithConfirmation(currentActiveTabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, [setActiveTabId]);

  // Application-level keyboard shortcuts (new/close/switch tab, task-center,
  // settings, reload-block). The bindings + matching live in the declarative
  // APP_SHORTCUTS table (utils/appShortcuts.ts) — the same source the Settings
  // 「快捷键」reference renders from. Here we only build the side-effecting
  // context and dispatch; callbacks are stabilized via refs so the empty-deps
  // closure resolves them at press time.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      if (dispatchAppShortcut(e, isMac, {
        tabs: tabsRef.current,
        activeTabId: activeTabIdRef.current,
        setActiveTabId,
        newTab: handleNewTab,
        closeCurrentTab,
        dismissTopmost,
        hasBlockingBackdrop: () => !!document.querySelector('.fixed.inset-0[class*="backdrop-blur"]'),
        openTaskCenter: () => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CENTER)),
        openSettings: () => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS)),
      })) return;
      // ⌘/Ctrl+A for plain <input>/<textarea> (chat input, rename fields). The native
      // macOS "Select All" menu item was removed so ⌘A reaches the WebView (see
      // src-tauri/src/lib.rs); Monaco and the workspace tree own it via their own
      // keydown handlers, but a plain text control has no JS owner — handle it here
      // deterministically rather than depend on an undocumented WKWebView default.
      // Returns false (no-op) for Monaco/tree/everything else, so those still own ⌘A.
      handleSelectAllKeydown(e, isMac);
    };

    // Capture phase: application-level shortcuts (Cmd+W/T/Tab, etc.) MUST fire before
    // any component-level handlers. Without capture, Monaco editor (or any component
    // calling stopPropagation) blocks the event → our handler never fires →
    // e.preventDefault() never called → Tauri native Cmd+W closes the window.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, [setActiveTabId]);

  // Stable capability passed to TabProvider recovery so it shares the same
  // fixed-identity admission boundary as App opens and deletion.
  const claimSessionOpeningTransition = useCallback((sessionId: string, ownerId: string) => (
    tryClaimSessionResourceTransition(
      sessionResourceTransitionsRef.current,
      sessionId,
      'opening',
      ownerId,
    )
  ), []);

  /** Launch a workspace as a new Session. Existing Sessions use handleOpenTargetSession. */
  const handleLaunchProject = useCallback(async (
    project: Project,
    initialMessage?: InitialMessage,
    analyticsContext?: LaunchProjectAnalyticsContext,
    sessionBirthHint?: LaunchSessionBirthHint,
  ) => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return false;

    // Per-tab launch guard: prevent concurrent launches on the same tab
    // A second launch would overwrite the first's initialMessage and kill its sidecar
    if (launchingTabRef.current === activeTabId) {
      console.warn(`[App] handleLaunchProject: launch already in progress for tab ${activeTabId}, ignoring`);
      return false;
    }
    launchingTabRef.current = activeTabId;

    // Resolve agent meta for analytics. `getProjectAgent` may return
    // undefined when the workspace isn't bound to any agent (rare — happens
    // for ad-hoc paths) — in that case agent_hash=null + runtime='builtin'
    // as the natural fallback.
    //
    // Surface set is deferred until `targetTabId` is finalized below — when a
    // persistently-owned current Session requires a new tab, that TabProvider
    // consume the surface from THE NEW tabId, not the original activeTabId.
    // Tracked here for review feedback B2/H2 (Codex BLOCKER, Codex HIGH).
    const pendingSurfaceForLaunch: PendingSessionBirthContext = (() => {
      const fallbackLaunchContext = initialMessage
        ? { surface: 'launcher_input' as const, entryIntent: 'send_message' as const }
        : { surface: 'agent_card' as const, entryIntent: 'open_workspace' as const };
      return {
        surface: analyticsContext?.surface ?? fallbackLaunchContext.surface,
        entryIntent: analyticsContext?.entryIntent ?? fallbackLaunchContext.entryIntent,
        hasInitialMessage: !!initialMessage,
        assistantEntry: analyticsContext?.assistantEntry,
      };
    })();
    const workspaceOpenAnalytics: {
      surface: Surface;
      agent_hash: string | null;
      runtime: ReturnType<typeof resolveEffectiveRuntime>;
      entry_intent: EntryIntent;
      has_initial_message: boolean;
      session_id: null;
    } = (() => {
      const cfg = configRef.current;
      const agent = getProjectAgent(cfg, configProjects, project.path);
      return {
        surface: pendingSurfaceForLaunch.surface,
        agent_hash: hashAgentNameSync(agent?.name ?? null),
        runtime: resolveEffectiveRuntime(agent?.runtime, !!cfg.multiAgentRuntime),
        entry_intent: pendingSurfaceForLaunch.entryIntent,
        has_initial_message: !!initialMessage,
        session_id: null,
      };
    })();

    setTabErrors((prev) => ({ ...prev, [activeTabId]: null }));
    setLoadingTabs((prev) => ({ ...prev, [activeTabId]: true }));
    let targetTabId = activeTabId;

    try {
      const activeTab = tabsRef.current.find(t => t.id === activeTabId);
      perfMark('launch_start', { tabId: activeTabId });
      console.log(`[App][launch] START active=${activeTabId} view=${activeTab?.view} hasSession=${!!activeTab?.sessionId} target-sessionId=NEW`);

      // A Session with Task/Goal/background ownership must keep its Tab binding;
      // create the new conversation in a fresh Tab instead of releasing it.
      const currentSessionHasPersistentOwners = activeTab?.sessionId
        ? await sessionHasPersistentOwners(activeTab.sessionId)
        : false;
      console.log(`[App][launch] persistent-owner-check ${activeTab?.sessionId ? `present=${currentSessionHasPersistentOwners}` : 'skipped(no-session)'}`);
      if (currentSessionHasPersistentOwners) {
        if (tabsRef.current.length >= MAX_TABS) {
          setTabErrors((prev) => ({ ...prev, [activeTabId]: t('appChrome.maxTabsReached') }));
          return false;
        }
        const newTab = createNewTab();
        setTabs((prev) => [...prev, newTab]);
        targetTabId = newTab.id;
        setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: true }));
      }

      // ========================================
      // The target Tab releases its previous Session owner before starting the
      // new pending Session. Existing persisted Sessions never enter this path.
      // ========================================
      console.log(`[App] New Session launch - tab ${targetTabId}, project: ${project.path}`);

      // If current tab has an active session, release it before launching new one
      const currentTabForLaunch = tabsRef.current.find(t => t.id === targetTabId);
      const oldSessionForLaunch = currentTabForLaunch?.sessionId;
      if (oldSessionForLaunch) {
        const bgResult = await startBackgroundCompletion(oldSessionForLaunch);
        if (bgResult.started) {
          console.log(`[App] AI running on ${oldSessionForLaunch}, background completion started`);
        }
        // Always release old session regardless of AI state:
        // - If BG started: Sidecar stays alive via BG owner
        // - If idle: Sidecar stops (no more owners)
        await stopSseProxy(targetTabId);
        await releaseTabSession(oldSessionForLaunch, targetTabId);
      }

      const configForLaunchBirth = configRef.current;
      const agentForLaunchBirth = configForLaunchBirth
        ? getProjectAgent(configForLaunchBirth, configProjects, project.path)
        : undefined;
      const initialMessageHasExecutionSelection = Boolean(
        initialMessage?.providerExecutionIdentity
        || initialMessage?.builtinSelection
        || initialMessage?.runtimeModel
        || sessionBirthHint?.providerExecutionIdentity
        || sessionBirthHint?.builtinSelection
        || sessionBirthHint?.runtimeModel,
      );
      const runtimeBackedProviderIdentityFromConfig = (() => {
        if (initialMessageHasExecutionSelection || !configForLaunchBirth) {
          return undefined;
        }
        if (!agentUsesManagedCodexProvider(agentForLaunchBirth)
            || !getManagedCodexProviderReadiness(configForLaunchBirth).selectable) {
          return undefined;
        }
        const model = normalizeStringSetting(agentForLaunchBirth?.model)
          ?? normalizeStringSetting(project.model);
        if (!model) {
          return undefined;
        }
        return createRuntimeBackedProviderIdentity({
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          model,
        });
      })();
      const runtimeBackedProviderIdentity =
        initialMessage?.providerExecutionIdentity
        ?? sessionBirthHint?.providerExecutionIdentity
        ?? runtimeBackedProviderIdentityFromConfig;

      // For ordinary new sessions (no sessionId), generate a temporary session ID;
      // the sidecar materializes it later. Runtime-backed providers are different:
      // Rust must read runtime/runtimeSource/providerExecutionIdentity from
      // sessions.json before spawning, so create a real session metadata row before
      // ensureSessionSidecar. This covers both explicit initial-message launches
      // and empty workspace opens whose Agent template uses Codex (订阅).
      let effectiveSessionId = createPendingSessionId(targetTabId);
      if (runtimeBackedProviderIdentity) {
        try {
          const identity = runtimeBackedProviderIdentity;
          const identityResolvedFromCurrentConfig =
            !initialMessage?.providerExecutionIdentity && !sessionBirthHint?.providerExecutionIdentity;
          const birth = buildRuntimeBackedInitialSessionBirth({
            identity,
            permissionMode: initialMessage?.permissionMode
              ?? sessionBirthHint?.permissionMode
              ?? (identityResolvedFromCurrentConfig
                ? resolveInitialPermissionMode({
                    project,
                    agent: agentForLaunchBirth,
                    defaultPermissionMode: configForLaunchBirth?.defaultPermissionMode,
                  })
                : undefined),
            reasoningEffort: initialMessage?.reasoningEffort
              ?? sessionBirthHint?.reasoningEffort
              ?? (identityResolvedFromCurrentConfig
                ? (
                    normalizeStringSetting(agentForLaunchBirth?.runtimeConfig?.reasoningEffort)
                    ?? normalizeStringSetting(agentForLaunchBirth?.reasoningEffort)
                  )
                : undefined),
            mcpEnabledServers: initialMessage?.mcpEnabledServers
              ?? sessionBirthHint?.mcpEnabledServers
              ?? (identityResolvedFromCurrentConfig
                ? cloneStringArray(agentForLaunchBirth?.mcpEnabledServers ?? project.mcpEnabledServers)
                : undefined),
            enabledPluginIds: initialMessage?.enabledPluginIds
              ?? sessionBirthHint?.enabledPluginIds
              ?? (identityResolvedFromCurrentConfig
                ? cloneStringArray(agentForLaunchBirth?.enabledPluginIds ?? project.enabledPluginIds)
                : undefined),
            enabledOfficialToolIds: initialMessage?.enabledOfficialToolIds
              ?? sessionBirthHint?.enabledOfficialToolIds
              ?? (identityResolvedFromCurrentConfig
                ? normalizeOfficialToolIds(agentForLaunchBirth?.enabledOfficialToolIds ?? project.enabledOfficialToolIds ?? [])
                : undefined),
          });
          console.log(
            `[App] Runtime-backed provider launch birth: provider=${identity.providerId} runtime=${birth.runtime} source=${birth.opts.runtimeSource ?? 'none'} model=${identity.model}`,
          );
          const prepared = await createSession(project.path, birth.runtime, {
            ...birth.opts,
            origin: sessionBirthHint?.origin ?? originFromDesktopSurface(pendingSurfaceForLaunch?.surface),
            prepareForFirstUserMessage: true,
            materializationSourceSessionId: effectiveSessionId,
          });
          effectiveSessionId = prepared.id;
        } catch (err) {
          console.error('[App] Failed to create runtime-backed provider session:', err);
          setTabErrors((prev) => ({ ...prev, [targetTabId]: t('appChrome.codexSessionCreateFailed') }));
          setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
          launchingTabRef.current = null;
          return false;
        }
      }

      // Ensure Sidecar is running for this Session, Tab as owner.
      //
      // Pattern 4: this call resolves only after the sidecar's /health/ready
      // returns 200 — i.e. deferred init (migration / skill-seed / sdk-init)
      // has finished. If readiness times out or reports `failed`, the Rust
      // call throws with the last-observed phase embedded in the error
      // string, which we surface via `setTabErrors` → Launcher.startError.
      // For finer-grained UX (inline phase banner during the brief
      // pending → ready window) callers can use `useSessionReady`.
      // Apply the pending surface to the final target tab (persistent ownership
      // may have rerouted `targetTabId` to a freshly-created tab).
      // Set BEFORE ensureSessionSidecar — the backend may emit chat:system-init
      // synchronously once readiness lands, and the target TabProvider needs to
      // consume the surface from this tabId at that moment.
      track('workspace_open', {
        ...workspaceOpenAnalytics,
        tab_id: targetTabId,
      });
      setPendingSessionBirth(targetTabId, pendingSurfaceForLaunch);

      // INSTANT-NAV: flip to the chat shell BEFORE awaiting the sidecar boot, so the
      // user lands in Chat instantly (the boot runs under the "AI 启动中" overlay).
      // `effectiveSessionId` is a prepared runtime-backed id or a fresh
      // `pending-<tabId>`, so the chat shell can mount before the cold boot.
      const flipTitle = project.displayName || getFolderName(project.path);
      perfMark('launch_flip', { tabId: targetTabId });
      console.log(`[App][launch] FLIP(flushSync) target=${targetTabId} active=${activeTabId} (chat shell should paint now)`);
      // flushSync is load-bearing: without it React can coalesce this update with
      // the post-ensure updates, delaying the chat shell until after the cold boot.
      flushSync(() => {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === targetTabId
              ? buildChatFlipPatch(t, { agentDir: project.path, sessionId: effectiveSessionId, title: flipTitle, initialMessage, sidecarConfigDisposition: 'push' })
              : t
          )
        );
        if (targetTabId !== activeTabId) {
          setActiveTabId(targetTabId);
        }
      });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        perfMark('chat_painted', { tabId: targetTabId });
        console.log(`[App][launch] chat_painted target=${targetTabId} (browser painted the flip)`);
      }));

      const result = await ensureSessionSidecar(effectiveSessionId, project.path, 'tab', targetTabId);
      perfMark('launch_ensured', { tabId: targetTabId });
      console.log(`[App] Session Sidecar ensured: isNew=${result.isNew}`);
      if (!await reconcileSessionTabActivation(effectiveSessionId, targetTabId)) {
        throw new Error(`Rust refused owner reconcile for session ${effectiveSessionId} and tab ${targetTabId}`);
      }

      // Rust decides whether this owner joined a concurrently-created process.
      const resolved: SidecarConfigDisposition = result.isNew ? 'push' : 'adopt';
      // The shell already owns initialMessage; update only the disposition so it
      // cannot be re-attached and auto-sent twice.
      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId ? { ...t, sidecarConfigDisposition: resolved } : t
        )
      );
      setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[App] Failed to start:', errorMsg);

      // Clear pending analytics ownership so a later unrelated Session birth
      // cannot inherit it. Cover both candidate tab IDs after retargeting.
      clearPendingSessionBirth(targetTabId);
      if (targetTabId !== activeTabId) clearPendingSessionBirth(activeTabId);

      const errorTabId = targetTabId !== activeTabId ? targetTabId : activeTabId;
      setTabErrors((prev) => ({ ...prev, [errorTabId]: errorMsg }));

      // A5 (instant-nav): with the early flip the tab may already be on the chat
      // view, where `tabErrors` isn't surfaced (it only feeds the Launcher's
      // unused startError) and the startup overlay would otherwise just time out
      // to a blank chat. A toast makes the boot failure visible regardless of
      // which view the user is on. (Full in-chat "启动失败 + 重试" via
      // useSessionReady('failed'): Phase A follow-up.)
      toastRef.current.error(t('appChrome.launchFailed', { message: errorMsg }));

      // In browser dev mode, still allow navigation
      if (isBrowserDevMode()) {
        console.log('[App] Browser mode: continuing despite error');
        setTabs((prev) =>
          prev.map((t) =>
            t.id === errorTabId
              ? {
                ...t,
                agentDir: project.path,
                view: 'chat',
                title: project.displayName || getFolderName(project.path),
                // Terminal: ensure failed — never leave a mounted chat 'pending'.
                sidecarConfigDisposition: 'push' as const,
              }
              : t
          )
        );
      }
      return false;
    } finally {
      launchingTabRef.current = null;
      setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: false }));
    }
  }, [configProjects, setActiveTabId, t]);

  /**
   * Runtime-backed provider switches are fresh-session launches, not transcript
   * forks. App owns the launcher Tab, prepared metadata birth, Sidecar owner,
   * and activation as one canonical lifecycle transaction.
   */
  const handleLaunchRuntimeBackedProviderSession = useCallback(async (
    project: Project,
    sessionBirthHint: LaunchSessionBirthHint & { providerExecutionIdentity: RuntimeBackedProviderIdentity },
    title: string,
  ): Promise<string | null> => {
    if (tabsRef.current.length >= MAX_TABS) {
      toastRef.current.error(t('appChrome.tabLimitReached'));
      return null;
    }

    const launchTab = createNewTab();
    openLaunchTabNow(launchTab);
    try {
      const opened = await handleLaunchProject(
        project,
        undefined,
        { surface: 'unknown', entryIntent: 'fork' },
        sessionBirthHint,
      );
      if (!opened) {
        removeUnusedPrecreatedLaunchTab(launchTab.id);
        return null;
      }

      const launchedTab = tabsRef.current.find((tab) => tab.id === launchTab.id);
      const launchedSessionId = launchedTab?.sessionId;
      if (!launchedSessionId || isPendingSessionId(launchedSessionId)) {
        console.error('[App] Runtime-backed provider launch completed without a materialized Session id');
        return null;
      }

      setTabs((current) => current.map((tab) => (
        tab.id === launchTab.id ? { ...tab, title } : tab
      )));
      return launchedSessionId;
    } catch (error) {
      console.error('[App] Failed to launch runtime-backed provider Session:', error);
      removeUnusedPrecreatedLaunchTab(launchTab.id);
      return null;
    }
  }, [handleLaunchProject, openLaunchTabNow, removeUnusedPrecreatedLaunchTab, t]);

  // Clear initialMessage from a tab after it has been consumed by Chat
  const clearInitialMessage = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, initialMessage: undefined } : t
    ));
  }, []);

  // Called by Chat after it has adopted a joined sidecar's config. Move the tab to
  // 'push' so the user's SUBSEQUENT in-tab edits push to the sidecar normally (the
  // adoption is one-shot). Push effects don't replay on adopt→push because they key
  // on the `configPending` boolean, which stays false across this transition.
  const markSidecarConfigAdopted = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, sidecarConfigDisposition: 'push' } : t
    ));
  }, []);

  const handleFilePreviewIntentConsumed = useCallback((tabId: string, intentId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId && t.pendingFilePreview?.id === intentId
        ? { ...t, pendingFilePreview: undefined }
        : t
    ));
  }, []);

  // Rename session: update tab title + persist to backend + notify listeners
  const handleRenameSession = useCallback((tabId: string, newTitle: string) => {
    updateTabTitle(tabId, newTitle);
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (tab?.sessionId) {
      updateSession(tab.sessionId, { title: newTitle, titleSource: 'user' })
        .then(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED)))
        .catch(err => console.error('[App] Failed to persist renamed title:', err));
    }
  }, [updateTabTitle]);

  /**
   * Handle fork session: create a new tab for the forked session.
   * Called from Chat after the backend has created the forked session metadata + messages.
   */
  const handleForkSession = useCallback(async (_tabId: string, newSessionId: string, forkAgentDir: string, title: string, initialMessage?: string) => {
    // Check tab limit
    if (tabsRef.current.length >= MAX_TABS) {
      toastRef.current.error(t('appChrome.tabLimitReached'));
      return false;
    }
    const releaseTransition = tryClaimSessionResourceTransition(
      sessionResourceTransitionsRef.current,
      newSessionId,
      'opening',
    );
    if (!releaseTransition) return false;

    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: forkAgentDir,
      sessionId: newSessionId,
      view: 'chat',
      title,
      // Fork mints a brand-new session id → fresh sidecar → 'push'. Metadata is
      // already visible to history, so the opening claim above still excludes
      // user deletion until this Tab owner is attached.
      sidecarConfigDisposition: 'push',
      ...(initialMessage ? { initialMessage: { text: initialMessage } } : {}),
    };

    setTabs(prev => [...prev, newTab]);
    setLoadingTabs(prev => ({ ...prev, [newTab.id]: true }));

    let ownerAcquired = false;
    try {
      await ensureSessionSidecar(newSessionId, forkAgentDir, 'tab', newTab.id);
      ownerAcquired = true;
      console.log(`[App] Fork tab ${newTab.id} sidecar ensured`);
      if (!tabsRef.current.some(t => t.id === newTab.id)) {
        await releaseTabSession(newSessionId, newTab.id).catch(() => {});
        return false;
      }
      if (!await reconcileSessionTabActivation(newSessionId, newTab.id)) {
        throw new Error(`Rust refused owner reconcile for session ${newSessionId} and tab ${newTab.id}`);
      }
      setActiveTabId(newTab.id);
      return true;
    } catch (error) {
      console.error('[App] Failed to start sidecar for forked session:', error);
      setTabs(prev => prev.filter(t => t.id !== newTab.id));
      if (ownerAcquired) {
        await releaseTabSession(newSessionId, newTab.id).catch(() => {});
      }
      return false;
    } finally {
      setLoadingTabs(prev => ({ ...prev, [newTab.id]: false }));
      releaseTransition();
    }
  }, [setActiveTabId, t]);

  /**
   * Reconcile one existing Session with the exact Tab that displays it.
   *
   * This is the single App-owned ensure/owner path for history opens and
   * restored Tabs. Rust atomically verifies the Tab owner after ensure so a
   * Task claim racing Session startup cannot be overwritten by Renderer.
   * Every await boundary is followed by a Tab identity check so a close/rebind
   * cannot leave a phantom owner behind.
   */
  const reconcileExistingSessionTabOwner = useCallback(async (
    tabId: string,
    sessionId: string,
    agentDir: string,
  ): Promise<{ isNew: boolean } | null> => {
    const tabStillTargetsSession = () => tabsRef.current.some(
      (tab) => tab.id === tabId && tab.sessionId === sessionId,
    );
    let ownerAcquired = false;
    try {
      const result = await ensureSessionSidecar(sessionId, agentDir, 'tab', tabId);
      ownerAcquired = true;
      if (!tabStillTargetsSession()) {
        await releaseTabSession(sessionId, tabId).catch(() => {});
        ownerAcquired = false;
        return null;
      }

      const reconciled = await reconcileSessionTabActivation(
        sessionId,
        tabId,
      );
      if (!reconciled) {
        throw new Error(`Rust refused owner reconcile for session ${sessionId} and tab ${tabId}`);
      }

      if (!tabStillTargetsSession()) {
        // releaseTabSession is idempotent when the close already removed the
        // owner.
        await releaseTabSession(sessionId, tabId).catch(() => {});
        ownerAcquired = false;
        return null;
      }
      return { isNew: result.isNew };
    } catch (error) {
      if (ownerAcquired) await releaseTabSession(sessionId, tabId).catch(() => {});
      throw error;
    }
  }, []);

  /**
   * Materialize an already-mounted live Chat Tab for an existing Session.
   *
   * Both single-session navigation and bulk startup restore enter this exact
   * path after their UI planner has committed the target Tab. The ensure result
   * is the only authority for push/adopt; callers only decide how to roll back
   * their own UI projection when this returns false.
   */
  const materializeExistingSessionTab = useCallback(async (
    tabId: string,
    sessionId: string,
    agentDir: string,
  ): Promise<boolean> => {
    setLoadingTabs((current) => ({ ...current, [tabId]: true }));
    try {
      const result = await reconcileExistingSessionTabOwner(tabId, sessionId, agentDir);
      if (!result) return false;
      setTabs((current) => current.map((tab) => (
        tab.id === tabId && tab.sessionId === sessionId
          ? {
            ...tab,
            sidecarConfigDisposition: result.isNew
              ? 'push'
              : (tab.sidecarConfigDisposition === 'pending'
                  ? 'adopt'
                  : tab.sidecarConfigDisposition),
          }
          : tab
      )));
      return true;
    } catch (error) {
      console.error(`[App] Failed to materialize existing session ${sessionId} in tab ${tabId}:`, error);
      return false;
    } finally {
      setLoadingTabs((current) => ({ ...current, [tabId]: false }));
    }
  }, [reconcileExistingSessionTabOwner]);

  /**
   * Spawn a fresh Tab bound to an EXISTING session and reconcile its owner.
   * Shared by every persisted-history entry point. Returns false (after a
   * toast) when the tab cap is hit.
   */
  const spawnTabForExistingSession = useCallback(async (
    sessionId: string,
    sessionAgentDir: string,
    title: string,
    opts?: { pendingFilePreview?: FilePreviewIntent },
  ): Promise<boolean> => {
    if (tabsRef.current.length >= MAX_TABS) {
      toastRef.current.error(t('appChrome.tabLimitReached'));
      return false;
    }
    const newTab: Tab = {
      ...createNewTab(),
      agentDir: sessionAgentDir,
      sessionId,
      view: 'chat',
      title,
      ...(opts?.pendingFilePreview ? { pendingFilePreview: opts.pendingFilePreview } : {}),
      // Existing session pre-mounted before ensure → 'pending'; the post-ensure
      // step below resolves push|adopt from result.isNew (no stomp on a join).
      sidecarConfigDisposition: 'pending',
    };
    const previousActiveTabId = activeTabIdRef.current;
    // Existing-session opens are visually optimistic: mount and activate the
    // pending Tab immediately, then let Chat's existing boot surface cover
    // Sidecar startup. flushSync is load-bearing here: besides guaranteeing
    // instant visual feedback, it commits tabsRef before a warm Sidecar can
    // resolve ensure and reach the post-ensure liveness check. Keep setTabs
    // functional so queued lifecycle mutations still compose; tabsRef remains
    // a render mirror, never a second writable authority.
    flushSync(() => {
      setTabs(prev => [...prev, newTab]);
    });
    flushSync(() => {
      setActiveTabId(newTab.id);
    });
    const materialized = await materializeExistingSessionTab(
      newTab.id,
      sessionId,
      sessionAgentDir,
    );
    if (!materialized) {
      const remainingTabs = tabsRef.current.filter(t => t.id !== newTab.id);
      setTabs(prev => prev.filter(t => t.id !== newTab.id));
      if (activeTabIdRef.current === newTab.id) {
        const fallbackTabId = remainingTabs.some(t => t.id === previousActiveTabId)
          ? previousActiveTabId
          : (remainingTabs.at(-1)?.id ?? null);
        setActiveTabId(fallbackTabId, remainingTabs);
      }
      return false;
    }
    return true;
  }, [materializeExistingSessionTab, setActiveTabId, t]);

  /** Open a history session from any surface using an explicit target workspace. */
  const handleOpenTargetSession = useCallback(async (
    sessionId: string,
    sessionAgentDir: string,
    title: string,
    historyEntrySource?: HistoryEntrySource,
    options?: { pendingFilePreview?: FilePreviewIntent },
  ): Promise<boolean> => {
    const releaseTransition = tryClaimSessionResourceTransition(
      sessionResourceTransitionsRef.current,
      sessionId,
      'opening',
    );
    if (!releaseTransition) return false;
    try {
      if (historyEntrySource) {
        trackHistorySessionOpenAsync(sessionId, sessionAgentDir, historyEntrySource);
      }

      const plan = planSessionOpen({
        tabs: tabsRef.current,
        targetSessionId: sessionId,
      });
      if (plan.type === 'jump-to-tab') {
        // Acquiring the exact Tab owner is idempotent for a healthy process and
        // revives a stale binding without a probe/ensure TOCTOU window.
        const targetTabId = plan.tabId;
        if (options?.pendingFilePreview) {
          setTabs((current) => current.map((tab) => (
            tab.id === targetTabId
              ? { ...tab, pendingFilePreview: options.pendingFilePreview }
              : tab
          )));
        }
        // The existing Tab is already the navigation authority. Activate it
        // synchronously, then reconcile its process owner without yanking focus
        // back if the user moves elsewhere during a slow revive.
        setActiveTabId(targetTabId);
        const materialized = await materializeExistingSessionTab(
          targetTabId,
          sessionId,
          sessionAgentDir,
        );
        if (!materialized) {
          // The opening claim suppresses predecessor terminal events while
          // revive is in flight, so this path owns rollback for the existing
          // Tab just as the optimistic new/restore paths own theirs.
          flushSync(() => {
            setTabs((current) => current.map((tab) => (
              tab.id === targetTabId && tab.sessionId === sessionId
                ? resetTabToLauncher(tab)
                : tab
            )));
          });
          return false;
        }
        console.log(`[App] handleOpenTargetSession: Session ${sessionId} owned by tab ${targetTabId}`);
        return true;
      }
      return await spawnTabForExistingSession(sessionId, sessionAgentDir, title || getFolderName(sessionAgentDir), {
        pendingFilePreview: options?.pendingFilePreview,
      });
    } finally {
      releaseTransition();
    }
  }, [materializeExistingSessionTab, setActiveTabId, spawnTabForExistingSession, trackHistorySessionOpenAsync]);

  // "恢复对话" is a bulk entry into the same live existing-Session path used
  // by normal history navigation. Validate every candidate under its Session
  // opening admission first, then commit one final tabs/active projection so
  // every restored Chat mounts TabProvider from its first render. Heavy Chat
  // children stay deferred: only the active one reveals after the shell paints,
  // while inactive ones reveal on first selection. Owner work is independent
  // per target; failures are removed together from the latest Tab list so
  // concurrent results cannot overwrite one another or newer user work.
  const handleRestoreLastSession = useCallback(async () => {
    const candidate = restoreCandidateRef.current;
    setRestorePillCount(0);
    restoreCandidateRef.current = null;
    if (!candidate || candidate.tabs.length === 0) return;

    type ValidatedRestoreTarget = {
      tab: Tab & { agentDir: string; sessionId: string };
      releaseTransition: () => void;
    };
    const validated = (await Promise.all(candidate.tabs.map(async (tab): Promise<ValidatedRestoreTarget | null> => {
      if (!tab.agentDir || !tab.sessionId) return null;
      const target = tab as Tab & { agentDir: string; sessionId: string };
      const releaseTransition = tryClaimSessionResourceTransition(
        sessionResourceTransitionsRef.current,
        target.sessionId,
        'opening',
        target.id,
      );
      if (!releaseTransition) return null;
      try {
        if (await canRestoreSession(target.sessionId, target.agentDir)) {
          return { tab: target, releaseTransition };
        }
        console.warn(`[App] Restore candidate ${target.id}: session ${target.sessionId} or workspace is gone`);
      } catch (error) {
        console.error(`[App] Failed to validate restore candidate ${target.id}:`, error);
      }
      releaseTransition();
      return null;
    }))).filter((target): target is ValidatedRestoreTarget => target !== null);

    if (validated.length === 0) return;
    const baseTabs = tabsRef.current;
    const previousActiveTabId = activeTabIdRef.current;
    const validTabs = validated.map(({ tab }) => tab);
    const validActiveTabId = validTabs.some((tab) => tab.id === candidate.activeTabId)
      ? candidate.activeTabId
      : null;
    const plan = planRestoreTabs(baseTabs, {
      tabs: validTabs,
      activeTabId: validActiveTabId,
    });
    if (!plan) {
      validated.forEach(({ releaseTransition }) => releaseTransition());
      return;
    }

    const addedTargets = validated.filter(({ tab }) => plan.tabs.includes(tab));
    const addedTabSet = new Set(addedTargets.map(({ tab }) => tab));
    validated.forEach(({ tab, releaseTransition }) => {
      if (!addedTabSet.has(tab)) releaseTransition();
    });
    if (addedTargets.length === 0) return;

    track('restore_last_session', { count: addedTargets.length });
    flushSync(() => {
      setDeferredMountTabIds((current) => {
        const next = new Set(current);
        addedTargets.forEach(({ tab }) => next.add(tab.id));
        return next;
      });
      // Compose after any queued field-only updates (for example another
      // existing Tab settling pending → adopt) instead of replacing them with
      // the pre-await render mirror captured by the restore plan.
      setTabs((current) => plan.tabs.map((planned) => (
        current.find((tab) => (
          tab.id === planned.id && tab.sessionId === planned.sessionId
        )) ?? planned
      )));
      setActiveTabId(plan.activeTabId, plan.tabs);
    });

    const results = await Promise.allSettled(addedTargets.map(async ({ tab, releaseTransition }) => {
      try {
        return await materializeExistingSessionTab(tab.id, tab.sessionId, tab.agentDir);
      } finally {
        releaseTransition();
      }
    }));
    const failedTabIds = new Set<string>();
    results.forEach((result, index) => {
      if (result.status === 'rejected' || !result.value) {
        failedTabIds.add(addedTargets[index].tab.id);
      }
    });
    if (failedTabIds.size === 0) return;

    const remaining = tabsRef.current.filter((tab) => !failedTabIds.has(tab.id));
    const nextTabs = remaining.length > 0 ? remaining : [createNewTab()];
    const currentActiveTabId = activeTabIdRef.current;
    const nextActiveTabId = currentActiveTabId && nextTabs.some((tab) => tab.id === currentActiveTabId)
      ? currentActiveTabId
      : (previousActiveTabId && nextTabs.some((tab) => tab.id === previousActiveTabId)
          ? previousActiveTabId
          : nextTabs.at(-1)!.id);
    flushSync(() => {
      setDeferredMountTabIds((current) => {
        const next = new Set(current);
        failedTabIds.forEach((tabId) => next.delete(tabId));
        return next;
      });
      // Functional removal composes after each successful target's queued
      // pending → push/adopt update. A direct `setTabs(nextTabs)` from the
      // render mirror can overwrite that settlement in React's update queue.
      setTabs((current) => {
        const currentRemaining = current.filter((tab) => !failedTabIds.has(tab.id));
        return currentRemaining.length > 0 ? currentRemaining : nextTabs;
      });
      setActiveTabId(nextActiveTabId, nextTabs);
    });
  }, [materializeExistingSessionTab, setActiveTabId]);

  /** Chat-local adapter: all history selections use the canonical new/jump/revive path. */
  const handleOpenChatHistorySession = useCallback(async (
    tabId: string,
    sessionId: string,
    title: string,
    historyEntrySource: HistoryEntrySource = 'chat_dropdown',
  ) => {
    const sourceTab = tabsRef.current.find((tab) => tab.id === tabId);
    if (!sourceTab?.agentDir) {
      console.error('[App] Cannot open history session: source tab has no agentDir');
      return;
    }
    await handleOpenTargetSession(
      sessionId,
      sourceTab.agentDir,
      title,
      historyEntrySource,
    );
  }, [handleOpenTargetSession]);


  /**
   * Handle "New Session" from Chat component.
   * If AI is running, starts background completion on old session and creates new Sidecar.
   * Returns true if handled (Chat should NOT call resetSession), false if AI is idle (Chat falls back to resetSession).
   */
  const handleNewSession = useCallback(async (tabId: string): Promise<boolean> => {
    const currentTab = tabsRef.current.find(t => t.id === tabId);
    if (!currentTab?.sessionId || !currentTab?.agentDir) {
      return false;
    }

    const oldSessionId = currentTab.sessionId;

    // Check if AI is running → start background completion
    const bgResult = await startBackgroundCompletion(oldSessionId);
    if (!bgResult.started) {
      // AI is idle → let Chat handle it via resetSession (more efficient, reuses Sidecar)
      return false;
    }

    // AI is running → release old Sidecar (BG owner keeps it alive), create new one
    console.log(`[App] handleNewSession: AI running on ${oldSessionId}, background completion started`);

    try {
      await stopSseProxy(tabId);
      await releaseTabSession(oldSessionId, tabId);

      // PRD 0.2.19 cross-review fix (B4): mark the upcoming session_new as
      // 'new_chat_button' provenance. handleNewSession is the AI-running variant
      // of resetSession (user clicked "新对话" while AI was still streaming) —
      // without this, chat:system-init would fall back to 'launcher_input' and
      // silently misclassify all AI-running new-session opens.
      setPendingSessionBirth(tabId, birthContextForSurface('new_chat_button'));

      // Create new pending session with new Sidecar
      const pendingSessionId = createPendingSessionId(tabId);
      await ensureSessionSidecar(pendingSessionId, currentTab.agentDir, 'tab', tabId);
      if (!await reconcileSessionTabActivation(pendingSessionId, tabId)) {
        throw new Error(`Rust refused owner reconcile for session ${pendingSessionId} and tab ${tabId}`);
      }

      // Update tab state → TabProvider will detect sessionId change and reconnect
      // Fresh sidecar for the new session → 'push' (overwrites any stale disposition)
      // on the new session (e.g. user clicks "New Session" while still in IM Bot adoption window)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, sessionId: pendingSessionId, sidecarConfigDisposition: 'push' }
            : t
        )
      );
      const fbResult = await migrateFloatingBallSessionBinding(oldSessionId, pendingSessionId);
      if (fbResult.migrated) {
        console.log(`[App] Floating ball session binding migrated to pending session: ${oldSessionId} -> ${pendingSessionId}, notified=${fbResult.notified}`);
      }
      console.log(`[App] handleNewSession: Created new Sidecar for pending session ${pendingSessionId}`);
      return true;
    } catch (error) {
      console.error('[App] handleNewSession failed:', error);
      return false;
    }
  }, []);

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, [setActiveTabId]);

  // Clear unread indicator only when the active tab identity changes. Do not key
  // this effect on `tabs`: a hidden-but-active tab marks itself unread when a
  // turn completes, and clearing on that same tabs update erases the Dock/tray
  // badge before the user returns. Window focus still clears through
  // useTrayEvents.onWindowFocused.
  useEffect(() => {
    if (!activeTabId) {
      lastUnreadClearedActiveTabIdRef.current = null;
      return;
    }
    if (lastUnreadClearedActiveTabIdRef.current === activeTabId) return;
    lastUnreadClearedActiveTabIdRef.current = activeTabId;
    clearActiveTabUnread();
  }, [activeTabId, clearActiveTabUnread]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeTabView = activeTab?.view ?? null;
  const activeChatSessionId = activeTab?.view === 'chat' ? activeTab.sessionId ?? null : null;
  useEffect(() => {
    if (!activeChatSessionId || isPendingSessionId(activeChatSessionId)) return;
    acknowledgeNotificationTarget({ type: 'session', sessionId: activeChatSessionId });
  }, [acknowledgeNotificationTarget, activeChatSessionId]);

  useEffect(() => {
    if (activeTabView === 'taskcenter') {
      acknowledgeNotificationTarget({ type: 'task-center' });
    }
  }, [acknowledgeNotificationTarget, activeTabView]);

  // Trackpad two-finger horizontal swipe to switch tabs (follow-along animation)
  useTabSwipeGesture({ contentRef, tabsRef, activeTabIdRef, onSwitchTab: handleSelectTab });

  const handleCloseTab = useCallback((tabId: string) => {
    // Special case: If only one launcher tab, do nothing
    const currentTabs = tabsRef.current;
    const tab = currentTabs.find(t => t.id === tabId);
    if (currentTabs.length === 1 && tab?.view === 'launcher') {
      return;
    }

    void closeTabWithConfirmation(tabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  const handleNewTab = useCallback(() => {
    const currentLength = tabsRef.current.length;
    if (currentLength >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab = createNewTab();
    openNewTabDeferred(newTab);

    // Track tab_new event
    track('tab_new', { tab_count: currentLength + 1 });
  }, [openNewTabDeferred]);

  const handleSidebarNewChat = useCallback(() => {
    const currentTabs = tabsRef.current;
    const leftmostLauncher = currentTabs.find((tab) => tab.view === 'launcher');
    if (leftmostLauncher) {
      setActiveTabId(leftmostLauncher.id, currentTabs);
      return;
    }
    handleNewTab();
  }, [handleNewTab, setActiveTabId]);

  const handleOpenWorkspaceFromSidebar = useCallback(async (
    project: Project,
    initialMessage?: InitialMessage,
    entryIntent: 'open_workspace' | 'workspace_init' = 'open_workspace',
  ): Promise<boolean> => {
    if (tabsRef.current.length >= MAX_TABS) {
      toastRef.current.error(t('appChrome.tabLimitReached'));
      return false;
    }

    const launchTab = createNewTab();
    openLaunchTabNow(launchTab);
    try {
      await handleLaunchProject(project, initialMessage, {
        surface: 'global_sidebar',
        entryIntent,
      });
      return tabsRef.current.some((tab) => tab.id === launchTab.id);
    } catch (error) {
      console.error('[App] Failed to open workspace from global sidebar:', error);
      removeUnusedPrecreatedLaunchTab(launchTab.id);
      return false;
    }
  }, [handleLaunchProject, openLaunchTabNow, removeUnusedPrecreatedLaunchTab, t]);

  // Handle tab reordering via drag and drop
  const handleReorderTabs = useCallback((activeId: string, overId: string) => {
    setTabs((prev) => {
      const oldIndex = prev.findIndex((t) => t.id === activeId);
      const newIndex = prev.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  // Open Settings as a new tab (or switch to existing one)
  // Optional initialSection parameter to open a specific section (e.g., 'providers')
  // Optional initialSelect to open a specific item's detail (skill/command/agent)
  const handleOpenSettings = useCallback(async (initialSection?: string) => {
    // Track settings_open event
    track('settings_open', { section: initialSection ?? null });

    // Set initial section for Settings component
    setSettingsInitialSection(initialSection);

    // Check if there's already a Settings tab
    const currentTabs = tabsRef.current;
    const existingSettingsTab = currentTabs.find((t) => t.view === 'settings');
    if (existingSettingsTab) {
      // Switch to existing Settings tab
      setActiveTabId(existingSettingsTab.id);
      return;
    }

    // Create new Settings tab
    if (currentTabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }

    // Create Tab first (instant UI response). The 5.8k-line Settings subtree
    // is a renderer-only mount with the same click-frame jank as the Launcher,
    // so it goes through the shared deferred-mount path (placeholder this
    // commit → real Settings on a transition render). settingsInitialSection
    // etc. are set urgently above, so Settings reads the right section when it
    // mounts on the transition.
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: 'settings',
      title: t('tabs.settings'),
      sidecarConfigDisposition: 'push',
    };
    openNewTabDeferred(newTab);

    // Global Sidecar is now started on App mount, no need to start here
  }, [openNewTabDeferred, setActiveTabId, t]);

  const handleOpenCapabilities = useCallback((
    initialSection?: CapabilitySection,
    mcpServerId?: string,
    initialSelect?: CapabilityInitialSelect,
    officialToolId?: OfficialToolId,
  ) => {
    const resolvedSection: CapabilitySection = initialSection === 'mcp'
      ? 'mcp'
      : initialSection === 'plugins'
        ? 'plugins'
        : 'skills';
    if (initialSection) {
      setCapabilityInitialSection(resolvedSection);
      setCapabilityNavigationNonce((current) => current + 1);
    }
    setCapabilityInitialMcpId(mcpServerId);
    setCapabilityInitialOfficialToolId(officialToolId);
    setCapabilityInitialSelect(initialSelect);

    const currentTabs = tabsRef.current;
    const existing = currentTabs.find((tab) => tab.view === 'capabilities');
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    if (currentTabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    openNewTabDeferred({
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: 'capabilities',
      title: t('tabs.capabilities'),
      sidecarConfigDisposition: 'push',
    });
    if (!initialSection) setCapabilityInitialSection('skills');
  }, [openNewTabDeferred, setActiveTabId, t]);

  // Listen for OPEN_SETTINGS custom event from child components
  useEffect(() => {
    const handleOpenSettingsEvent = (event: CustomEvent<{
      section?: string;
      mcpServerId?: string;
      officialToolId?: OfficialToolId;
      selectItem?: CapabilityInitialSelect;
    }>) => {
      const section = event.detail?.section;
      if (section === 'skills' || section === 'sub-agents' || section === 'plugins' || section === 'mcp') {
        handleOpenCapabilities(
          section === 'sub-agents' ? 'skills' : section,
          event.detail?.mcpServerId,
          event.detail?.selectItem,
          event.detail?.officialToolId,
        );
        return;
      }
      handleOpenSettings(section);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    };
  }, [handleOpenCapabilities, handleOpenSettings]);

  // Open TaskCenter as a singleton tab (mirrors handleOpenSettings)
  const handleOpenTaskCenter = useCallback(() => {
    const currentTabs = tabsRef.current;
    const sourceTab = currentTabs.find((tab) => tab.id === activeTabIdRef.current);
    if (sourceTab?.view === 'chat') {
      const sourceSessionId = sourceTab.sessionId?.trim();
      setTaskCenterCurrentSessionId(
        sourceSessionId && !isPendingSessionId(sourceSessionId) ? sourceSessionId : null,
      );
    } else if (sourceTab?.view !== 'taskcenter') {
      setTaskCenterCurrentSessionId(null);
    }
    const existing = currentTabs.find((t) => t.view === 'taskcenter');
    if (existing) {
      setActiveTabId(existing.id);
      acknowledgeNotificationTarget({ type: 'task-center' });
      return;
    }
    if (currentTabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: 'taskcenter',
      title: t('tabs.taskCenter'),
      sidecarConfigDisposition: 'push',
    };
    openNewTabDeferred(newTab);
    acknowledgeNotificationTarget({ type: 'task-center' });
  }, [acknowledgeNotificationTarget, openNewTabDeferred, setActiveTabId, t]);

  // Intent carried across `OPEN_TASK_CENTER` — the event dispatcher
  // (Launcher "我的任务" tab's search icon) wants more than just "open
  // the tab": it wants the Task Center's search box focused on arrival.
  // Propagating via a direct `window` listener in TaskListPanel misses
  // the first-mount case (the event fires before the tab exists), so
  // we stash the intent in state here and pass it down as a prop.
  //
  // Intent lifecycle (cross-review C2):
  //   1. Every event overwrites state — including with `null` when the
  //      event carries no focus request. Otherwise a stale intent from
  //      an earlier search path would persist and trigger unexpected
  //      focus when the user later opens Task Center via the titlebar
  //      icon or any other entry.
  //   2. Each intent gets a monotonically-increasing `nonce` (not
  //      `Date.now()`) so back-to-back same-millisecond firings still
  //      produce distinct dep-array values for the consuming effect.
  //      `useRef + ++` is cheap and collision-free.
  const taskCenterIntentCounterRef = useRef(0);
  const [taskCenterPendingIntent, setTaskCenterPendingIntent] = useState<
    { autofocusSearch?: boolean; nonce: number } | null
  >(null);
  const [taskCenterCurrentSessionId, setTaskCenterCurrentSessionId] = useState<string | null>(null);
  const [taskCreateIntent, setTaskCreateIntent] = useState<TaskCreateIntent | null>(null);

  const handleOpenTaskCreate = useCallback((request: TaskCreateRequest) => {
    setTaskCreateIntent({
      ...request,
      id: `task-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }, []);
  const handleSidebarCreateTask = useCallback(() => {
    handleOpenTaskCreate({
      initialMode: 'smart',
      source: 'sidebar',
      currentSessionId: taskCenterCurrentSessionId,
    });
  }, [handleOpenTaskCreate, taskCenterCurrentSessionId]);

  // Listen for OPEN_TASK_CENTER custom event from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { autofocusSearch?: boolean }
        | undefined;
      if (detail?.autofocusSearch) {
        taskCenterIntentCounterRef.current += 1;
        setTaskCenterPendingIntent({
          autofocusSearch: true,
          nonce: taskCenterIntentCounterRef.current,
        });
      } else {
        // Non-focus open (titlebar icon, Chat 新建 dispatch, etc.) —
        // clear any lingering search intent so returning to Task Center
        // doesn't auto-focus the search field unexpectedly.
        setTaskCenterPendingIntent(null);
      }
      handleOpenTaskCenter();
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_TASK_CENTER, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.OPEN_TASK_CENTER, handler);
  }, [handleOpenTaskCenter]);

  useEffect(() => {
    const handler = (raw: Event) => {
      const request = (raw as CustomEvent<TaskCreateRequest>).detail;
      if (!request || !['smart', 'manual'].includes(request.initialMode)) return;
      if (!['sidebar', 'task-center', 'thought'].includes(request.source)) return;
      handleOpenTaskCreate(request);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_TASK_CREATE, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.OPEN_TASK_CREATE, handler);
  }, [handleOpenTaskCreate]);

  const lastNativeAppRouteGenerationRef = useRef(0);
  const openedSpaceRouteGenerationRef = useRef(0);
  const handleOpenAppRoute = useCallback((route: AppRoute, nativeGeneration?: number): boolean => {
    try {
      serializeAppRoute(route);
    } catch {
      toastRef.current.error(t('notificationCenter.routeInvalid'));
      return false;
    }
    if (
      nativeGeneration !== undefined
      && nativeGeneration <= lastNativeAppRouteGenerationRef.current
    ) {
      return true;
    }
    if (route.name === 'task.comment') {
      const currentTabs = tabsRef.current;
      const existing = currentTabs.find((tab) => tab.view === 'taskcenter');
      if (!existing && currentTabs.length >= MAX_TABS) {
        toastRef.current.error(t('appChrome.maxTabsReachedWithCount', { count: MAX_TABS }));
        return false;
      }
      if (nativeGeneration !== undefined) {
        lastNativeAppRouteGenerationRef.current = nativeGeneration;
      }
      appRouteGenerationRef.current += 1;
      setTaskPendingRoute({ generation: appRouteGenerationRef.current, route });
      handleOpenTaskCenter();
      return true;
    }
    if (!spaceBuildCapability.isLoading && !spaceBuildCapability.available) {
      toastRef.current.info(spaceBuildCapability.reason ?? t('titlebar.teamBuildUnavailable'));
      return false;
    }
    const existing = tabsRef.current.find((tab) => tab.view === 'space');
    if (!existing && tabsRef.current.length >= MAX_TABS) {
      toastRef.current.error(t('appChrome.maxTabsReachedWithCount', { count: MAX_TABS }));
      return false;
    }
    if (nativeGeneration !== undefined) {
      lastNativeAppRouteGenerationRef.current = nativeGeneration;
    }
    appRouteGenerationRef.current += 1;
    setSpacePendingRoute({
      generation: appRouteGenerationRef.current,
      route,
    });
    return true;
  }, [handleOpenTaskCenter, spaceBuildCapability.available, spaceBuildCapability.isLoading, spaceBuildCapability.reason, t]);

  useEffect(() => {
    if (!spacePendingRoute || spaceBuildCapability.isLoading) return;
    if (!spaceBuildCapability.available) {
      if (openedSpaceRouteGenerationRef.current < spacePendingRoute.generation) {
        openedSpaceRouteGenerationRef.current = spacePendingRoute.generation;
        toastRef.current.info(spaceBuildCapability.reason ?? t('titlebar.teamBuildUnavailable'));
      }
      setSpacePendingRoute((current) => (
        current?.generation === spacePendingRoute.generation ? null : current
      ));
      return;
    }
    if (openedSpaceRouteGenerationRef.current >= spacePendingRoute.generation) return;
    openedSpaceRouteGenerationRef.current = spacePendingRoute.generation;
    const currentTabs = tabsRef.current;
    const existing = currentTabs.find((tab) => tab.view === 'space');
    if (existing) {
      spaceRouteTabIdRef.current = existing.id;
      setActiveTabId(existing.id);
      return;
    }
    if (currentTabs.length >= MAX_TABS) {
      toastRef.current.error(t('appChrome.maxTabsReachedWithCount', { count: MAX_TABS }));
      setSpacePendingRoute((current) => (
        current?.generation === spacePendingRoute.generation ? null : current
      ));
      return;
    }
    const routeTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    spaceRouteTabIdRef.current = routeTabId;
    openNewTabDeferred({
      id: routeTabId,
      agentDir: null,
      sessionId: null,
      view: 'space',
      title: t('tabs.team'),
      sidecarConfigDisposition: 'push',
    });
  }, [openNewTabDeferred, setActiveTabId, spaceBuildCapability.available, spaceBuildCapability.isLoading, spaceBuildCapability.reason, spacePendingRoute, t]);

  const handleSpaceRouteConsumed = useCallback((generation: number) => {
    setSpacePendingRoute((current) => (
      current?.generation === generation ? null : current
    ));
  }, []);

  const handleTaskRouteConsumed = useCallback((generation: number) => {
    setTaskPendingRoute((current) => (
      current?.generation === generation ? null : current
    ));
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    const drain = async () => {
      try {
        const pending = await tauriInvoke<PendingAppRoute | null>('cmd_take_pending_app_route');
        if (pending && !ac.signal.aborted) {
          handleOpenAppRoute(pending.route, pending.generation);
        }
      } catch (error) {
        console.warn('[AppRoute] Failed to consume native route:', error);
      }
    };
    void drain();
    void listenWithCleanup<number>('app-route:available', () => {
      void drain();
    }, ac.signal);
    return () => ac.abort();
  }, [handleOpenAppRoute]);

  const handleOpenSpace = useCallback(() => {
    if (spaceBuildCapability.isLoading) {
      toastRef.current.info(t('titlebar.teamLoading'));
      return;
    }
    if (!spaceBuildCapability.available) {
      toastRef.current.info(spaceBuildCapability.reason ?? t('titlebar.teamBuildUnavailable'));
      return;
    }
    if (!teamSpaceAvailable) {
      toastRef.current.info(t('titlebar.teamUnavailable'));
      return;
    }
    const currentTabs = tabsRef.current;
    const existing = currentTabs.find((t) => t.view === 'space');
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    if (currentTabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: 'space',
      title: t('tabs.team'),
      sidecarConfigDisposition: 'push',
    };
    openNewTabDeferred(newTab);
  }, [openNewTabDeferred, setActiveTabId, spaceBuildCapability.available, spaceBuildCapability.isLoading, spaceBuildCapability.reason, teamSpaceAvailable, t]);

  useEffect(() => {
    window.addEventListener(CUSTOM_EVENTS.OPEN_SPACE, handleOpenSpace);
    return () => window.removeEventListener(CUSTOM_EVENTS.OPEN_SPACE, handleOpenSpace);
  }, [handleOpenSpace]);


  // All Task discussion entry points converge here. The visible user text is
  // carried after a hidden product reminder, while the exact app-owned Skill
  // contract is admitted again at the moment the first turn is dispatched.
  const handleStartTaskDiscussion = useCallback(async ({
    thoughtId,
    content,
    tags = [],
    workspaceId,
  }: {
    thoughtId?: string;
    content: string;
    tags?: string[];
        /** Explicit workspace pick from the ThoughtCard popover (v0.1.69
         *  polish). When present we use it directly; when absent (old
         *  callers or programmatic triggers) we fall back to the smart
         *  tag→project match so behavior degrades gracefully. */
    workspaceId?: string;
  }): Promise<boolean> => {
      if (!content?.trim()) {
        toastRef.current?.error(t('appChrome.taskDiscussionContentRequired'));
        return false;
      }

      try {
        const currentTabs = tabsRef.current;
        if (currentTabs.length >= MAX_TABS) {
          toastRef.current?.error(t('appChrome.maxTabsReachedWithCount', { count: MAX_TABS }));
          return false;
        }

        const projects = configProjectsRef.current.filter(isProjectVisibleToUser);
        if (projects.length === 0) {
          toastRef.current?.error(t('appChrome.noWorkspaceForDiscussion'));
          return false;
        }
        // Prefer the explicit pick; fall back to smart default for legacy
        // callers / programmatic use.
        const lowerTags = (tags ?? []).map((tag) => tag.toLowerCase());
        const workspace =
          (workspaceId ? projects.find((p) => p.id === workspaceId) : undefined) ??
          projects.find((p) => lowerTags.includes(p.name.toLowerCase())) ??
          projects[0];

        // PRD 0.2.3: 从前端唯一 builtin selection helper 解析出成对的 (provider, model)。
        // 早期实现直接吃 config.defaultProviderId、跳过 workspace/agent 两层，导致
        //   provider = openrouter（全局默认）+ model = claude-opus（agent snapshot）
        // 这种 (provider X, model Y) 错配，触发 API key 验证失败。
        // helper 优先级：agent → workspace → defaultProviderId → first available，
        //   每层 isProviderAvailable 检查；返回的 model 一定 ∈ provider.models。
        const workspaceAgent = workspace.agentId && configRef.current
          ? getAgentById(configRef.current, workspace.agentId)
          : undefined;
        const workspaceRuntime = resolveEffectiveRuntime(
          workspaceAgent?.runtime,
          Boolean(configRef.current?.multiAgentRuntime),
        );
        const sel = workspaceRuntime === 'builtin'
          ? resolveBuiltinSelection(
              { agent: workspaceAgent, workspace },
              configRef.current!,
              appProvidersRef.current,
              appApiKeysRef.current,
              appProviderVerifyStatusRef.current,
            )
          : undefined;
        if (workspaceRuntime === 'builtin' && !sel) {
          toastRef.current?.error(t('appChrome.noModelProviderForDiscussion'));
          return false;
        }

        if (!isTauriEnvironment()) {
          throw new Error('Task discussion requires the desktop Task store');
        }
        const discussionId = `discussion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const prepared = await tauriInvoke<PreparedTaskDiscussion>('cmd_task_prepare_discussion', {
          discussionId,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          sourceThoughtId: thoughtId || undefined,
          sourceThoughtTags: tags ?? [],
        });
        const discussionPrompt = buildTaskDiscussionReminder({
          ...prepared,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          sourceThoughtId: thoughtId || undefined,
          sourceThoughtTags: tags ?? [],
          visibleUserMessage: content,
        });

        const alignmentProviderIntent = sel && isRuntimeBackedProvider(sel.provider)
          ? toProviderExecutionIntent(sel.provider, sel.model)
          : undefined;
        const alignmentProviderExecutionIdentity = alignmentProviderIntent?.kind === 'runtime-backed-provider'
          ? alignmentProviderIntent
          : undefined;
        const alignmentPermissionMode = resolveInitialPermissionMode({
          project: workspace,
          agent: workspaceAgent,
          defaultPermissionMode: configRef.current?.defaultPermissionMode,
        });
        const initialMessage: InitialMessage = {
          text: discussionPrompt,
          requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT,
          ...(alignmentPermissionMode ? { permissionMode: alignmentPermissionMode } : {}),
          ...(alignmentProviderExecutionIdentity
            ? {
                providerExecutionIdentity: alignmentProviderExecutionIdentity,
                runtimeModel: alignmentProviderExecutionIdentity.model,
              }
            : sel
              ? { builtinSelection: { providerId: sel.provider.id, model: sel.model } }
              : {}),
        };

        // Pre-seed the tab as a Chat tab before awaiting sidecar startup.
        // Without this, the user sees the Launcher briefly while
        // handleLaunchProject waits on ensureSessionSidecar, then the tab
        // "jumps" to Chat. createPendingSessionId is deterministic
        // (`pending-<tabId>`), so handleLaunchProject's internal call
        // resolves to the same id and its later setTabs is a no-op for
        // view/agentDir/sessionId.
        const newTab = createNewTab();
        if (initialMessage.providerExecutionIdentity) {
          openLaunchTabNow(newTab);
        } else {
          const seeded = {
            ...newTab,
            view: 'chat' as const,
            agentDir: workspace.path,
            sessionId: createPendingSessionId(newTab.id),
            title: t('appChrome.discussionTabTitle'),
            initialMessage,
          };
          setTabs((prev) => [...prev, seeded]);
          setActiveTabId(newTab.id);
        }

        const launched = await handleLaunchProject(
          workspace,
          initialMessage,
          { surface: 'task_center', entryIntent: 'thought_alignment' },
        );
        if (!launched) return false;

        // handleLaunchProject's internal setTabs overwrites `title` with the
        // workspace display name. Restore the "任务讨论" title afterwards so
        // the tab consistently reads as a discussion session, not the
        // workspace's generic name.
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === newTab.id ? { ...tab, title: t('appChrome.discussionTabTitle') } : tab,
          ),
        );
        return true;
      } catch (err) {
        console.error('[App] OPEN_AI_DISCUSSION failed:', err);
        toastRef.current?.error(
          err instanceof Error ? err.message : t('appChrome.taskDiscussionStartFailed'),
        );
        return false;
      }
  }, [handleLaunchProject, openLaunchTabNow, setActiveTabId, t]);

  const handleCreateDialogDiscussion = useCallback(async (request: TaskDiscussionRequest) => {
    const opened = await handleStartTaskDiscussion({
      thoughtId: request.sourceThoughtId,
      content: request.content,
      tags: request.sourceThoughtTags,
      workspaceId: request.workspaceId,
    });
    if (opened) setTaskCreateIntent(null);
    return opened;
  }, [handleStartTaskDiscussion]);

  useEffect(() => {
    const handler = (raw: Event) => {
      const detail = (raw as CustomEvent<Parameters<typeof handleStartTaskDiscussion>[0]>).detail;
      if (!detail) return;
      void handleStartTaskDiscussion(detail).catch(() => undefined);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, handler);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, handler);
  }, [handleStartTaskDiscussion]);

  // DOM/Tauri ingress adapter for Task, notification, and Companion opens.
  // App's canonical history owner still decides jump / revive / spawn.
  useEffect(() => {
    const handler = async (raw: Event) => {
      const event = raw as CustomEvent<{
        sessionId: string;
        workspacePath: string;
        preview?: { path?: string; initialLineNumber?: number };
        historyEntrySource?: HistoryEntrySource;
      }>;
      const { sessionId, workspacePath, preview, historyEntrySource } = event.detail ?? {};
      if (!sessionId || !workspacePath) return;
      const pendingFilePreview: FilePreviewIntent | undefined = preview?.path
        ? {
          id: `fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          path: preview.path,
          ...(preview.initialLineNumber ? { initialLineNumber: preview.initialLineNumber } : {}),
        }
        : undefined;

      const workspace = configProjectsRef.current.find(
        (p) => workspacePathsEqual(p.path, workspacePath),
      );
      if (!workspace) {
        console.warn(
          '[App] OPEN_SESSION_IN_NEW_TAB workspace not in projects; opening by path:',
          workspacePath,
        );
      }
      await handleOpenTargetSession(
        sessionId,
        workspace?.path ?? workspacePath,
        workspace?.displayName || getFolderName(workspace?.path ?? workspacePath),
        historyEntrySource,
        { pendingFilePreview },
      );
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, handler);
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB,
        handler,
      );
  }, [handleOpenTargetSession]);

  // Listen for JUMP_TO_TAB custom event (Session singleton constraint)
  useEffect(() => {
    const handleJumpToTab = (event: CustomEvent<{ targetTabId: string; sessionId: string }>) => {
      const { targetTabId, sessionId } = event.detail;
      console.log(`[App] Jump to tab ${targetTabId} for session ${sessionId}`);
      // Check if target Tab exists
      const targetTab = tabsRef.current.find(t => t.id === targetTabId);
      if (targetTab) {
        setActiveTabId(targetTabId);
      } else {
        console.warn(`[App] Target tab ${targetTabId} not found, cannot jump`);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.JUMP_TO_TAB, handleJumpToTab as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.JUMP_TO_TAB, handleJumpToTab as EventListener);
    };
  }, [setActiveTabId]);

  // Listen for LAUNCH_BUG_REPORT custom event (AI-powered bug reporting)
  useEffect(() => {
    const handleLaunchBugReport = async (event: CustomEvent<HelperRequestDetail>) => {
      const {
        description,
        appVersion,
        providerId,
        model,
        resumeSessionId,
        assistantEntry,
        scenario = 'support',
      } = event.detail;
      const helperLaunchStartedAt = nowForSpaceMetric();
      try {
        // Existing helper Sessions use the same new/jump/revive owner as every
        // other history surface. The canonical path applies the tab limit only
        // when it actually needs to allocate a Tab.
        if (resumeSessionId) {
          const project = await ensureSelfAwarenessWorkspace(
            configProjectsRef.current,
            configAddProject,
            configPatchProject,
          );
          if (!project) {
            console.error('[App] ensureSelfAwarenessWorkspace returned null');
            return;
          }
          await handleOpenTargetSession(
            resumeSessionId,
            project.path,
            project.displayName || getFolderName(project.path),
            'settings_helper_history',
          );
          return;
        }

        if (tabsRef.current.length >= MAX_TABS) {
          console.warn(`[App] Max tabs (${MAX_TABS}) reached, cannot open bug report`);
          if (scenario === 'space_tool_install') {
            trackSpaceToolMutation({
              operation: 'helper_launch',
              toolKind: 'custom_install_prompt',
              result: 'failure',
              ok: false,
              durationMs: Math.round(nowForSpaceMetric() - helperLaunchStartedAt),
              error: new Error('Maximum tab count reached'),
            });
            toastRef.current?.error(t('appChrome.maxTabsReached'));
          }
          return;
        }

        // Ensure ~/.myagents registered as internal project
        // (CLAUDE.md + skills are synced at startup via cmd_sync_admin_agent)
        const project = await ensureSelfAwarenessWorkspace(
          configProjectsRef.current,
          configAddProject,
          configPatchProject,
        );
        if (!project) {
          console.error('[App] ensureSelfAwarenessWorkspace returned null');
          if (scenario === 'space_tool_install') {
            trackSpaceToolMutation({
              operation: 'helper_launch',
              toolKind: 'custom_install_prompt',
              result: 'failure',
              ok: false,
              durationMs: Math.round(nowForSpaceMetric() - helperLaunchStartedAt),
              error: new Error('Helper workspace unavailable'),
            });
            toastRef.current?.error(t('space.tools.helperLaunchFailed'));
          }
          return;
        }

        // Two paths to a paired (provider, model):
        //   A. Explicit picker (BugReportOverlay): caller supplied (providerId, model)
        //      and the provider is still available — honor via pairBuiltinSelection.
        //   B. Implicit (Chat error banner / Settings mcp dialog) OR explicit-but-
        //      provider-unavailable: resolve via priority chain
        //      (helperAgent → helperProject → defaultProviderId → first available),
        //      each layer guarded by isProviderAvailable.
        // Always pass an explicit execution identity (when any provider is available)
        // so Chat tab autoSend doesn't race against the invalid-model correction
        // useEffect when helper Agent's persisted (provider, model) has gone stale.
        const helperAgent = project.agentId && configRef.current
          ? getAgentById(configRef.current, project.agentId)
          : undefined;
        let builtinSelection: { providerId: string; model: string } | undefined;
        let providerExecutionIdentity: RuntimeBackedProviderIdentity | undefined;
        if (providerId) {
          const provider = appProvidersRef.current.find(p => p.id === providerId);
          if (provider && isProviderAvailable(
            provider,
            appApiKeysRef.current,
            appProviderVerifyStatusRef.current,
          )) {
            const targetModel = model ?? provider.primaryModel;
            if (isRuntimeBackedProvider(provider)) {
              const intent = toProviderExecutionIntent(provider, targetModel);
              if (intent.kind === 'runtime-backed-provider') {
                providerExecutionIdentity = intent;
              }
            } else {
              builtinSelection = pairBuiltinSelection(provider, model);
            }
          }
        }
        if (!builtinSelection && !providerExecutionIdentity) {
          const sel = resolveBuiltinSelection(
            { agent: helperAgent, workspace: project },
            configRef.current!,
            appProvidersRef.current,
            appApiKeysRef.current,
            appProviderVerifyStatusRef.current,
          );
          if (sel) {
            if (isRuntimeBackedProvider(sel.provider)) {
              const intent = toProviderExecutionIntent(sel.provider, sel.model);
              if (intent.kind === 'runtime-backed-provider') {
                providerExecutionIdentity = intent;
              }
            } else {
              builtinSelection = { providerId: sel.provider.id, model: sel.model };
            }
          }
          // else: no provider available system-wide — let Chat tab show its
          // empty-state guidance ("请先设置模型服务").
        }
        const helperPermissionMode = resolveInitialPermissionMode({
          project,
          agent: helperAgent,
          defaultPermissionMode: configRef.current?.defaultPermissionMode,
        });

        const initialMessage: InitialMessage = {
          text: scenario === 'space_tool_install'
            ? description
            : buildSupportPrompt(description, appVersion ?? ''),
          ...(helperPermissionMode ? { permissionMode: helperPermissionMode } : {}),
          ...(builtinSelection ? { builtinSelection } : {}),
          ...(providerExecutionIdentity ? {
            providerExecutionIdentity,
            runtimeModel: providerExecutionIdentity.model,
          } : {}),
          images: event.detail.images,
        };

        const newTab = createNewTab();
        openLaunchTabNow(newTab);

        try {
          const launched = await handleLaunchProject(
            project,
            initialMessage,
            scenario === 'space_tool_install'
              ? {
                  surface: 'space_tools',
                  entryIntent: 'tool_install',
                  assistantEntry: 'space_tool_install',
                }
              : {
                  surface: 'bug_report',
                  entryIntent: 'support_diagnostics',
                  assistantEntry: assistantEntry ?? 'other',
                },
          );
          if (!launched) {
            throw new Error('Helper Session failed to start');
          }
          if (scenario === 'space_tool_install') {
            trackSpaceToolMutation({
              operation: 'helper_launch',
              toolKind: 'custom_install_prompt',
              result: 'success',
              ok: true,
              durationMs: Math.round(nowForSpaceMetric() - helperLaunchStartedAt),
            });
          }

          // Override tab title
          setTabs((prev) =>
            prev.map((tab) =>
              tab.id === newTab.id
                ? {
                    ...tab,
                    title: scenario === 'space_tool_install'
                      ? t('space.tools.installSessionTitle')
                      : t('appChrome.diagnosticsTabTitle'),
                  }
                : tab
            )
          );
        } finally {
          removeUnusedPrecreatedLaunchTab(newTab.id);
        }
      } catch (err) {
        if (scenario === 'space_tool_install') {
          trackSpaceToolMutation({
            operation: 'helper_launch',
            toolKind: 'custom_install_prompt',
            result: 'failure',
            ok: false,
            durationMs: Math.round(nowForSpaceMetric() - helperLaunchStartedAt),
            error: err,
          });
          toastRef.current?.error(t('space.tools.helperLaunchFailed'));
        }
        console.error('[App] Failed to launch bug report:', err);
      }
    };
    const listener = ((e: Event) => { void handleLaunchBugReport(e as CustomEvent); }) as EventListener;
    window.addEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via refs, configAdd/patchProject are stable useCallbacks
  }, [configAddProject, configPatchProject, t]);

  // Stable callback for Settings onSectionChange — avoids inline arrow creating new ref every render
  const handleSettingsSectionChange = useCallback(() => {
    setSettingsInitialSection(undefined);
  }, []);

  const handleCapabilitySectionChange = useCallback(() => {
    setCapabilityInitialMcpId(undefined);
    setCapabilityInitialOfficialToolId(undefined);
    setCapabilityInitialSelect(undefined);
  }, []);

  const handleOpenGeneralSettings = useCallback(() => {
    void handleOpenSettings('general');
  }, [handleOpenSettings]);

  const handleOpenBugReport = useCallback(() => setShowBugReport(true), []);

  const handleOpenSidebarSession = useCallback((session: SessionMetadata, project: Project) => (
    handleOpenTargetSession(
      session.id,
      project.path,
      getSessionDisplayText(session),
      'global_sidebar',
    )
  ), [handleOpenTargetSession]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const releaseTransition = tryClaimSessionResourceTransition(
      sessionResourceTransitionsRef.current,
      sessionId,
      'deleting',
    );
    if (!releaseTransition) {
      return { deleted: false as const, reason: 'transition-in-progress' as const };
    }

    try {
      return await deleteSessionThroughAppOwner({
        sessionId,
        getTabs: () => tabsRef.current,
        terminateTabsForSession: (targetSessionId) => {
          for (const tab of tabsRef.current) {
            if (tab.view === 'chat' && tab.sessionId === targetSessionId) {
              clearPendingSessionBirth(tab.id);
            }
          }
          setTabs((current) => [...applyTerminalSessionToTabs(current, targetSessionId)]);
        },
        hasPersistentOwners: querySessionHasPersistentOwners,
        handoffMountedSessionActivity: startBackgroundCompletionForDeletion,
        stopSseProxy,
        deletePersistedSession: (targetSessionId, releasableTabIds) => (
          taskCenterActions.deleteSession(targetSessionId, releasableTabIds)
        ),
      });
    } finally {
      releaseTransition();
    }
  }, []);

  // System tray event handling (minimize to tray, exit confirmation)
  useTrayEvents({
    minimizeToTray: config.minimizeToTray,
    onOpenSettings: () => handleOpenSettings('general'),
    onCmdWCloseTab: () => {
      // Cmd+W bottom: overlay → split → tab → launcher → STOP.
      closeCurrentTab(); // Last tab auto-creates launcher; launcher is a no-op.
    },
    onWindowFocusChanged: setIsWindowFocused,
    onWindowFocused: handleWindowFocused,
    onExitRequested: async () => {
      // User-owned scheduler lifecycle is authoritative here. Ordinary Cron
      // lists intentionally exclude Goal and cannot protect app exit.
      try {
        const lifecycle = await getUserSchedulerLifecycleSnapshot();

        if (lifecycle.runningTaskCount > 0) {
          // Show confirmation dialog
          return new Promise<boolean>((resolve) => {
            setExitConfirmState({
              runningTaskCount: lifecycle.runningTaskCount,
              resolve,
            });
          });
        }
      } catch (error) {
        // Exit is destructive to in-flight output. Unknown lifecycle state is
        // fail-closed and asks for confirmation instead of silently quitting.
        console.error('[App] Failed to check scheduler lifecycle:', error);
        return new Promise<boolean>((resolve) => {
          setExitConfirmState({ runningTaskCount: 1, resolve });
        });
      }

      // No running tasks, allow exit
      return true;
    },
  });

  // Listen for notification clicks. Rust emits this from exact native
  // per-toast callbacks on Windows, macOS, and Linux. All converge here so
  // routing has one entry point. Chat completion toasts
  // usually carry a tabId and can jump directly; cron/background toasts carry
  // sessionId + workspacePath so they can open a session even when no Tab exists.
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    void listenWithCleanup<{ tabId?: string; sessionId?: string; workspacePath?: string }>(
      'notification:click',
      (event) => {
        const route = resolveNotificationClickRoute(event.payload, (tabId, sessionId) => {
          const tab = tabsRef.current.find((t) => t.id === tabId);
          if (!tab) return false;
          return !sessionId || tab.sessionId === sessionId;
        });
        if (route.type === 'select-tab') {
          console.log('[App] notification:click → handleSelectTab', route.tabId);
          if (route.sessionId) {
            acknowledgeNotificationTarget({ type: 'session', sessionId: route.sessionId });
          }
          handleSelectTab(route.tabId);
          updateTabUnread(route.tabId, false);
          return;
        }

        if (route.type === 'open-session') {
          console.log('[App] notification:click → open session', route.sessionId);
          window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
              detail: {
                sessionId: route.sessionId,
                workspacePath: route.workspacePath,
              },
            }),
          );
          return;
        }

        console.warn(
          '[App] notification:click without routable target:',
          event.payload,
        );
      },
      ac.signal,
    );
    return () => ac.abort();
  }, [acknowledgeNotificationTarget, handleSelectTab, updateTabUnread]);

  const activeWorkspacePath = resolveGlobalSidebarWorkspace(activeTab);

  return (
    <SessionDeletionContext.Provider value={handleDeleteSession}>
    <LinkContextMenuProvider>
    <div className="flex h-screen bg-[var(--paper)]">
      <GlobalSidebar
        tabs={tabs}
        activeTab={activeTab}
        activeWorkspacePath={activeWorkspacePath}
        sessionNotificationBadgeCounts={sessionNotificationBadgeCounts}
        teamSpaceAvailable={teamSpaceAvailable}
        onNewTab={handleSidebarNewChat}
        onOpenTaskCenter={handleOpenTaskCenter}
        onCreateTask={handleSidebarCreateTask}
        onOpenSpace={handleOpenSpace}
        onOpenAppRoute={handleOpenAppRoute}
        onOpenCapabilities={handleOpenCapabilities}
        onOpenSettings={handleOpenGeneralSettings}
        onOpenBugReport={handleOpenBugReport}
        onOpenWorkspace={handleOpenWorkspaceFromSidebar}
        onOpenSession={handleOpenSidebarSession}
      />
      <div className="flex min-w-0 flex-1 flex-col" data-tab-workspace>
      {/* Chrome-style titlebar with tabs */}
      <CustomTitleBar
        updateReady={updateReady}
        updateVersion={updateVersion}
        updateInstalling={updateInstalling}
        updatePreparing={updatePreparing}
        onRestartAndUpdate={() => void handleRestartAndUpdate()}
        restoreCount={restorePillCount}
        onRestoreSession={handleRestoreLastSession}
        onDismissRestore={handleDismissRestore}
      >
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
          onReorderTabs={handleReorderTabs}
        />
      </CustomTitleBar>

      {/* Tab content - only Chat views need TabProvider for sidecar communication */}
      <div ref={contentRef} className="relative flex-1 overflow-hidden" data-tab-content-workspace>
        {tabs.map((tab) => (
          <MemoizedTabContent
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            isWindowFocused={isWindowFocused}
            isLoading={loadingTabs[tab.id] ?? false}
            error={tabErrors[tab.id] ?? null}
            isDeferredMount={deferredMountTabIds.has(tab.id)}
            onLauncherWorkspaceSelectionChange={handleLauncherWorkspaceSelectionChange}
            settingsInitialSection={tab.view === 'settings' ? settingsInitialSection : undefined}
            capabilityInitialSection={capabilityInitialSection}
            capabilityNavigationNonce={capabilityNavigationNonce}
            capabilityInitialMcpId={tab.view === 'capabilities' ? capabilityInitialMcpId : undefined}
            capabilityInitialOfficialToolId={tab.view === 'capabilities' ? capabilityInitialOfficialToolId : undefined}
            capabilityInitialSelect={tab.view === 'capabilities' ? capabilityInitialSelect : undefined}
            onSettingsSectionChange={tab.view === 'capabilities' ? handleCapabilitySectionChange : handleSettingsSectionChange}
            updateReady={updateReady}
            updateVersion={updateVersion}
            updateChecking={updateChecking}
            updateDownloading={updateDownloading}
            updateInstalling={updateInstalling}
            updatePreparing={updatePreparing}
            onCheckForUpdate={checkForUpdate}
            onRestartAndUpdate={handleRestartAndUpdate}
            onLaunchProject={handleLaunchProject}
            onOpenHistorySession={handleOpenChatHistorySession}
            onNewSession={handleNewSession}
            onLaunchRuntimeBackedProviderSession={handleLaunchRuntimeBackedProviderSession}
            onUpdateGenerating={updateTabGenerating}
            onUpdateTitle={updateTabTitle}
            onUpdateUnread={updateTabUnread}
            onRenameSession={handleRenameSession}
            onForkSession={handleForkSession}
            onUpdateSessionId={updateTabSessionId}
            claimSessionOpeningTransition={claimSessionOpeningTransition}
            onClearInitialMessage={clearInitialMessage}
            onSidecarConfigAdopted={markSidecarConfigAdopted}
            onFilePreviewIntentConsumed={handleFilePreviewIntentConsumed}
            sessionNotificationBadgeCounts={tab.id === activeTabId ? sessionNotificationBadgeCounts : undefined}
            taskCenterPendingIntent={taskCenterPendingIntent}
            taskCenterCurrentSessionId={taskCenterCurrentSessionId}
            taskPendingRoute={tab.view === 'taskcenter' ? taskPendingRoute : null}
            onTaskRouteConsumed={handleTaskRouteConsumed}
            spacePendingRoute={tab.view === 'space' ? spacePendingRoute : null}
            onSpaceRouteConsumed={handleSpaceRouteConsumed}
          />
        ))}
      </div>
      </div>

      {taskCreateIntent && (
        <DispatchTaskDialog
          key={taskCreateIntent.id}
          thought={taskCreateIntent.thought}
          defaultWorkspacePath={taskCreateIntent.defaultWorkspacePath}
          currentSessionId={taskCreateIntent.currentSessionId ?? null}
          initialMode={taskCreateIntent.initialMode}
          onClose={() => setTaskCreateIntent(null)}
          onDiscuss={handleCreateDialogDiscussion}
          onDispatched={(created) => {
            track('task_create', {
              source: 'desktop',
              origin: taskCreateIntent.source,
              has_workspace: !!created.workspacePath,
            });
            setTaskCreateIntent(null);
          }}
        />
      )}

      {/* Exit confirmation dialog for running cron tasks */}
      {exitConfirmState && (
        <ConfirmDialog
          title={t('appChrome.exitAppTitle')}
          message={t('appChrome.exitRunningTasksMessage', { count: exitConfirmState.runningTaskCount })}
          confirmText={t('appChrome.exit')}
          cancelText={t('appChrome.cancel')}
          confirmVariant="danger"
          onConfirm={() => {
            exitConfirmState.resolve(true);
            setExitConfirmState(null);
          }}
          onCancel={() => {
            exitConfirmState.resolve(false);
            setExitConfirmState(null);
          }}
        />
      )}

      {/* Windows: startup dialog for pending update from previous session.
          Hidden while a silent download is replacing the pending bytes —
          confirming "安装" mid-replacement could land on inconsistent
          cache/disk state. Comes back into view automatically when the
          download completes (the dialog reads pendingUpdateOnStartup, which
          is unchanged; only the visibility gate is `updatePreparing`). */}
      {pendingUpdateOnStartup && !updatePreparing && (
        <ConfirmDialog
          title={t('appChrome.newVersionTitle')}
          message={t('appChrome.newVersionMessage', { version: pendingUpdateOnStartup })}
          confirmText={t('appChrome.install')}
          cancelText={t('appChrome.later')}
          confirmVariant="primary"
          onConfirm={() => {
            dismissPendingUpdate();
            // Route through handleRestartAndUpdate so toast feedback fires
            // on failure modes (network error / version mismatch).
            void handleRestartAndUpdate();
          }}
          onCancel={dismissPendingUpdate}
        />
      )}

      {/* Bug report overlay triggered from titlebar feedback button */}
      {showBugReport && (
        <BugReportOverlay
          onClose={() => setShowBugReport(false)}
          onNavigateToProviders={() => { setShowBugReport(false); handleOpenSettings('providers'); }}
          appVersion={appVersion}
          providers={appProviders}
          apiKeys={appApiKeys}
          providerVerifyStatus={appProviderVerifyStatus}
          initialProviderId={helperAgentDefaults.initialProviderId}
          initialModel={helperAgentDefaults.initialModel}
          onModelChange={helperAgentDefaults.onModelChange}
          assistantEntry="tab_top"
        />
      )}
    </div>
    </LinkContextMenuProvider>
    </SessionDeletionContext.Provider>
  );
}
