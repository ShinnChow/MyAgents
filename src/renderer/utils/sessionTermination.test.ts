import { describe, expect, it } from 'vitest';

import type { ChatTab, Tab } from '@/types/tab';
import { applyTerminalSessionToTabs, reconcileTabsToLiveSessions, resetTabToLauncher } from './sessionTermination';

const makeChat = (overrides: Partial<ChatTab> = {}): ChatTab => ({
  id: 'tab-x',
  agentDir: '/Users/me/proj',
  sessionId: 'sess-1',
  view: 'chat',
  title: 'Project',
  sidecarConfigDisposition: 'push',
  ...overrides,
});

describe('resetTabToLauncher', () => {
  it('reconstructs an exact Launcher and drops all Chat-only fields', () => {
    const next = resetTabToLauncher(
      makeChat({
        id: 'tab-a',
        sidecarConfigDisposition: 'adopt',
        initialMessage: { text: 'hi' },
        isGenerating: true,
        hasUnread: true,
      }),
    );
    expect(next).toEqual({
      id: 'tab-a',
      view: 'launcher',
      title: 'New Tab',
    });
    expect(next).not.toHaveProperty('sessionId');
    expect(next).not.toHaveProperty('initialMessage');
    expect(next).not.toHaveProperty('isGenerating');
  });
});

describe('applyTerminalSessionToTabs', () => {
  it('clears every matching Chat and preserves siblings by reference', () => {
    const tabs: Tab[] = [
      makeChat({ id: 'a', sessionId: 'sess-1' }),
      makeChat({ id: 'b', sessionId: 'sess-2' }),
      makeChat({ id: 'c', sessionId: 'sess-1' }),
    ];
    const next = applyTerminalSessionToTabs(tabs, 'sess-1');
    expect(next).not.toBe(tabs);
    expect(next[0]).toEqual({ id: 'a', view: 'launcher', title: 'New Tab' });
    expect(next[1]).toBe(tabs[1]);
    expect(next[2]).toEqual({ id: 'c', view: 'launcher', title: 'New Tab' });
  });

  it('returns the same reference when no Chat matches', () => {
    const tabs: Tab[] = [
      { id: 'launcher', view: 'launcher', title: 'New Tab' },
      makeChat({ id: 'a', sessionId: 'sess-1' }),
    ];
    expect(applyTerminalSessionToTabs(tabs, 'sess-99')).toBe(tabs);
  });
});

describe('reconcileTabsToLiveSessions', () => {
  it('clears non-live Chats and preserves live and pending Chats', () => {
    const tabs: Tab[] = [
      makeChat({ id: 'alive', sessionId: 'sess-alive' }),
      makeChat({ id: 'dead', sessionId: 'sess-dead' }),
      makeChat({ id: 'pending', sessionId: 'pending-tab-pending' }),
      { id: 'settings', view: 'settings', title: 'Settings' },
    ];
    const next = reconcileTabsToLiveSessions(tabs, ['sess-alive']);
    expect(next[0]).toBe(tabs[0]);
    expect(next[1]).toEqual({
      id: 'dead',
      view: 'launcher',
      title: 'New Tab',
    });
    expect(next[2]).toBe(tabs[2]);
    expect(next[3]).toBe(tabs[3]);
  });

  it('returns the same reference when nothing changes', () => {
    const tabs: Tab[] = [
      makeChat({ id: 'alive', sessionId: 'sess-alive' }),
      { id: 'launcher', view: 'launcher', title: 'New Tab' },
    ];
    expect(reconcileTabsToLiveSessions(tabs, ['sess-alive'])).toBe(tabs);
  });
});
