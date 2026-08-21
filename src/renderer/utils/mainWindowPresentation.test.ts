import { describe, expect, it } from 'vitest';

import {
  createInitialMainWindowPresentation,
  reduceMainWindowPresentation,
} from './mainWindowPresentation';

describe('mainWindowPresentation', () => {
  it('does not create a lifecycle edge when a visible window merely changes focus', () => {
    const current = createInitialMainWindowPresentation(true);

    expect(reduceMainWindowPresentation(current, true)).toBe(current);
  });

  it('opens one generation per unavailable interval and keeps it through restoration', () => {
    const available = createInitialMainWindowPresentation(true);
    const suspended = reduceMainWindowPresentation(available, false);
    const duplicateSuspension = reduceMainWindowPresentation(suspended, false);
    const restored = reduceMainWindowPresentation(duplicateSuspension, true);

    expect(suspended).toEqual({ surfaceAvailable: false, generation: 1 });
    expect(duplicateSuspension).toBe(suspended);
    expect(restored).toEqual({ surfaceAvailable: true, generation: 1 });
  });

  it('seeds an initially unavailable surface as its first recovery generation', () => {
    expect(createInitialMainWindowPresentation(false)).toEqual({
      surfaceAvailable: false,
      generation: 1,
    });
  });

  it('keeps rapid suspend/restore cycles monotonic without duplicating generations', () => {
    let current = createInitialMainWindowPresentation(true);

    for (let generation = 1; generation <= 25; generation += 1) {
      current = reduceMainWindowPresentation(current, false);
      expect(current).toEqual({ surfaceAvailable: false, generation });

      const duplicateSuspension = reduceMainWindowPresentation(current, false);
      expect(duplicateSuspension).toBe(current);

      current = reduceMainWindowPresentation(current, true);
      expect(current).toEqual({ surfaceAvailable: true, generation });

      const duplicateRestoration = reduceMainWindowPresentation(current, true);
      expect(duplicateRestoration).toBe(current);
    }
  });
});
