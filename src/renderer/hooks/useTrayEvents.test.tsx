import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriWindow = vi.hoisted(() => ({
  focusListener: undefined as ((event: { payload: boolean }) => void) | undefined,
  onFocusChanged: vi.fn(),
  unlisten: vi.fn(),
}));

const notification = vi.hoisted(() => ({
  setWindowVisible: vi.fn(),
}));

vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/closeLayer', () => ({ dismissTopmost: () => false }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn() }));
vi.mock('@/services/notificationService', () => notification);
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    hide: vi.fn(),
    close: vi.fn(),
    onFocusChanged: tauriWindow.onFocusChanged,
  }),
}));

import { useTrayEvents } from './useTrayEvents';

describe('useTrayEvents window focus authority', () => {
  beforeEach(() => {
    tauriWindow.focusListener = undefined;
    tauriWindow.onFocusChanged.mockReset();
    tauriWindow.unlisten.mockReset();
    tauriWindow.onFocusChanged.mockImplementation(async (listener) => {
      tauriWindow.focusListener = listener;
      return tauriWindow.unlisten;
    });
    notification.setWindowVisible.mockReset();
  });

  it('projects native focus and focused callbacks synchronously without guessing toast clicks', async () => {
    const onWindowFocusChanged = vi.fn();
    const onWindowFocused = vi.fn();
    renderHook(() => useTrayEvents({
      minimizeToTray: false,
      onWindowFocusChanged,
      onWindowFocused,
    }));
    await waitFor(() => expect(tauriWindow.focusListener).toBeDefined());

    act(() => tauriWindow.focusListener?.({ payload: false }));
    expect(onWindowFocusChanged).toHaveBeenLastCalledWith(false);
    expect(notification.setWindowVisible).toHaveBeenLastCalledWith(false);

    act(() => tauriWindow.focusListener?.({ payload: true }));
    expect(onWindowFocusChanged).toHaveBeenLastCalledWith(true);
    expect(notification.setWindowVisible).toHaveBeenLastCalledWith(true);
    expect(onWindowFocused).toHaveBeenCalledTimes(1);
  });
});
