import { describe, expect, it, vi } from 'vitest';

import { runFloatingBallToggleTransaction } from './nativeFloatingBall';

describe('floating ball toggle transaction', () => {
    it('persists enable before creating surfaces and rolls config back on native failure', async () => {
        const calls: string[] = [];
        const persist = vi.fn(async (enabled: boolean) => { calls.push(`persist:${enabled}`); });
        const native = vi.fn(async (enabled: boolean) => {
            calls.push(`native:${enabled}`);
            if (enabled) throw new Error('native failed');
        });

        await expect(runFloatingBallToggleTransaction({
            enabled: true,
            persistDesiredState: persist,
            applyNativeState: native,
        })).rejects.toThrow('native failed');
        expect(calls).toEqual(['persist:true', 'native:true', 'persist:false']);
    });

    it('commits disable only after teardown and restores native state on config failure', async () => {
        const calls: string[] = [];
        const persist = vi.fn(async (enabled: boolean) => {
            calls.push(`persist:${enabled}`);
            if (!enabled) throw new Error('disk failed');
        });
        const native = vi.fn(async (enabled: boolean) => { calls.push(`native:${enabled}`); });

        await expect(runFloatingBallToggleTransaction({
            enabled: false,
            persistDesiredState: persist,
            applyNativeState: native,
        })).rejects.toThrow('disk failed');
        expect(calls).toEqual(['native:false', 'persist:false', 'native:true']);
    });

    it('keeps native disabled when a gate-only config write fails from an already-disabled state', async () => {
        const calls: string[] = [];
        const persist = vi.fn(async (enabled: boolean) => {
            calls.push(`persist:${enabled}`);
            throw new Error('disk failed');
        });
        const native = vi.fn(async (enabled: boolean) => { calls.push(`native:${enabled}`); });

        await expect(runFloatingBallToggleTransaction({
            enabled: false,
            nativeStateBeforeChange: false,
            persistDesiredState: persist,
            applyNativeState: native,
        })).rejects.toThrow('disk failed');
        expect(calls).toEqual(['native:false', 'persist:false', 'native:false']);
    });
});
