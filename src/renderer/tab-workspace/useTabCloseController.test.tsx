import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RecordTab, Tab } from '@/types/tab';
import { builtinTabModules, builtinTabWorkspacePolicy } from './builtinComposition';
import { type TabCloseAdmission, type TabLifecycleAdapter, useTabCloseController } from './useTabCloseController';
import { useTabWorkspaceController } from './useTabWorkspaceController';

type TestCloseReason = 'user' | 'record-deleted';

function useHarness(
  initialTab: Tab,
  recordLifecycle?: TabLifecycleAdapter<RecordTab, TestCloseReason>,
  calls: string[] = [],
) {
  const workspace = useTabWorkspaceController<Tab, typeof builtinTabModules>({
    modules: builtinTabModules,
    initialTabs: [initialTab],
    initialActiveTabId: initialTab.id,
    maxTabs: 12,
    createId: () => 'generated',
    isLastTabProtected: builtinTabWorkspacePolicy.isLastTabProtected,
  });
  const close = useTabCloseController<Tab, typeof builtinTabModules, TestCloseReason>({
    workspace: workspace.controller,
    lifecycle: recordLifecycle ? { record: recordLifecycle } : {},
    defaultReason: 'user',
    createFallback: () => ({
      id: 'fallback',
      view: 'launcher',
      title: 'New Tab',
    }),
    onBeforeDetach: () => calls.push('before-detach'),
    onDetached: () => calls.push('detached'),
    onCleanupError: (_tab, error) => calls.push(`error:${String(error)}`),
  });
  return { ...workspace, close };
}

const recordTab = (): RecordTab => ({
  id: 'record-tab',
  view: 'record',
  title: 'Record',
  recordId: 'record-1',
});

describe('useTabCloseController', () => {
  it('uses the default synchronous admission and creates a Launcher fallback', () => {
    const calls: string[] = [];
    const hook = renderHook(() =>
      useHarness({ id: 'settings', view: 'settings', title: 'Settings' }, undefined, calls),
    );
    act(() => hook.result.current.close('settings'));
    expect(hook.result.current.state.tabs).toEqual([{ id: 'fallback', view: 'launcher', title: 'New Tab' }]);
    expect(calls).toEqual(['before-detach', 'detached']);
  });

  it('deduplicates concurrent close and refuses to detach a rebound identity', async () => {
    const calls: string[] = [];
    let settle!: (admission: TabCloseAdmission) => void;
    const prepareClose = vi.fn(
      () =>
        new Promise<TabCloseAdmission>((resolve) => {
          settle = resolve;
        }),
    );
    const afterDetach = vi.fn();
    const hook = renderHook(() => useHarness(recordTab(), { prepareClose, afterDetach }, calls));
    act(() => {
      hook.result.current.close('record-tab');
      hook.result.current.close('record-tab');
    });
    expect(prepareClose).toHaveBeenCalledTimes(1);
    act(() => {
      hook.result.current.controller.update('record-tab', 'record', (tab) => ({
        ...tab,
        recordId: 'record-2',
      }));
      settle('allow');
    });
    await waitFor(() => expect(afterDetach).not.toHaveBeenCalled());
    expect(calls).toEqual([]);
    expect(hook.result.current.state.tabs[0]).toMatchObject({
      view: 'record',
      recordId: 'record-2',
    });
  });

  it('orders async prepare before detach and feature cleanup', async () => {
    const calls: string[] = [];
    const lifecycle: TabLifecycleAdapter<RecordTab> = {
      prepareClose: async () => {
        calls.push('prepare');
        return 'allow' as const;
      },
      afterDetach: async () => {
        calls.push('after-detach');
      },
    };
    const hook = renderHook(() => useHarness(recordTab(), lifecycle, calls));
    act(() => hook.result.current.close('record-tab'));
    await waitFor(() => expect(calls).toEqual(['prepare', 'before-detach', 'detached', 'after-detach']));
  });
});
