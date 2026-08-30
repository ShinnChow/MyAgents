import type { FbBallState } from './petStateMapper';

export type PetPlaybackMode = 'static-first' | 'static-final' | 'loop' | 'once-final';

export interface FloatingPetPlaybackInput {
    ballState: FbBallState;
    dragging?: boolean;
    summonPulse?: boolean;
    donePulse?: boolean;
    hasError?: boolean;
}

export function deriveFloatingPetPlayback(input: FloatingPetPlaybackInput): PetPlaybackMode {
    if (input.dragging || input.summonPulse || input.ballState === 'running') return 'loop';
    if (input.hasError || input.ballState === 'blocked') return 'once-final';
    if (input.ballState === 'done') return input.donePulse ? 'once-final' : 'static-final';
    return 'static-first';
}

export function derivePetPreviewPlayback(interacting: boolean): PetPlaybackMode {
    return interacting ? 'loop' : 'static-first';
}

export function resolvePetPlaybackForReducedMotion(
    playback: PetPlaybackMode,
    reducedMotion: boolean,
): PetPlaybackMode {
    if (!reducedMotion) return playback;
    return playback === 'static-final' || playback === 'once-final'
        ? 'static-final'
        : 'static-first';
}
