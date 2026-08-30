import { lazy, memo, Suspense } from 'react';

import type { TaskCenterSearchIntent, TaskCenterTab } from '@/features/task-center/tabContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';
import type { PendingAppRoute } from '@/../shared/appRoute';
import type { RecordingSnapshot, RecordingSourceSelection } from '@/../shared/types/record';

const TaskCenter = lazy(() => import('@/pages/TaskCenter'));

export interface TaskCenterOpenIntent {
  title: string;
  searchIntent?: TaskCenterSearchIntent;
  clearSearchIntent?: boolean;
  routeIntent?: PendingAppRoute;
  updateCurrentSession?: boolean;
  currentSessionId?: string | null;
}

export interface TaskCenterRenderBinding {
  activeRecordingSnapshot: RecordingSnapshot | null;
  onStartRecording: (tabId: string, selection: RecordingSourceSelection) => Promise<void>;
  onOpenRecord: (recordId: string, mediaMs?: number, activeRecording?: boolean) => void;
  onSearchIntentConsumed: (tabId: string, generation: number) => void;
  onRouteConsumed: (tabId: string, generation: number) => void;
}

const TaskCenterTabRenderer = memo(function TaskCenterTabRenderer({
  tab,
  isActive,
  isDeferred,
  binding,
}: {
  tab: TaskCenterTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: TaskCenterRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <TaskCenter
        isActive={isActive}
        pendingIntent={
          tab.searchIntent
            ? {
                autofocusSearch: true,
                nonce: tab.searchIntent.generation,
                consumed: tab.searchIntent.consumed,
              }
            : null
        }
        onSearchIntentConsumed={(generation) => binding.onSearchIntentConsumed(tab.id, generation)}
        currentSessionId={tab.currentSessionId}
        pendingRoute={tab.routeIntent ?? null}
        onRouteConsumed={(generation) => binding.onRouteConsumed(tab.id, generation)}
        activeRecordingSnapshot={binding.activeRecordingSnapshot}
        onStartRecording={(selection) => binding.onStartRecording(tab.id, selection)}
        onOpenRecord={binding.onOpenRecord}
      />
    </Suspense>
  );
});

export const taskCenterTabModule = {
  kind: 'taskcenter',
  render: TaskCenterTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t('tabs.taskCenter'),
    subtitle: t('tabs.taskCenter'),
  }),
  identity: () => 'taskcenter',
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: 'taskcenter',
      title: intent.title,
      ...(intent.searchIntent ? { searchIntent: intent.searchIntent } : {}),
      ...(intent.routeIntent ? { routeIntent: intent.routeIntent } : {}),
      ...(intent.updateCurrentSession ? { currentSessionId: intent.currentSessionId ?? null } : {}),
    }),
    reopen: (tab, intent) => ({
      ...tab,
      ...(intent.clearSearchIntent
        ? { searchIntent: undefined }
        : intent.searchIntent
          ? { searchIntent: intent.searchIntent }
          : {}),
      ...(intent.routeIntent ? { routeIntent: intent.routeIntent } : {}),
      ...(intent.updateCurrentSession ? { currentSessionId: intent.currentSessionId ?? null } : {}),
    }),
  },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<TaskCenterTab, TaskCenterOpenIntent, TaskCenterRenderBinding>;
