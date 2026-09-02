import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useEffect, type RefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { RecordingSnapshot } from '@/../shared/types/record';
import type { RecordTab } from '@/types/tab';
import type { TabCloseAdmission, TabLifecycleAdapter } from '@/tab-workspace/useTabCloseController';
import { type RecordTabCloseReason, useRecordTabLifecycle } from './useRecordTabLifecycle';

const tab: RecordTab = {
  id: 'record-tab',
  view: 'record',
  title: 'Record',
  recordId: 'record-1',
};

const snapshot: RecordingSnapshot = {
  recordId: 'record-1',
  revision: 1,
  generation: 1,
  captureStatus: 'recording',
  startedAtWallTime: 1_700_000_000_000,
  mediaDurationMs: 1_000,
  pausedWallMs: 0,
  sources: [],
  sourceActivity: [],
  warnings: [],
};

type Dependencies = Parameters<typeof useRecordTabLifecycle>[0];
const adapterRef = createRef<TabLifecycleAdapter<RecordTab, RecordTabCloseReason>>();

function Harness({
  dependencies,
  lifecycleRef,
}: {
  dependencies: Dependencies;
  lifecycleRef: RefObject<TabLifecycleAdapter<RecordTab, RecordTabCloseReason> | null>;
}) {
  const lifecycle = useRecordTabLifecycle(dependencies);
  useEffect(() => {
    lifecycleRef.current = lifecycle.adapter;
  }, [lifecycle.adapter, lifecycleRef]);
  return lifecycle.dialog;
}

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    isAdmissionPending: () => false,
    getRecordingSnapshot: vi.fn(async () => snapshot),
    stopRecording: vi.fn(async () => undefined),
    flushPendingNote: vi.fn(async () => true),
    showStatusError: vi.fn(),
    showStopError: vi.fn(),
    labels: {
      title: 'Close recording',
      message: 'Stop and save?',
      confirm: 'Stop',
      cancel: 'Cancel',
    },
    log: vi.fn(),
    ...overrides,
  };
}

async function requestAdmission(reason: 'user' | 'record-deleted' = 'user'): Promise<TabCloseAdmission> {
  const result = adapterRef.current?.prepareClose?.(tab, reason) ?? 'allow';
  return Promise.resolve(result);
}

describe('useRecordTabLifecycle', () => {
  it('blocks ordinary close while recording-start admission is pending', async () => {
    const getRecordingSnapshot = vi.fn(async () => snapshot);
    render(
      <Harness
        lifecycleRef={adapterRef}
        dependencies={dependencies({
          isAdmissionPending: () => true,
          getRecordingSnapshot,
        })}
      />,
    );

    await expect(requestAdmission()).resolves.toBe('blocked');
    expect(getRecordingSnapshot).not.toHaveBeenCalled();
  });

  it('blocks close when the authoritative recording query fails', async () => {
    const showStatusError = vi.fn();
    render(
      <Harness
        lifecycleRef={adapterRef}
        dependencies={dependencies({
          getRecordingSnapshot: vi.fn(async () => {
            throw new Error('query failed');
          }),
          showStatusError,
        })}
      />,
    );
    await expect(requestAdmission()).resolves.toBe('blocked');
    expect(showStatusError).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Close recording')).not.toBeInTheDocument();
  });

  it('keeps the tab when the user cancels active-capture confirmation', async () => {
    render(<Harness dependencies={dependencies()} lifecycleRef={adapterRef} />);
    let admission!: Promise<TabCloseAdmission>;
    act(() => {
      admission = requestAdmission();
    });
    expect(await screen.findByText('Close recording')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(admission).resolves.toBe('blocked');
  });

  it('flushes notes and stops before allowing detach', async () => {
    const calls: string[] = [];
    render(
      <Harness
        lifecycleRef={adapterRef}
        dependencies={dependencies({
          flushPendingNote: vi.fn(async () => {
            calls.push('flush');
            return true;
          }),
          stopRecording: vi.fn(async () => {
            calls.push('stop');
          }),
        })}
      />,
    );
    const admission = requestAdmission();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await expect(admission).resolves.toBe('allow');
    expect(calls).toEqual(['flush', 'stop']);
  });

  it('keeps confirmation open when pending note flush returns false', async () => {
    const stopRecording = vi.fn(async () => undefined);
    render(
      <Harness
        lifecycleRef={adapterRef}
        dependencies={dependencies({
          flushPendingNote: vi.fn(async () => false),
          stopRecording,
        })}
      />,
    );
    const admission = requestAdmission();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled());
    expect(stopRecording).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(admission).resolves.toBe('blocked');
  });

  it('keeps confirmation open when pending note flush rejects', async () => {
    const stopRecording = vi.fn(async () => undefined);
    render(
      <Harness
        lifecycleRef={adapterRef}
        dependencies={dependencies({
          flushPendingNote: vi.fn(async () => {
            throw new Error('flush failed');
          }),
          stopRecording,
        })}
      />,
    );
    const admission = requestAdmission();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled());
    expect(stopRecording).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(admission).resolves.toBe('blocked');
  });

  it('keeps the tab when stop fails and the same capture is still active', async () => {
    const getRecordingSnapshot = vi
      .fn<() => Promise<RecordingSnapshot | null>>()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, revision: 2 });
    render(
      <Harness
        lifecycleRef={adapterRef}
        dependencies={dependencies({
          getRecordingSnapshot,
          stopRecording: vi.fn(async () => {
            throw new Error('stop failed');
          }),
        })}
      />,
    );
    const admission = requestAdmission();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(admission).resolves.toBe('blocked');
  });

  it('keeps the tab when the post-stop authoritative requery fails', async () => {
    const getRecordingSnapshot = vi
      .fn<() => Promise<RecordingSnapshot | null>>()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error('requery failed'));
    render(
      <Harness
        lifecycleRef={adapterRef}
        dependencies={dependencies({
          getRecordingSnapshot,
          stopRecording: vi.fn(async () => {
            throw new Error('stop failed');
          }),
        })}
      />,
    );
    const admission = requestAdmission();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(admission).resolves.toBe('blocked');
  });

  it('allows detach after stop throws only when requery says capture is gone', async () => {
    const getRecordingSnapshot = vi
      .fn<() => Promise<RecordingSnapshot | null>>()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(null);
    const showStopError = vi.fn();
    render(
      <Harness
        lifecycleRef={adapterRef}
        dependencies={dependencies({
          getRecordingSnapshot,
          stopRecording: vi.fn(async () => {
            throw new Error('stop receipt lost');
          }),
          showStopError,
        })}
      />,
    );
    const admission = requestAdmission();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await expect(admission).resolves.toBe('allow');
    await waitFor(() => expect(showStopError).toHaveBeenCalledTimes(1));
  });

  it('bypasses deleted-resource admission without querying RecordingManager', async () => {
    const getRecordingSnapshot = vi.fn(async () => snapshot);
    render(<Harness lifecycleRef={adapterRef} dependencies={dependencies({ getRecordingSnapshot })} />);
    await expect(requestAdmission('record-deleted')).resolves.toBe('allow');
    expect(getRecordingSnapshot).not.toHaveBeenCalled();
  });
});
