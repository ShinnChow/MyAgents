import { lazy, memo, Suspense } from 'react';

import ChatBootOverlay from '@/components/ChatBootOverlay';
import TabProvider from '@/context/TabProvider';
import type { AdoptMigratedSessionOptions } from '@/context/TabContext';
import type { Project } from '@/config/types';
import type {
  ChatTab,
  FilePreviewIntent,
  InitialMessage,
  LaunchSessionBirthHint,
  SidecarConfigDisposition,
} from '@/features/chat/tabContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import type { MainWindowPresentation } from '@/utils/mainWindowPresentation';
import type { HistoryEntrySource } from '@/analytics';
import type { RuntimeBackedProviderIdentity } from '@/../shared/providerExecution';
import { chatTabPersistenceCodec, type PersistedChatTab } from '@/features/chat/tabPersistence';

const Chat = lazy(() => import('@/pages/Chat'));

function getWorkspaceName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

export interface ChatOpenIntent {
  agentDir: string;
  sessionId: string;
  title: string;
  sidecarConfigDisposition: SidecarConfigDisposition;
  initialMessage?: InitialMessage;
  pendingFilePreview?: FilePreviewIntent;
}

export interface ChatRenderBinding {
  windowPresentation: MainWindowPresentation;
  onOpenHistorySession: (
    tabId: string,
    sessionId: string,
    title: string,
    historyEntrySource?: HistoryEntrySource,
  ) => Promise<void>;
  onNewSession: (tabId: string) => Promise<boolean>;
  onLaunchRuntimeBackedProviderSession: (
    project: Project,
    sessionBirthHint: LaunchSessionBirthHint & {
      providerExecutionIdentity: RuntimeBackedProviderIdentity;
    },
    title: string,
  ) => Promise<string | null>;
  onUpdateGenerating: (tabId: string, isGenerating: boolean) => void;
  onUpdateTitle: (tabId: string, title: string) => void;
  onUpdateUnread: (tabId: string, hasUnread: boolean) => void;
  onRenameSession: (tabId: string, newTitle: string) => void;
  onForkSession: (
    tabId: string,
    newSessionId: string,
    agentDir: string,
    title: string,
    initialMessage?: string,
  ) => Promise<boolean>;
  onUpdateSessionId: (tabId: string, newSessionId: string, options?: AdoptMigratedSessionOptions) => Promise<boolean>;
  claimSessionOpeningTransition: (sessionId: string, ownerId: string) => (() => void) | null;
  onClearInitialMessage: (tabId: string) => void;
  onSidecarConfigAdopted: (tabId: string) => void;
  onFilePreviewIntentConsumed: (tabId: string, intentId: string) => void;
  sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
}

const ChatTabRenderer = memo(function ChatTabRenderer({
  tab,
  isActive,
  isDeferred,
  binding,
}: {
  tab: ChatTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: ChatRenderBinding;
}) {
  return (
    <TabProvider
      tabId={tab.id}
      agentDir={tab.agentDir}
      sessionId={tab.sessionId}
      sessionTitle={tab.title}
      isActive={isActive}
      onGeneratingChange={(isGenerating) => binding.onUpdateGenerating(tab.id, isGenerating)}
      onTitleChange={(title) => binding.onUpdateTitle(tab.id, title)}
      onUnreadChange={(hasUnread) => binding.onUpdateUnread(tab.id, hasUnread)}
      onSessionIdChange={(newSessionId, options) => binding.onUpdateSessionId(tab.id, newSessionId, options)}
      claimSessionOpeningTransition={(sessionId) => binding.claimSessionOpeningTransition(sessionId, tab.id)}
    >
      {isDeferred ? (
        <ChatBootOverlay />
      ) : (
        <Suspense fallback={<ChatBootOverlay />}>
          <Chat
            windowPresentation={binding.windowPresentation}
            onOpenSession={(sessionId, title, source) => binding.onOpenHistorySession(tab.id, sessionId, title, source)}
            onOpenSessionInNewTab={(sessionId, title) =>
              binding.onOpenHistorySession(tab.id, sessionId, title, 'chat_dropdown_new_tab')
            }
            onNewSession={() => binding.onNewSession(tab.id)}
            onLaunchRuntimeBackedProviderSession={binding.onLaunchRuntimeBackedProviderSession}
            initialMessage={tab.initialMessage}
            onInitialMessageConsumed={() => binding.onClearInitialMessage(tab.id)}
            sidecarConfigDisposition={tab.sidecarConfigDisposition}
            onSidecarConfigAdopted={() => binding.onSidecarConfigAdopted(tab.id)}
            pendingFilePreview={tab.pendingFilePreview}
            onFilePreviewIntentConsumed={(intentId) => binding.onFilePreviewIntentConsumed(tab.id, intentId)}
            sessionTitle={tab.title}
            onRenameSession={(title) => binding.onRenameSession(tab.id, title)}
            onForkSession={(sessionId, agentDir, title, initialMessage) =>
              binding.onForkSession(tab.id, sessionId, agentDir, title, initialMessage)
            }
            sessionNotificationBadgeCounts={binding.sessionNotificationBadgeCounts}
          />
        </Suspense>
      )}
    </TabProvider>
  );
});

export const chatTabModule = {
  kind: 'chat',
  render: ChatTabRenderer,
  chrome: (tab) => {
    const workspace = getWorkspaceName(tab.agentDir);
    const hasSessionTitle = !!tab.title && tab.title !== 'New Tab' && tab.title !== 'New Chat';
    return {
      title: hasSessionTitle ? tab.title : workspace || tab.title,
      subtitle: workspace,
      contextualSubtitle: hasSessionTitle,
      isGenerating: tab.isGenerating,
      hasUnread: tab.hasUnread,
    };
  },
  identity: (tab) => `${tab.sessionId ?? ''}\n${tab.agentDir}`,
  open: {
    findExisting: (tabs, intent) => tabs.find((tab) => tab.sessionId !== null && tab.sessionId === intent.sessionId),
    create: (intent, { id }) => ({
      id,
      view: 'chat',
      title: intent.title,
      agentDir: intent.agentDir,
      sessionId: intent.sessionId,
      sidecarConfigDisposition: intent.sidecarConfigDisposition,
      ...(intent.initialMessage ? { initialMessage: intent.initialMessage } : {}),
      ...(intent.pendingFilePreview ? { pendingFilePreview: intent.pendingFilePreview } : {}),
    }),
    reopen: (tab, intent) => ({
      ...tab,
      ...(intent.pendingFilePreview ? { pendingFilePreview: intent.pendingFilePreview } : {}),
    }),
  },
  initialMount: ({ source }) => (source === 'restore' ? 'deferred-content' : 'immediate'),
  persistence: chatTabPersistenceCodec,
} satisfies TabModuleDefinition<ChatTab, ChatOpenIntent, ChatRenderBinding, PersistedChatTab>;
