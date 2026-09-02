import { describe, expect, it } from 'vitest';

import { buildChatFlipPatch, createNewTab, type ChatTab, type Tab } from './tab';

describe('buildChatFlipPatch — chat-flip invariants (instant-nav D1)', () => {
  const base: Tab = { ...createNewTab(), id: 'tab-1' };
  const liveChat: ChatTab = {
    id: 'tab-1',
    view: 'chat',
    title: 'Existing',
    agentDir: '/old',
    sessionId: 'old-session',
    sidecarConfigDisposition: 'adopt',
    isGenerating: true,
    hasUnread: true,
    initialMessage: { text: 'keep' },
  };

  it('flips view to chat and always carries a truthy sessionId (D1)', () => {
    const patch = buildChatFlipPatch(base, {
      agentDir: '/ws/a',
      sessionId: 'pending-tab-1',
      title: 'A',
      sidecarConfigDisposition: 'push',
    });
    expect(patch.view).toBe('chat');
    expect(patch.sessionId).toBe('pending-tab-1');
    expect(patch.sessionId).toBeTruthy(); // D1: never null → SSE connect effect fires
    expect(patch.agentDir).toBe('/ws/a');
    expect(patch.title).toBe('A');
  });

  it('preserves unrelated tab fields (id, isGenerating, hasUnread)', () => {
    const patch = buildChatFlipPatch(liveChat, {
      agentDir: '/ws/a',
      sessionId: 's1',
      title: 'A',
      sidecarConfigDisposition: 'push',
    });
    expect(patch.id).toBe('tab-1');
    expect(patch.isGenerating).toBe(true);
    expect(patch.hasUnread).toBe(true);
  });

  it('omits initialMessage when not provided (no undefined clobber)', () => {
    const patch = buildChatFlipPatch(liveChat, {
      agentDir: '/ws/a',
      sessionId: 's1',
      title: 'A',
      sidecarConfigDisposition: 'push',
    });
    // Not provided → the key is not written, so a prior value survives.
    expect(patch.initialMessage).toEqual({ text: 'keep' });
  });

  it('attaches initialMessage when provided', () => {
    const patch = buildChatFlipPatch(base, {
      agentDir: '/ws/a',
      sessionId: 's1',
      title: 'A',
      initialMessage: { text: 'hi' },
      sidecarConfigDisposition: 'push',
    });
    expect(patch.initialMessage).toEqual({ text: 'hi' });
  });

  it('requires and sets sidecarConfigDisposition (push | adopt | pending)', () => {
    for (const d of ['push', 'adopt', 'pending'] as const) {
      const patch = buildChatFlipPatch(base, {
        agentDir: '/ws/a',
        sessionId: 's1',
        title: 'A',
        sidecarConfigDisposition: d,
      });
      expect(patch.sidecarConfigDisposition).toBe(d);
    }
  });

  it('OVERWRITES a stale prior disposition (config-stomping guard)', () => {
    // A reused tab may carry a prior 'adopt'/'pending'. The flip MUST overwrite it
    // with the flip's value — otherwise a new-session 'push' flip on a tab that had
    // adopted a sidecar would wrongly keep 'adopt' → Chat skips MCP/agents/model push
    // and adopts disk config over the user's picks (#300/#301 config-stomp class).
    const patch = buildChatFlipPatch(liveChat, {
      agentDir: '/ws/a',
      sessionId: 's1',
      title: 'A',
      sidecarConfigDisposition: 'push',
    });
    expect(patch.sidecarConfigDisposition).toBe('push');
  });

  it('createNewTab is an exact Launcher without Chat-only fields', () => {
    expect(createNewTab()).toEqual(expect.objectContaining({ view: 'launcher' }));
    expect(createNewTab()).not.toHaveProperty('sidecarConfigDisposition');
    expect(createNewTab()).not.toHaveProperty('sessionId');
  });
});
