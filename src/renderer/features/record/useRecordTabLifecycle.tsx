import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import ConfirmDialog from '@/components/ConfirmDialog';
import type { RecordTab } from '@/features/record/tabContract';
import type { TabCloseAdmission, TabLifecycleAdapter } from '@/tab-workspace/useTabCloseController';
import type { RecordingSnapshot } from '@/../shared/types/record';

interface RecordLifecycleDependencies {
  isAdmissionPending: (tabId: string) => boolean;
  getRecordingSnapshot: () => Promise<RecordingSnapshot | null>;
  stopRecording: (snapshot: RecordingSnapshot) => Promise<unknown>;
  flushPendingNote: (recordId: string) => Promise<boolean>;
  showStatusError: () => void;
  showStopError: () => void;
  labels: {
    title: string;
    message: string;
    confirm: string;
    cancel: string;
  };
  log: (message: string, error?: unknown) => void;
}

interface ConfirmationState {
  tab: RecordTab;
  snapshot: RecordingSnapshot;
  loading: boolean;
  resolve: (result: TabCloseAdmission) => void;
}

export type RecordTabCloseReason = 'user' | 'record-deleted';

export function useRecordTabLifecycle(dependencies: RecordLifecycleDependencies): {
  adapter: TabLifecycleAdapter<RecordTab, RecordTabCloseReason>;
  dialog: ReactNode;
} {
  const dependenciesRef = useRef(dependencies);
  useEffect(() => {
    dependenciesRef.current = dependencies;
  }, [dependencies]);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const confirmationRef = useRef(confirmation);
  useEffect(() => {
    confirmationRef.current = confirmation;
  }, [confirmation]);

  useEffect(() => () => confirmationRef.current?.resolve('blocked'), []);

  const prepareClose = useCallback(
    async (tab: RecordTab, reason: RecordTabCloseReason): Promise<TabCloseAdmission> => {
      const { isAdmissionPending, getRecordingSnapshot, showStatusError, log } = dependenciesRef.current;
      if (reason === 'record-deleted') return 'allow';
      if (isAdmissionPending(tab.id)) return 'blocked';
      let active: RecordingSnapshot | null;
      try {
        active = await getRecordingSnapshot();
      } catch (error) {
        log('[App] Failed to verify recording before closing Record tab', error);
        showStatusError();
        return 'blocked';
      }
      if (active?.recordId !== tab.recordId) return 'allow';
      return new Promise<TabCloseAdmission>((resolve) => {
        setConfirmation({ tab, snapshot: active, loading: false, resolve });
      });
    },
    [],
  );

  const settle = useCallback((result: TabCloseAdmission) => {
    const current = confirmationRef.current;
    if (!current) return;
    setConfirmation(null);
    current.resolve(result);
  }, []);

  const confirm = useCallback(() => {
    const pending = confirmationRef.current;
    if (!pending || pending.loading) return;
    const { flushPendingNote, stopRecording, getRecordingSnapshot, showStopError, log } = dependenciesRef.current;
    setConfirmation({ ...pending, loading: true });
    void flushPendingNote(pending.snapshot.recordId)
      .then(async (saved) => {
        if (!saved) {
          setConfirmation((current) => (current ? { ...current, loading: false } : current));
          return;
        }
        try {
          await stopRecording(pending.snapshot);
          settle('allow');
        } catch (error) {
          log('[App] Failed to stop recording before closing tab', error);
          let active: RecordingSnapshot | null = null;
          let queryFailed = false;
          try {
            active = await getRecordingSnapshot();
          } catch {
            queryFailed = true;
          }
          showStopError();
          if (!queryFailed && active?.recordId !== pending.snapshot.recordId) {
            settle('allow');
            return;
          }
          setConfirmation((current) =>
            current
              ? {
                  ...current,
                  snapshot: active?.recordId === pending.snapshot.recordId ? active : current.snapshot,
                  loading: false,
                }
              : current,
          );
        }
      })
      .catch((error) => {
        log('[App] Failed to flush pending Record note before close', error);
        setConfirmation((current) => (current ? { ...current, loading: false } : current));
      });
  }, [settle]);

  const adapter = useMemo<TabLifecycleAdapter<RecordTab, RecordTabCloseReason>>(
    () => ({ prepareClose }),
    [prepareClose],
  );

  return {
    adapter,
    dialog: confirmation ? (
      <ConfirmDialog
        title={dependencies.labels.title}
        message={dependencies.labels.message}
        confirmText={dependencies.labels.confirm}
        cancelText={dependencies.labels.cancel}
        confirmVariant="danger"
        loading={confirmation.loading}
        onConfirm={confirm}
        onCancel={() => settle('blocked')}
      />
    ) : null,
  };
}
