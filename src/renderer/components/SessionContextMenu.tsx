import { BarChart2, Copy, Pencil, Pin, PinOff, Star, Trash2 } from 'lucide-react';
import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { SessionMetadata } from '@/api/sessionClient';
import { MenuItem } from '@/components/ui/MenuItem';
import { Popover, type PopoverPlacement } from '@/components/ui/Popover';
import SessionTagMenuItem, { type GlobalUserTagChange } from '@/components/session-tags/SessionTagMenuItem';
import SessionRenameDialog from '@/components/SessionRenameDialog';

interface SessionContextMenuProps {
    open: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLElement | null>;
    placement?: PopoverPlacement;
    session: SessionMetadata;
    deleteProtected: boolean;
    onCopySessionId: () => void | Promise<void>;
    onToggleFavorite: () => void | Promise<void>;
    onTogglePin?: () => void | Promise<void>;
    onRenameSession: (sessionId: string, title: string) => Promise<SessionMetadata | null>;
    onShowStats: (origin?: HTMLElement | null) => void;
    onDelete: (origin?: HTMLElement | null) => void;
    onSessionMutationStart: (sessionId: string, scope?: 'session' | 'global') => number;
    onSessionUpdated?: (session: SessionMetadata, mutationSequence: number) => boolean;
    onGlobalTagChange?: (change: GlobalUserTagChange) => void;
}

/**
 * The single owner of the Session resource menu shared by the global sidebar
 * and history-search overlay. Keep item order, labels and action hints here
 * so the two entry points cannot drift.
 */
export default function SessionContextMenu({
    open,
    onClose,
    anchorRef,
    placement = 'bottom-end',
    session,
    deleteProtected,
    onCopySessionId,
    onToggleFavorite,
    onTogglePin,
    onRenameSession,
    onShowStats,
    onDelete,
    onSessionMutationStart,
    onSessionUpdated,
    onGlobalTagChange,
}: SessionContextMenuProps) {
    const { t } = useTranslation('launcher');
    const [tagLayerOpen, setTagLayerOpen] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);

    const closeRename = () => {
        setRenameOpen(false);
        onClose();
    };

    return (
        <>
            <Popover
                open={open && !renameOpen}
                onClose={onClose}
                anchorRef={anchorRef}
                placement={placement}
                offset={placement === 'bottom-start' ? 0 : undefined}
                className="session-context-menu global-sidebar-nested-layer w-44 py-1"
                closeOnOutsideClick={!tagLayerOpen}
                closeOnEscape={!tagLayerOpen}
            >
                <MenuItem
                    icon={<Pencil className="h-3.5 w-3.5" />}
                    label={t('rightRail.rename')}
                    onClick={() => setRenameOpen(true)}
                />
                <MenuItem
                    icon={<Copy className="h-3.5 w-3.5" />}
                    label={t('rightRail.copySessionId')}
                    onClick={() => {
                        onClose();
                        void onCopySessionId();
                    }}
                />
                {onTogglePin && (
                    <MenuItem
                        icon={session.pinnedAt
                            ? <PinOff className="h-3.5 w-3.5" />
                            : <Pin className="h-3.5 w-3.5" />}
                        label={session.pinnedAt ? t('rightRail.unpin') : t('rightRail.pin')}
                        onClick={() => {
                            onClose();
                            void onTogglePin();
                        }}
                    />
                )}
                <MenuItem
                    icon={<Star className="h-3.5 w-3.5" fill={session.favorite ? 'currentColor' : 'none'} />}
                    label={session.favorite ? t('rightRail.unfavorite') : t('rightRail.favorite')}
                    onClick={() => {
                        onClose();
                        void onToggleFavorite();
                    }}
                />
                <SessionTagMenuItem
                    session={session}
                    onMutationStart={onSessionMutationStart}
                    onSessionUpdated={onSessionUpdated ?? (() => true)}
                    onGlobalTagChange={onGlobalTagChange}
                    onSubmenuOpenChange={setTagLayerOpen}
                />
                <MenuItem
                    icon={<BarChart2 className="h-3.5 w-3.5" />}
                    label={t('rightRail.viewStats')}
                    onClick={() => {
                        onClose();
                        onShowStats(anchorRef.current);
                    }}
                />
                <MenuItem
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    label={t('rightRail.delete')}
                    tone="danger"
                    title={deleteProtected ? t('rightRail.deleteBlockedByOwner') : undefined}
                    onClick={() => {
                        onClose();
                        onDelete(anchorRef.current);
                    }}
                />
            </Popover>
            {renameOpen && (
                <SessionRenameDialog
                    currentTitle={session.title}
                    onCancel={closeRename}
                    onConfirm={async (title) => {
                        const updated = await onRenameSession(session.id, title);
                        if (!updated) throw new Error('Session no longer exists.');
                        closeRename();
                    }}
                />
            )}
        </>
    );
}
