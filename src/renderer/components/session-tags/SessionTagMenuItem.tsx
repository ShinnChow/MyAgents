import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Loader2, Pencil, Search, Tags, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
    getSessions,
    getSessionUserTags,
    mutateGlobalSessionUserTag,
    mutateSessionUserTagAssignment,
    SessionUserTagApiError,
    type SessionMetadata,
} from '@/api/sessionClient';
import ConfirmDialog from '@/components/ConfirmDialog';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { MenuItem } from '@/components/ui/MenuItem';
import { Popover } from '@/components/ui/Popover';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import {
    MAX_SESSION_USER_TAGS,
    normalizeSessionUserTag,
    sanitizeSessionUserTags,
    type SessionUserTagSummary,
} from '../../../shared/session-user-tags';

export interface GlobalUserTagChange {
    kind: 'rename' | 'delete';
    name: string;
    newName?: string;
}

interface SessionTagMenuItemProps {
    session: Pick<SessionMetadata, 'id' | 'userTags'>;
    onMutationStart: (sessionId: string, scope?: 'session' | 'global') => number;
    onSessionUpdated: (session: SessionMetadata, mutationSequence: number) => boolean;
    onGlobalTagChange?: (change: GlobalUserTagChange) => void;
    onSubmenuOpenChange?: (open: boolean) => void;
}

function mutationErrorKey(error: unknown): string {
    if (!(error instanceof SessionUserTagApiError)) return 'sessionTags.errors.ioError';
    switch (error.reason) {
        case 'invalid-name': return 'sessionTags.errors.invalidName';
        case 'session-not-found': return 'sessionTags.errors.sessionNotFound';
        case 'protected-session': return 'sessionTags.errors.protectedSession';
        case 'limit-reached': return 'sessionTags.errors.limitReached';
        case 'tag-not-found': return 'sessionTags.errors.tagNotFound';
        case 'conflict': return 'sessionTags.errors.conflict';
        default: return 'sessionTags.errors.ioError';
    }
}

interface SessionTagManagerProps {
    open: boolean;
    tags: SessionUserTagSummary[];
    focusSessionId: string;
    onMutationStart: (sessionId: string, scope?: 'session' | 'global') => number;
    onClose: () => void;
    onChanged: (tags: SessionUserTagSummary[], session: SessionMetadata | undefined, change: GlobalUserTagChange | null, mutationSequence: number) => void;
}

function SessionTagManager({ open, tags, focusSessionId, onMutationStart, onClose, onChanged }: SessionTagManagerProps) {
    const { t } = useTranslation('common');
    const [editing, setEditing] = useState<string | null>(null);
    const [nextName, setNextName] = useState('');
    const [pendingDelete, setPendingDelete] = useState<SessionUserTagSummary | null>(null);
    const [pendingMerge, setPendingMerge] = useState<{ source: string; target: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dialogRef = useRef<HTMLElement | null>(null);
    const closeBlockedRef = useRef(false);
    const onCloseRef = useRef(onClose);
    closeBlockedRef.current = busy || !!pendingDelete || !!pendingMerge;
    onCloseRef.current = onClose;

    useCloseLayer(() => {
        if (!open || busy || pendingDelete || pendingMerge) return false;
        onClose();
        return true;
    }, 280);

    useEffect(() => {
        if (!open) {
            setEditing(null);
            setPendingDelete(null);
            setPendingMerge(null);
            setError(null);
        }
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const previouslyFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        queueMicrotask(() => {
            const preferred = dialogRef.current?.querySelector<HTMLElement>('[data-manager-autofocus]');
            (preferred ?? dialogRef.current)?.focus();
        });
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (closeBlockedRef.current) return;
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current?.contains(document.activeElement)) return;
            const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            )].filter((element) => !element.hasAttribute('aria-hidden'));
            if (focusable.length === 0) {
                event.preventDefault();
                dialogRef.current.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
            queueMicrotask(() => previouslyFocused?.focus());
        };
    }, [open]);

    const runRename = useCallback(async (merge: boolean) => {
        if (!editing) return;
        const normalized = normalizeSessionUserTag(nextName);
        if (!normalized.ok) {
            setError(t('sessionTags.errors.invalidName'));
            return;
        }
        setBusy(true);
        setError(null);
        const mutationSequence = onMutationStart(focusSessionId, 'global');
        try {
            const result = await mutateGlobalSessionUserTag({
                kind: 'rename',
                name: editing,
                newName: normalized.tag.name,
                merge,
            }, focusSessionId);
            onChanged(result.tags, result.session, {
                kind: 'rename',
                name: editing,
                newName: normalized.tag.name,
            }, mutationSequence);
            setEditing(null);
            setPendingMerge(null);
        } catch (requestError) {
            if (requestError instanceof SessionUserTagApiError && requestError.reason === 'merge-required') {
                setPendingMerge({ source: editing, target: requestError.targetName ?? normalized.tag.name });
            } else {
                setError(t(mutationErrorKey(requestError)));
                try {
                    const [freshTags, sessions] = await Promise.all([getSessionUserTags(), getSessions()]);
                    onChanged(
                        freshTags,
                        sessions.find((session) => session.id === focusSessionId),
                        null,
                        mutationSequence,
                    );
                } catch {
                    // Keep the mutation error visible; the store's metadata watcher remains a fallback.
                }
            }
        } finally {
            setBusy(false);
        }
    }, [editing, focusSessionId, nextName, onChanged, onMutationStart, t]);

    const runDelete = useCallback(async () => {
        if (!pendingDelete) return;
        setBusy(true);
        setError(null);
        const mutationSequence = onMutationStart(focusSessionId, 'global');
        try {
            const result = await mutateGlobalSessionUserTag(
                { kind: 'delete', name: pendingDelete.name },
                focusSessionId,
            );
            onChanged(result.tags, result.session, { kind: 'delete', name: pendingDelete.name }, mutationSequence);
            setPendingDelete(null);
        } catch (requestError) {
            setError(t(mutationErrorKey(requestError)));
            try {
                const [freshTags, sessions] = await Promise.all([getSessionUserTags(), getSessions()]);
                onChanged(
                    freshTags,
                    sessions.find((session) => session.id === focusSessionId),
                    null,
                    mutationSequence,
                );
            } catch {
                // Keep the mutation error visible; the store's metadata watcher remains a fallback.
            }
        } finally {
            setBusy(false);
        }
    }, [focusSessionId, onChanged, onMutationStart, pendingDelete, t]);

    if (!open) return null;

    return (
        <OverlayBackdrop
            onClose={busy || pendingDelete || pendingMerge ? undefined : onClose}
            className="z-[280] px-4"
            portal
        >
            <section
                ref={dialogRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="session-tag-manager-title"
                className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-2xl"
            >
                <header className="flex items-center justify-between border-b border-[var(--line-subtle)] px-5 py-4">
                    <div>
                        <h2 id="session-tag-manager-title" className="font-semibold text-[var(--ink)]">
                            {t('sessionTags.manager.title')}
                        </h2>
                        <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{t('sessionTags.manager.description')}</p>
                    </div>
                    <button
                        type="button"
                        data-manager-autofocus
                        disabled={busy || !!pendingDelete || !!pendingMerge}
                        onClick={onClose}
                        aria-label={t('sessionTags.close')}
                        className="rounded-md p-1.5 text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {tags.length === 0 ? (
                        <p className="py-8 text-center text-sm text-[var(--ink-muted)]">{t('sessionTags.manager.empty')}</p>
                    ) : tags.map((tag) => (
                        <div key={tag.name.toLowerCase()} className="flex min-h-11 items-center gap-2 rounded-lg px-2 hover:bg-[var(--hover-bg)]">
                            {editing === tag.name ? (
                                <form
                                    className="flex min-w-0 flex-1 items-center gap-2"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void runRename(false);
                                    }}
                                >
                                    <input
                                        autoFocus
                                        value={nextName}
                                        onChange={(event) => setNextName(event.target.value)}
                                        maxLength={64}
                                        aria-label={t('sessionTags.manager.renameInput', { name: tag.name })}
                                        className="h-8 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                                    />
                                    <button type="submit" disabled={busy} className="rounded-md px-2 py-1 text-sm text-[var(--accent)] hover:bg-[var(--hover-bg)] disabled:opacity-50">
                                        {t('sessionTags.manager.save')}
                                    </button>
                                    <button type="button" onClick={() => setEditing(null)} className="rounded-md px-2 py-1 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]">
                                        {t('sessionTags.manager.cancel')}
                                    </button>
                                </form>
                            ) : (
                                <>
                                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]" title={tag.name}>{tag.name}</span>
                                    <span className="shrink-0 text-xs text-[var(--ink-muted)]">{t('sessionTags.sessionCount', { count: tag.count })}</span>
                                    <button
                                        type="button"
                                        aria-label={t('sessionTags.manager.rename', { name: tag.name })}
                                        onClick={() => { setEditing(tag.name); setNextName(tag.name); setError(null); }}
                                        className="rounded-md p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t('sessionTags.manager.delete', { name: tag.name })}
                                        onClick={() => setPendingDelete(tag)}
                                        className="rounded-md p-1.5 text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </>
                            )}
                        </div>
                    ))}
                    {error && <p role="alert" className="px-2 pt-2 text-xs text-[var(--error)]">{error}</p>}
                </div>
            </section>
            {pendingDelete && (
                <ConfirmDialog
                    title={t('sessionTags.manager.deleteTitle')}
                    message={t('sessionTags.manager.deleteMessage', { name: pendingDelete.name, count: pendingDelete.count })}
                    confirmText={t('sessionTags.manager.deleteConfirm')}
                    confirmVariant="danger"
                    onConfirm={() => { void runDelete(); }}
                    onCancel={() => setPendingDelete(null)}
                />
            )}
            {pendingMerge && (
                <ConfirmDialog
                    title={t('sessionTags.manager.mergeTitle')}
                    message={t('sessionTags.manager.mergeMessage', pendingMerge)}
                    confirmText={t('sessionTags.manager.mergeConfirm')}
                    onConfirm={() => { void runRename(true); }}
                    onCancel={() => setPendingMerge(null)}
                />
            )}
        </OverlayBackdrop>
    );
}

/** Shared parent-menu row and checkbox submenu for Session user Tags. */
export default function SessionTagMenuItem({
    session,
    onMutationStart,
    onSessionUpdated,
    onGlobalTagChange,
    onSubmenuOpenChange,
}: SessionTagMenuItemProps) {
    const { t } = useTranslation('common');
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [open, setOpen] = useState(false);
    const [managerOpen, setManagerOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [tags, setTags] = useState<SessionUserTagSummary[]>([]);
    const [selected, setSelected] = useState(() => sanitizeSessionUserTags(session.userTags));
    const [loading, setLoading] = useState(false);
    const [mutating, setMutating] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);

    const closePicker = useCallback(() => {
        setOpen(false);
        queueMicrotask(() => anchorRef.current?.focus());
    }, []);

    useEffect(() => setSelected(sanitizeSessionUserTags(session.userTags)), [session.userTags]);
    useEffect(() => onSubmenuOpenChange?.(open || managerOpen), [managerOpen, onSubmenuOpenChange, open]);

    const loadTags = useCallback(async (clearError = true) => {
        setLoading(true);
        if (clearError) setError(null);
        try {
            setTags(await getSessionUserTags());
        } catch {
            if (clearError) setError(t('sessionTags.errors.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (!open) return;
        setQuery('');
        setActiveIndex(0);
        void loadTags();
        queueMicrotask(() => inputRef.current?.focus());
    }, [loadTags, open]);

    const selectedIdentity = useMemo(() => new Set(selected.map((name) => name.toLowerCase())), [selected]);
    const normalizedQuery = normalizeSessionUserTag(query);
    const candidates = useMemo(() => {
        const needle = query.trim().normalize('NFC').toLowerCase();
        const matching = tags.filter((tag) => !needle || tag.name.toLowerCase().includes(needle));
        const selectedRows = selected.flatMap((name) => {
            const summary = matching.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
            return summary ? [summary] : [];
        });
        const selectedKeys = new Set(selectedRows.map((tag) => tag.name.toLowerCase()));
        return [
            ...selectedRows,
            ...matching
                .filter((tag) => !selectedKeys.has(tag.name.toLowerCase()))
                .sort((left, right) => left.name.localeCompare(right.name)),
        ];
    }, [query, selected, tags]);
    const exactMatch = normalizedQuery.ok
        ? tags.some((tag) => tag.name.toLowerCase() === normalizedQuery.tag.identity)
        : true;
    const canCreate = normalizedQuery.ok && !exactMatch;
    const atLimit = selected.length >= MAX_SESSION_USER_TAGS;
    const actionCount = candidates.length + (canCreate ? 1 : 0);

    const toggle = useCallback(async (name: string, forceAdd = false) => {
        if (mutating) return;
        const isSelected = selectedIdentity.has(name.toLowerCase());
        if (!isSelected && atLimit) return;
        const mutationSequence = onMutationStart(session.id);
        setMutating(name);
        setError(null);
        try {
            const result = await mutateSessionUserTagAssignment(session.id, {
                kind: isSelected && !forceAdd ? 'remove' : 'add',
                name,
            });
            if (result.session) {
                const accepted = onSessionUpdated(result.session, mutationSequence);
                if (accepted) setSelected(sanitizeSessionUserTags(result.session.userTags));
            }
            setTags(result.tags);
            if (forceAdd) setQuery('');
        } catch (requestError) {
            const mutationError = t(mutationErrorKey(requestError));
            setError(mutationError);
            await Promise.all([
                loadTags(false),
                getSessions().then((sessions) => {
                    const fresh = sessions.find((candidate) => candidate.id === session.id);
                    if (fresh && onSessionUpdated(fresh, mutationSequence)) {
                        setSelected(sanitizeSessionUserTags(fresh.userTags));
                    }
                }).catch(() => undefined),
            ]);
            setError(mutationError);
        } finally {
            setMutating(null);
        }
    }, [atLimit, loadTags, mutating, onMutationStart, onSessionUpdated, selectedIdentity, session.id, t]);

    const handleGlobalChanged = useCallback((nextTags: SessionUserTagSummary[], updatedSession: SessionMetadata | undefined, change: GlobalUserTagChange | null, mutationSequence: number) => {
        setTags(nextTags);
        if (updatedSession) {
            const accepted = onSessionUpdated(updatedSession, mutationSequence);
            if (accepted) setSelected(sanitizeSessionUserTags(updatedSession.userTags));
        }
        if (change) onGlobalTagChange?.(change);
    }, [onGlobalTagChange, onSessionUpdated]);

    const invokeActive = useCallback(() => {
        if (activeIndex < candidates.length) {
            void toggle(candidates[activeIndex].name);
        } else if (canCreate && normalizedQuery.ok) {
            void toggle(normalizedQuery.tag.name, true);
        }
    }, [activeIndex, canCreate, candidates, normalizedQuery, toggle]);

    return (
        <>
            <MenuItem
                ref={anchorRef}
                icon={<Tags className="h-3.5 w-3.5" />}
                label={t('sessionTags.addTag')}
                trailing={<ChevronRight className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />}
                active={open}
                onClick={() => setOpen((current) => !current)}
            />
            <Popover
                open={open}
                onClose={closePicker}
                anchorRef={anchorRef}
                placement="right-start"
                offset={6}
                zIndex={262}
                className="w-72"
            >
                <div className="border-b border-[var(--line-subtle)] p-2">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[var(--ink-muted)]" />
                        <input
                            ref={inputRef}
                            value={query}
                            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowDown') {
                                    event.preventDefault();
                                    setActiveIndex((index) => Math.min(actionCount - 1, index + 1));
                                } else if (event.key === 'ArrowUp') {
                                    event.preventDefault();
                                    setActiveIndex((index) => Math.max(0, index - 1));
                                } else if (event.key === 'Enter' && actionCount > 0) {
                                    event.preventDefault();
                                    invokeActive();
                                } else if (event.key === 'Escape') {
                                    event.stopPropagation();
                                    closePicker();
                                }
                            }}
                            aria-label={t('sessionTags.searchTags')}
                            placeholder={t('sessionTags.searchTags')}
                            className="h-8 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] pl-8 pr-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                    </div>
                </div>
                <div role="menu" aria-label={t('sessionTags.addTag')} className="max-h-64 overflow-y-auto py-1">
                    {loading ? (
                        <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-[var(--ink-muted)]" /></div>
                    ) : (
                        <>
                            {candidates.map((tag, index) => {
                                const checked = selectedIdentity.has(tag.name.toLowerCase());
                                const disabled = mutating !== null || (!checked && atLimit);
                                return (
                                    <button
                                        key={tag.name.toLowerCase()}
                                        type="button"
                                        role="menuitemcheckbox"
                                        aria-checked={checked}
                                        disabled={disabled}
                                        onMouseEnter={() => setActiveIndex(index)}
                                        onClick={() => { void toggle(tag.name); }}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45 ${activeIndex === index ? 'bg-[var(--hover-bg)]' : ''}`}
                                    >
                                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]' : 'border-[var(--line-strong)]'}`}>
                                            {checked && <Check className="h-3 w-3" />}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                                        {mutating?.toLowerCase() === tag.name.toLowerCase() && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--ink-muted)]" />}
                                    </button>
                                );
                            })}
                            {canCreate && normalizedQuery.ok && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    disabled={atLimit || mutating !== null}
                                    onMouseEnter={() => setActiveIndex(candidates.length)}
                                    onClick={() => { void toggle(normalizedQuery.tag.name, true); }}
                                    className={`w-full px-3 py-2 text-left text-sm text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45 ${activeIndex === candidates.length ? 'bg-[var(--hover-bg)]' : ''}`}
                                >
                                    {t('sessionTags.createTag', { name: normalizedQuery.tag.name })}
                                </button>
                            )}
                            {candidates.length === 0 && !canCreate && !loading && (
                                <p className="px-3 py-5 text-center text-xs text-[var(--ink-muted)]">{t('sessionTags.noTags')}</p>
                            )}
                        </>
                    )}
                </div>
                {(atLimit || error) && (
                    <p role={error ? 'alert' : undefined} className={`border-t border-[var(--line-subtle)] px-3 py-2 text-xs ${error ? 'text-[var(--error)]' : 'text-[var(--ink-muted)]'}`}>
                        {error ?? t('sessionTags.limitHint', { count: MAX_SESSION_USER_TAGS })}
                    </p>
                )}
                <button
                    type="button"
                    onClick={() => { setOpen(false); setManagerOpen(true); }}
                    className="flex w-full items-center gap-2 border-t border-[var(--line-subtle)] px-3 py-2 text-left text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                    <Tags className="h-3.5 w-3.5" />
                    {t('sessionTags.manageTags')}
                </button>
            </Popover>
            <SessionTagManager
                open={managerOpen}
                tags={tags}
                focusSessionId={session.id}
                onMutationStart={onMutationStart}
                onClose={() => {
                    setManagerOpen(false);
                    queueMicrotask(() => anchorRef.current?.focus());
                }}
                onChanged={handleGlobalChanged}
            />
        </>
    );
}
