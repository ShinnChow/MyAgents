import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriWindow = vi.hoisted(() => ({
  focusListener: undefined as ((event: { payload: boolean }) => void) | undefined,
  resizeListener: undefined as ((event: { payload: { width: number; height: number } }) => void) | undefined,
  onFocusChanged: vi.fn(),
  onResized: vi.fn(),
  isVisible: vi.fn(),
  isMinimized: vi.fn(),
  unlisten: vi.fn(),
}));

const notification = vi.hoisted(() => ({
  setWindowVisible: vi.fn(),
}));
const tauriEvents = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  listenWithCleanup: vi.fn(),
}));

vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/closeLayer', () => ({ dismissTopmost: () => false }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: tauriEvents.listenWithCleanup }));
vi.mock('@/services/notificationService', () => notification);
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    hide: vi.fn(),
    close: vi.fn(),
    onFocusChanged: tauriWindow.onFocusChanged,
    onResized: tauriWindow.onResized,
    isVisible: tauriWindow.isVisible,
    isMinimized: tauriWindow.isMinimized,
  }),
}));

import { useTrayEvents } from './useTrayEvents';

describe('useTrayEvents window presentation authority', () => {
  beforeEach(() => {
    tauriWindow.focusListener = undefined;
    tauriWindow.resizeListener = undefined;
    tauriWindow.onFocusChanged.mockReset();
    tauriWindow.unlisten.mockReset();
    tauriWindow.onFocusChanged.mockImplementation(async (listener) => {
      tauriWindow.focusListener = listener;
      return tauriWindow.unlisten;
    });
    tauriWindow.onResized.mockReset();
    tauriWindow.onResized.mockImplementation(async (listener) => {
      tauriWindow.resizeListener = listener;
      return tauriWindow.unlisten;
    });
    tauriWindow.isVisible.mockReset();
    tauriWindow.isVisible.mockResolvedValue(true);
    tauriWindow.isMinimized.mockReset();
    tauriWindow.isMinimized.mockResolvedValue(false);
    notification.setWindowVisible.mockReset();
    tauriEvents.handlers.clear();
    tauriEvents.listenWithCleanup.mockReset();
    tauriEvents.listenWithCleanup.mockImplementation(async (event, handler) => {
      tauriEvents.handlers.set(event, handler);
      return { unlisten: vi.fn(), isRegistered: () => true };
    });
  });

  it('keeps native focus scoped to notifications and focused callbacks', async () => {
    const onWindowFocused = vi.fn();
    renderHook(() => useTrayEvents({
      minimizeToTray: false,
      onWindowFocused,
    }));
    await waitFor(() => expect(tauriWindow.focusListener).toBeDefined());

    act(() => tauriWindow.focusListener?.({ payload: false }));
    expect(notification.setWindowVisible).toHaveBeenLastCalledWith(false);

    act(() => tauriWindow.focusListener?.({ payload: true }));
    expect(notification.setWindowVisible).toHaveBeenLastCalledWith(true);
    expect(onWindowFocused).toHaveBeenCalledTimes(1);
  });

  it('samples native presentation without treating visible blur as suspension', async () => {
    const onWindowPresentationChanged = vi.fn();
    renderHook(() => useTrayEvents({
      minimizeToTray: false,
      onWindowPresentationChanged,
    }));
    await waitFor(() => expect(tauriWindow.resizeListener).toBeDefined());
    await waitFor(() => expect(onWindowPresentationChanged).toHaveBeenCalledWith(true, 'initial'));

    act(() => tauriWindow.focusListener?.({ payload: false }));
    await waitFor(() => expect(onWindowPresentationChanged).toHaveBeenLastCalledWith(true, 'focus-sample'));

    tauriWindow.isMinimized.mockResolvedValue(true);
    act(() => tauriWindow.resizeListener?.({ payload: { width: 0, height: 0 } }));
    expect(onWindowPresentationChanged).toHaveBeenLastCalledWith(false, 'resize-zero');

    tauriWindow.isMinimized.mockResolvedValue(false);
    act(() => tauriWindow.resizeListener?.({ payload: { width: 1200, height: 800 } }));
    await waitFor(() => expect(onWindowPresentationChanged).toHaveBeenLastCalledWith(true, 'resize-sample'));
  });

  it('drops an older async focus sample after a synchronous zero-size suspension', async () => {
    const onWindowPresentationChanged = vi.fn();
    renderHook(() => useTrayEvents({
      minimizeToTray: false,
      onWindowPresentationChanged,
    }));
    await waitFor(() => expect(onWindowPresentationChanged).toHaveBeenCalledWith(true, 'initial'));

    let resolveVisible: ((visible: boolean) => void) | undefined;
    const delayedVisible = new Promise<boolean>((resolve) => {
      resolveVisible = resolve;
    });
    tauriWindow.isVisible.mockReturnValueOnce(delayedVisible);
    act(() => tauriWindow.focusListener?.({ payload: false }));
    act(() => tauriWindow.resizeListener?.({ payload: { width: 0, height: 0 } }));
    expect(onWindowPresentationChanged).toHaveBeenLastCalledWith(false, 'resize-zero');

    await act(async () => {
      resolveVisible?.(true);
      await delayedVisible;
    });

    expect(onWindowPresentationChanged).toHaveBeenLastCalledWith(false, 'resize-zero');
  });

  it('preserves a Rust-owned hide→show edge even when an older renderer sample resolves later', async () => {
    const onWindowPresentationChanged = vi.fn();
    renderHook(() => useTrayEvents({
      minimizeToTray: false,
      onWindowPresentationChanged,
    }));
    await waitFor(() => expect(onWindowPresentationChanged).toHaveBeenCalledWith(true, 'initial'));
    await waitFor(() => expect(
      tauriEvents.handlers.has('main-window:presentation-changed'),
    ).toBe(true));

    let resolveVisible: ((visible: boolean) => void) | undefined;
    const delayedVisible = new Promise<boolean>((resolve) => {
      resolveVisible = resolve;
    });
    tauriWindow.isVisible.mockReturnValueOnce(delayedVisible);
    act(() => tauriWindow.focusListener?.({ payload: false }));

    const nativePresentation = tauriEvents.handlers.get('main-window:presentation-changed');
    act(() => nativePresentation?.({ payload: false }));
    act(() => nativePresentation?.({ payload: true }));

    await act(async () => {
      resolveVisible?.(true);
      await delayedVisible;
    });

    const nativeCalls = onWindowPresentationChanged.mock.calls.filter(
      ([, reason]) => reason === 'native-event',
    );
    expect(nativeCalls).toEqual([
      [false, 'native-event'],
      [true, 'native-event'],
    ]);
    expect(onWindowPresentationChanged).toHaveBeenLastCalledWith(true, 'native-event');
  });
});
