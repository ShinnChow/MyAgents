import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    deriveFloatingPetPlayback,
    derivePetPreviewPlayback,
    resolvePetPlaybackForReducedMotion,
} from './petPlayback';

describe('desktop pet playback policy', () => {
    it('keeps idle static and permits loops only for continuous activity', () => {
        expect(deriveFloatingPetPlayback({ ballState: 'idle' })).toBe('static-first');
        expect(deriveFloatingPetPlayback({ ballState: 'running' })).toBe('loop');
        expect(deriveFloatingPetPlayback({ ballState: 'idle', dragging: true })).toBe('loop');
        expect(deriveFloatingPetPlayback({ ballState: 'idle', summonPulse: true })).toBe('loop');
    });

    it('bounds notification feedback and preserves a static final result', () => {
        expect(deriveFloatingPetPlayback({ ballState: 'blocked' })).toBe('once-final');
        expect(deriveFloatingPetPlayback({ ballState: 'done', donePulse: true })).toBe('once-final');
        expect(deriveFloatingPetPlayback({ ballState: 'done' })).toBe('static-final');
        expect(deriveFloatingPetPlayback({ ballState: 'idle', hasError: true })).toBe('once-final');
    });

    it('runs settings previews only during interaction and lets reduced-motion win', () => {
        expect(derivePetPreviewPlayback(false)).toBe('static-first');
        expect(derivePetPreviewPlayback(true)).toBe('loop');
        expect(resolvePetPlaybackForReducedMotion('loop', true)).toBe('static-first');
        expect(resolvePetPlaybackForReducedMotion('once-final', true)).toBe('static-final');
    });

    it('lets reduced-motion stop every companion descendant animation', () => {
        const floatingBallCss = readFileSync(new URL('./fb.css', import.meta.url), 'utf8');
        const reducedMotionRules = floatingBallCss.slice(
            floatingBallCss.indexOf('@media (prefers-reduced-motion: reduce)'),
        );
        expect(reducedMotionRules).toContain('.fbw-ball *');
        expect(reducedMotionRules).toContain('.fbw-win *');
        expect(reducedMotionRules).toContain('animation: none !important');
    });
});
