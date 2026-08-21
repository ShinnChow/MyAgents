import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useVirtuosoScroll } from './useVirtuosoScroll';

describe('useVirtuosoScroll user intent projection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports wheel, scrollbar pointer, and viewport keys without treating editable keys as scroll', () => {
    const onUserScrollIntent = vi.fn();
    const { result, unmount } = renderHook(() => useVirtuosoScroll({ onUserScrollIntent }));
    const scroller = document.createElement('div');
    act(() => result.current.attachScroller(scroller));

    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }));
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }));
    scroller.dispatchEvent(new PointerEvent('pointerdown'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    expect(onUserScrollIntent).toHaveBeenCalledTimes(4);

    const input = document.createElement('textarea');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(onUserScrollIntent).toHaveBeenCalledTimes(4);

    unmount();
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }));
    expect(onUserScrollIntent).toHaveBeenCalledTimes(4);
  });
});
