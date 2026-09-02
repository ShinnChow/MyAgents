import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { builtinTabModules, builtinTabWorkspacePolicy } from './builtinComposition';
import { useTabWorkspaceController } from './useTabWorkspaceController';
import type { ChatTab, Tab } from '@/types/tab';

function setup(maxTabs = 12) {
  let nextId = 0;
  const launcher: Tab = {
    id: 'launcher-1',
    view: 'launcher',
    title: 'New Tab',
  };
  return renderHook(() =>
    useTabWorkspaceController<Tab, typeof builtinTabModules>({
      modules: builtinTabModules,
      initialTabs: [launcher],
      initialActiveTabId: launcher.id,
      maxTabs,
      createId: () => `generated-${++nextId}`,
      isLastTabProtected: builtinTabWorkspacePolicy.isLastTabProtected,
    }),
  );
}

describe('useTabWorkspaceController', () => {
  it('atomically creates, focuses and reopens singleton navigation intents', () => {
    const hook = setup();
    act(() => {
      expect(
        hook.result.current.controller.open('settings', {
          title: 'Settings',
          navigationIntent: { generation: 1, section: 'providers' },
        }).kind,
      ).toBe('created');
    });
    const settings = hook.result.current.state.tabs.find((tab) => tab.view === 'settings');
    expect(settings?.view).toBe('settings');
    expect(hook.result.current.state.activeTabId).toBe(settings?.id);

    act(() => {
      expect(
        hook.result.current.controller.open('settings', {
          title: 'Settings',
          navigationIntent: { generation: 2, section: 'general' },
        }).kind,
      ).toBe('reopened');
    });
    expect(hook.result.current.state.tabs).toHaveLength(2);
    const reopened = hook.result.current.state.tabs.find((tab) => tab.view === 'settings');
    expect(reopened?.view === 'settings' && reopened.navigationIntent).toEqual({
      generation: 2,
      section: 'general',
    });
  });

  it('rejects ordinary opens at capacity without corrupting active/deferred state', () => {
    const hook = setup(1);
    const before = hook.result.current.controller.getSnapshot();
    let outcome = '';
    act(() => {
      outcome = hook.result.current.controller.open('space', {
        title: 'Space',
      }).kind;
    });
    expect(outcome).toBe('rejected');
    expect(hook.result.current.controller.getSnapshot()).toBe(before);
  });

  it('supports the bounded active-recording over-capacity exception explicitly', () => {
    const hook = setup(1);
    act(() => {
      hook.result.current.controller.open(
        'record',
        { recordId: 'record-1', title: 'Recording' },
        { allowOverCapacity: true },
      );
    });
    expect(hook.result.current.state.tabs.map((tab) => tab.view)).toEqual(['launcher', 'record']);
  });

  it('rejects stale replace captures after structural identity changes', () => {
    const hook = setup();
    let recordId = '';
    act(() => {
      const opened = hook.result.current.controller.open('record', {
        recordId: 'record-1',
        title: 'One',
      });
      if (opened.kind !== 'rejected') recordId = opened.tab.id;
    });
    const captured = hook.result.current.controller.capture(recordId)!;
    act(() => {
      hook.result.current.controller.update(recordId, 'record', (tab) => ({
        ...tab,
        recordId: 'record-2',
      }));
    });
    expect(
      hook.result.current.controller.replaceWith(captured, 'launcher', {
        reuseExisting: false,
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale' });
  });

  it('keeps the lone Launcher identity stable and falls back after the last work tab detaches', () => {
    const hook = setup();
    const launcherCapture = hook.result.current.controller.capture('launcher-1')!;
    expect(
      hook.result.current.controller.detach(launcherCapture, () => ({
        id: 'fallback',
        view: 'launcher',
        title: 'New Tab',
      })),
    ).toEqual({ kind: 'no-op', reason: 'protected' });
    expect(hook.result.current.state.tabs[0]?.id).toBe('launcher-1');

    let chat: ChatTab | null = null;
    act(() => {
      const opened = hook.result.current.controller.replaceWith(launcherCapture, 'chat', {
        agentDir: '/workspace',
        sessionId: 'session-1',
        title: 'Chat',
        sidecarConfigDisposition: 'push',
      });
      if (opened.kind === 'replaced' && opened.tab.view === 'chat') {
        chat = opened.tab;
      }
    });
    const chatCapture = hook.result.current.controller.capture(chat!.id)!;
    act(() => {
      hook.result.current.controller.detach(chatCapture, () => ({
        id: 'fallback',
        view: 'launcher',
        title: 'New Tab',
      }));
    });
    expect(hook.result.current.state.tabs).toEqual([{ id: 'fallback', view: 'launcher', title: 'New Tab' }]);
    expect(hook.result.current.state.activeTabId).toBe('fallback');
  });

  it('keeps active and deferred membership correlated across reorder, reveal and guarded batch removal', () => {
    const hook = setup();
    act(() => {
      hook.result.current.controller.append(
        {
          id: 'settings-1',
          view: 'settings',
          title: 'Settings',
          navigationIntent: { generation: 1, section: 'providers' },
        },
        { mount: 'deferred-content', activate: false },
      );
      hook.result.current.controller.append(
        { id: 'space-1', view: 'space', title: 'Space' },
        { mount: 'immediate', activate: false },
      );
      hook.result.current.controller.reorder('space-1', 'launcher-1');
    });

    expect(hook.result.current.state.tabs.map((tab) => tab.id)).toEqual([
      'space-1',
      'launcher-1',
      'settings-1',
    ]);
    expect(hook.result.current.state.activeTabId).toBe('launcher-1');
    expect(hook.result.current.state.deferredMountTabIds).toEqual(new Set(['settings-1']));

    act(() => {
      hook.result.current.controller.reveal('settings-1');
      hook.result.current.controller.focus('space-1');
    });
    const spaceCapture = hook.result.current.controller.capture('space-1')!;
    const settingsCapture = hook.result.current.controller.capture('settings-1')!;
    act(() => {
      expect(
        hook.result.current.controller.removeMany(
          [{ captured: spaceCapture }, { captured: settingsCapture }],
          () => ({ id: 'fallback', view: 'launcher', title: 'New Tab' }),
          'launcher-1',
        ),
      ).toBe(2);
    });

    expect(hook.result.current.state.tabs).toEqual([{ id: 'launcher-1', view: 'launcher', title: 'New Tab' }]);
    expect(hook.result.current.state.activeTabId).toBe('launcher-1');
    expect(hook.result.current.state.deferredMountTabIds.size).toBe(0);
  });

  it('runs restore planning against the latest controller snapshot', () => {
    const hook = setup();
    const restoredChat: ChatTab = {
      id: 'restored-chat',
      view: 'chat',
      title: 'Restored',
      agentDir: '/workspace',
      sessionId: 'session-restore',
      sidecarConfigDisposition: 'pending',
    };
    act(() => {
      hook.result.current.controller.open('settings', {
        title: 'Settings',
        navigationIntent: { generation: 1 },
      });
    });
    let sawLatestSettings = false;
    act(() => {
      hook.result.current.controller.restoreWithPolicy(
        { tabs: [restoredChat], activeTabId: restoredChat.id },
        (current, candidate) => {
          sawLatestSettings = current.some((tab) => tab.view === 'settings');
          return {
            tabs: [...current, ...candidate.tabs],
            activeTabId: candidate.activeTabId!,
          };
        },
      );
    });
    expect(sawLatestSettings).toBe(true);
    expect(hook.result.current.state.tabs.map((tab) => tab.view)).toEqual(['launcher', 'settings', 'chat']);
  });
});
