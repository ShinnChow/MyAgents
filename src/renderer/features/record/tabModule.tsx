import { lazy, memo, Suspense } from 'react';

import type { RecordTab } from '@/features/record/tabContract';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';
import { recordingSnapshotFromTab, recordingTabProjection } from '@/features/record/tabProjection';
import type { RecordingSnapshot } from '@/../shared/types/record';
import { recordTabPersistenceCodec, type PersistedRecordTab } from '@/features/record/tabPersistence';

const RecordDetail = lazy(() => import('@/pages/RecordDetail'));

export interface RecordOpenIntent {
  recordId: string;
  title: string;
  snapshot?: RecordingSnapshot;
  mediaMs?: number;
}

export interface RecordRenderBinding {
  onRecordingSnapshotChange: (recordId: string, snapshot: RecordingSnapshot | null) => void;
  registerPendingNoteSubmitter?: (recordId: string, submit: () => Promise<boolean>) => () => void;
  onTitleChange: (recordId: string, title: string) => void;
  onDeleted: (tabId: string) => void;
}

const RecordTabRenderer = memo(function RecordTabRenderer({
  tab,
  isActive,
  isDeferred,
  binding,
}: {
  tab: RecordTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: RecordRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <RecordDetail
        recordId={tab.recordId}
        isActive={isActive}
        seekMediaMs={tab.recordSeekMediaMs}
        seekNonce={tab.recordSeekNonce}
        initialRecordingSnapshot={recordingSnapshotFromTab(tab) ?? undefined}
        onRecordingSnapshotChange={(snapshot) => binding.onRecordingSnapshotChange(tab.recordId, snapshot)}
        registerPendingNoteSubmitter={binding.registerPendingNoteSubmitter}
        onTitleChange={(title) => binding.onTitleChange(tab.recordId, title)}
        onDeleted={() => binding.onDeleted(tab.id)}
      />
    </Suspense>
  );
});

export const recordTabModule = {
  kind: 'record',
  render: RecordTabRenderer,
  chrome: (tab, { t }) => {
    const recording = tab.recordingStatus === 'recording' || tab.recordingStatus === 'paused';
    const seconds = Math.max(0, Math.floor((tab.recordingMediaDurationMs ?? 0) / 1_000));
    const clock = `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    return {
      title: recording ? t('tabs.recordingTime', { time: clock }) : tab.title,
      subtitle: t('tabs.record'),
      recordingState:
        tab.recordingStatus === 'recording' || tab.recordingStatus === 'paused' ? tab.recordingStatus : undefined,
    };
  },
  identity: (tab) => tab.recordId,
  open: {
    findExisting: (tabs, intent) => tabs.find((tab) => tab.recordId === intent.recordId),
    create: (intent, { id }) => ({
      id,
      view: 'record',
      title: intent.title,
      recordId: intent.recordId,
      ...(intent.snapshot ? recordingTabProjection(intent.snapshot) : {}),
      ...(intent.mediaMs !== undefined ? { recordSeekMediaMs: intent.mediaMs, recordSeekNonce: 1 } : {}),
    }),
    reopen: (tab, intent) => ({
      ...tab,
      ...(intent.snapshot ? recordingTabProjection(intent.snapshot) : {}),
      ...(intent.mediaMs !== undefined
        ? {
            recordSeekMediaMs: intent.mediaMs,
            recordSeekNonce: (tab.recordSeekNonce ?? 0) + 1,
          }
        : {}),
    }),
  },
  initialMount: () => 'deferred-content',
  persistence: recordTabPersistenceCodec,
} satisfies TabModuleDefinition<RecordTab, RecordOpenIntent, RecordRenderBinding, PersistedRecordTab>;
