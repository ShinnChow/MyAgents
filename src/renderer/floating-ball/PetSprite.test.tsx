import { cleanup, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PetSprite } from './PetSprite';
import { CODEX_PET_ATLAS, type PetPack } from './petAtlas';

const pack: PetPack = {
    id: 'test-pet',
    displayName: 'Test Pet',
    spritesheetUrl: 'asset://test-pet.webp',
    atlas: CODEX_PET_ATLAS,
};

describe('PetSprite scheduler lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('matchMedia', vi.fn(() => ({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })));
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('creates no recursive timer for an idle static frame', () => {
        const view = render(<PetSprite pack={pack} animation="idle" playback="static-first" />);
        const sprite = view.getByRole('img');
        expect(sprite).toHaveAttribute('data-pet-playback', 'static-first');
        expect(sprite).toHaveStyle({ backgroundPosition: '0px 0px' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('loops only while requested and clears scheduling on a static transition', async () => {
        const view = render(<PetSprite pack={pack} animation="idle" playback="loop" />);
        expect(vi.getTimerCount()).toBe(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(280); });
        expect(view.getByRole('img')).toHaveStyle({ backgroundPosition: '-76px 0px' });

        view.rerender(<PetSprite pack={pack} animation="idle" playback="static-first" />);
        expect(vi.getTimerCount()).toBe(0);
        expect(view.getByRole('img')).toHaveStyle({ backgroundPosition: '0px 0px' });
    });

    it('clears recursive scheduling when the sprite unmounts', () => {
        const view = render(<PetSprite pack={pack} animation="idle" playback="loop" />);
        expect(vi.getTimerCount()).toBe(1);

        view.unmount();

        expect(vi.getTimerCount()).toBe(0);
    });

    it('plays one notification cycle and freezes on its final frame', async () => {
        const view = render(<PetSprite pack={pack} animation="idle" playback="once-final" />);
        await act(async () => { await vi.advanceTimersByTimeAsync(780); });

        expect(view.getByRole('img')).toHaveStyle({ backgroundPosition: '-380px 0px' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('lets reduced-motion replace unbounded playback with a static frame', () => {
        vi.mocked(matchMedia).mockReturnValue({
            matches: true,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        } as unknown as MediaQueryList);
        const view = render(<PetSprite pack={pack} animation="idle" playback="loop" />);
        expect(view.getByRole('img')).toHaveAttribute('data-pet-playback', 'static-first');
        expect(vi.getTimerCount()).toBe(0);
    });
});
