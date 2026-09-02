import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PetStyleCard } from './FloatingBallPetSettings';
import { CODEX_PET_ATLAS, type PetPack } from '@/floating-ball/petAtlas';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

const pack: PetPack = {
    id: 'preview-pet',
    displayName: 'Preview Pet',
    spritesheetUrl: 'asset://preview-pet.webp',
    atlas: CODEX_PET_ATLAS,
};

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('desktop pet settings preview', () => {
    it('is static by default and loops only while pointer or keyboard interaction is active', () => {
        const view = render(
            <PetStyleCard pack={pack} active={false} onSelect={vi.fn()} />,
        );
        const button = view.getByRole('button', { name: /Preview Pet/ });
        const sprite = view.getByRole('img', { name: 'Preview Pet' });

        expect(sprite).toHaveAttribute('data-pet-playback', 'static-first');
        fireEvent.mouseEnter(button);
        expect(sprite).toHaveAttribute('data-pet-playback', 'loop');
        fireEvent.mouseLeave(button);
        expect(sprite).toHaveAttribute('data-pet-playback', 'static-first');
        fireEvent.focus(button);
        expect(sprite).toHaveAttribute('data-pet-playback', 'loop');

        fireEvent.mouseEnter(button);
        fireEvent.blur(button);
        expect(sprite).toHaveAttribute('data-pet-playback', 'loop');

        fireEvent.focus(button);
        fireEvent.mouseLeave(button);
        expect(sprite).toHaveAttribute('data-pet-playback', 'loop');

        fireEvent.blur(button);
        expect(sprite).toHaveAttribute('data-pet-playback', 'static-first');
    });
});
