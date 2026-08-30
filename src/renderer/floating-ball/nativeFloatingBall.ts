import { invoke } from '@tauri-apps/api/core';

import { i18n } from '@/i18n';
import { isTauriEnvironment } from '@/utils/browserMock';

interface FbCapabilities {
    supported: boolean;
    active: boolean;
}

export function describeNativeFloatingBallError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export async function setNativeFloatingBallEnabled(
    enabled: boolean,
    messages?: { unsupported?: string },
): Promise<void> {
    if (!isTauriEnvironment()) return;

    if (enabled) {
        const capabilities = await invoke<FbCapabilities>('cmd_fb_capabilities');
        if (!capabilities.supported) {
            throw new Error(messages?.unsupported ?? String(i18n.t('floatingBallPet.toasts.unsupportedSystem', { ns: 'settings' })));
        }
        await invoke('cmd_fb_enable');
        return;
    }

    await invoke('cmd_fb_disable');
}

export async function runFloatingBallToggleTransaction(options: {
    enabled: boolean;
    nativeStateBeforeChange?: boolean;
    persistDesiredState: (enabled: boolean) => Promise<unknown>;
    applyNativeState: (enabled: boolean) => Promise<unknown>;
}): Promise<void> {
    const {
        enabled,
        nativeStateBeforeChange = !enabled,
        persistDesiredState,
        applyNativeState,
    } = options;
    if (enabled) {
        // A newly-created Companion may begin boot immediately, so durable
        // desired state must already authorize it before native surfaces exist.
        await persistDesiredState(true);
        try {
            await applyNativeState(true);
        } catch (nativeError) {
            try {
                await persistDesiredState(false);
            } catch (rollbackError) {
                throw new Error(
                    `${describeNativeFloatingBallError(nativeError)}; configRollback=${describeNativeFloatingBallError(rollbackError)}`,
                );
            }
            throw nativeError;
        }
        return;
    }

    // Rust first releases the exact Companion owner and all native surfaces.
    // Only then may config commit false. If disk commit fails, durable truth is
    // unchanged and the same toggle transaction restores its prior native state.
    await applyNativeState(false);
    try {
        await persistDesiredState(false);
    } catch (persistError) {
        try {
            await applyNativeState(nativeStateBeforeChange);
        } catch (restoreError) {
            throw new Error(
                `${describeNativeFloatingBallError(persistError)}; nativeRestore=${describeNativeFloatingBallError(restoreError)}`,
            );
        }
        throw persistError;
    }
}
