import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { getPetAnimationSpec, type CodexPetAnimationName, type PetPack } from './petAtlas';
import {
    resolvePetPlaybackForReducedMotion,
    type PetPlaybackMode,
} from './petPlayback';

const PET_DISPLAY_W = 76;
const PET_DISPLAY_H = 82;

function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    });

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onChange = () => setReduced(query.matches);
        onChange();
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);

    return reduced;
}

export interface PetSpriteProps {
    pack: PetPack;
    animation: CodexPetAnimationName;
    className?: string;
    title?: string;
    playback?: PetPlaybackMode;
    onLoadError?: () => void;
}

export function PetSprite({
    pack,
    animation,
    className,
    title,
    playback = 'static-first',
    onLoadError,
}: PetSpriteProps) {
    const spriteRef = useRef<HTMLDivElement | null>(null);
    const reduceMotion = usePrefersReducedMotion();
    const spec = getPetAnimationSpec(pack.atlas, animation);
    const effectivePlayback = resolvePetPlaybackForReducedMotion(playback, reduceMotion);
    const backgroundSize = `${pack.atlas.columns * PET_DISPLAY_W}px ${pack.atlas.rows * PET_DISPLAY_H}px`;
    const initialBackgroundPosition = `0px -${spec.row * PET_DISPLAY_H}px`;
    const style = useMemo<CSSProperties>(
        () => ({
            backgroundImage: `url("${pack.spritesheetUrl}")`,
            backgroundSize,
            backgroundPosition: initialBackgroundPosition,
            filter: pack.spriteFilter,
        }),
        [backgroundSize, initialBackgroundPosition, pack.spriteFilter, pack.spritesheetUrl],
    );

    useEffect(() => {
        const image = new Image();
        image.onerror = () => onLoadError?.();
        image.src = pack.spritesheetUrl;
        return () => {
            image.onerror = null;
        };
    }, [onLoadError, pack.spritesheetUrl]);

    useEffect(() => {
        const el = spriteRef.current;
        if (!el) return;

        let cancelled = false;
        let timer: number | null = null;
        let frame = effectivePlayback === 'static-final' ? spec.frames - 1 : 0;

        const renderFrame = () => {
            if (cancelled) return;
            el.style.backgroundPosition = `-${frame * PET_DISPLAY_W}px -${spec.row * PET_DISPLAY_H}px`;
            if (
                spec.frames <= 1
                || effectivePlayback === 'static-first'
                || effectivePlayback === 'static-final'
            ) return;
            const delay = spec.frameDurations[frame] ?? 160;
            if (effectivePlayback === 'once-final' && frame >= spec.frames - 1) return;
            frame = effectivePlayback === 'loop' ? (frame + 1) % spec.frames : frame + 1;
            timer = window.setTimeout(renderFrame, delay);
        };

        renderFrame();
        return () => {
            cancelled = true;
            if (timer !== null) window.clearTimeout(timer);
        };
    }, [animation, effectivePlayback, spec]);

    return (
        <div
            ref={spriteRef}
            className={`fbw-pet-sprite${className ? ` ${className}` : ''}`}
            role="img"
            aria-label={title ?? pack.displayName}
            data-pet-playback={effectivePlayback}
            style={style}
        />
    );
}
