import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceChangeSignal } from './useWorkspaceChangeSignal';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  watchStart: vi.fn(async () => ({ token: 'watch-token', eventKey: 'workspace-key' })),
  watchStop: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    const callbacks = mocks.listeners.get(name) ?? new Set();
    callbacks.add(callback);
    mocks.listeners.set(name, callbacks);
    return () => callbacks.delete(callback);
  }),
}));

vi.mock('./useWorkspaceFileService', () => {
  const service = { isAvailable: true, watchStart: mocks.watchStart, watchStop: mocks.watchStop };
  return { useWorkspaceFileService: () => service };
});

describe('workspace mutation notifications', () => {
  afterEach(() => {
    cleanup();
    mocks.listeners.clear();
    vi.clearAllMocks();
  });

  it('does not start a watcher when disabled', () => {
    renderHook(() => useWorkspaceChangeSignal('/workspace', false));
    expect(mocks.watchStart).not.toHaveBeenCalled();
  });

  it('delivers the current callback before passive effects without restarting the watcher', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const moves = [{ oldPath: 'a.md', newPath: 'b.md' }];
    const channel = 'workspace:files-changed:workspace-key';
    const { rerender } = renderHook(({ callback, emit }) => {
      useWorkspaceChangeSignal('/workspace', true, callback);
      useLayoutEffect(() => {
        if (emit) mocks.listeners.get(channel)?.forEach(listener => listener({ payload: { moves } }));
      }, [emit]);
    }, { initialProps: { callback: first, emit: false } });
    await waitFor(() => expect(mocks.listeners.get(channel)?.size).toBe(1));
    rerender({ callback: second, emit: true });
    expect(second).toHaveBeenCalledWith(moves);
    expect(first).not.toHaveBeenCalled();
    expect(mocks.watchStart).toHaveBeenCalledTimes(1);
  });

  it('delivers committed moves to every subscriber and retains coarse refresh and cleanup', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = renderHook(() => useWorkspaceChangeSignal('/workspace', true, first));
    const b = renderHook(() => useWorkspaceChangeSignal('/workspace', true, second));
    const channel = 'workspace:files-changed:workspace-key';
    await waitFor(() => expect(mocks.listeners.get(channel)?.size).toBe(2));
    const moves = [{ oldPath: 'old', newPath: 'new' }];
    act(() => {
      mocks.listeners.get(channel)?.forEach(callback => callback({ payload: { moves } }));
      // Identity is delivered synchronously, before a consumer revalidates on render.
      expect(first).toHaveBeenCalledWith(moves);
      expect(second).toHaveBeenCalledWith(moves);
    });
    expect(a.result.current).toBe(1);
    expect(b.result.current).toBe(1);
    act(() => mocks.listeners.get(channel)?.forEach(callback => callback({ payload: '/workspace' })));
    expect(a.result.current).toBe(2);
    expect(first).toHaveBeenCalledTimes(1);
    a.unmount();
    expect(mocks.listeners.get(channel)?.size).toBe(1);
    expect(mocks.watchStop).toHaveBeenCalledWith({ token: 'watch-token' });
    act(() => mocks.listeners.get(channel)?.forEach(callback => callback({ payload: { moves } })));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
