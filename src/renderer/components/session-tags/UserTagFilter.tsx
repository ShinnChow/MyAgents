import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Tags } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Popover } from '@/components/ui/Popover';
import type { SessionUserTagSummary } from '../../../shared/session-user-tags';

interface UserTagFilterProps {
    tags: SessionUserTagSummary[];
    value: string | null;
    onChange: (name: string | null) => void;
}

export default function UserTagFilter({ tags, value, onChange }: UserTagFilterProps) {
    const { t } = useTranslation('common');
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const filtered = useMemo(() => {
        const needle = query.trim().normalize('NFC').toLowerCase();
        return tags.filter((tag) => !needle || tag.name.toLowerCase().includes(needle));
    }, [query, tags]);

    const close = () => {
        setOpen(false);
        setQuery('');
        queueMicrotask(() => triggerRef.current?.focus());
    };

    const select = (name: string | null) => {
        onChange(name);
        setOpen(false);
        setQuery('');
        queueMicrotask(() => triggerRef.current?.focus());
    };

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    setOpen((current) => !current);
                    queueMicrotask(() => inputRef.current?.focus());
                }}
                className="flex h-8 w-40 shrink-0 items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 text-sm text-[var(--ink-secondary)] transition-colors hover:border-[var(--line-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/20"
            >
                <Tags className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
                <span className="min-w-0 flex-1 truncate text-left">{value ?? t('sessionTags.allTags')}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
            </button>
            <Popover
                open={open}
                onClose={close}
                anchorRef={triggerRef}
                placement="bottom-start"
                matchAnchorWidth
                className="w-56"
            >
                <div className="border-b border-[var(--line-subtle)] p-2">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-[var(--ink-muted)]" />
                        <input
                            ref={inputRef}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                    event.stopPropagation();
                                    close();
                                }
                            }}
                            placeholder={t('sessionTags.searchTags')}
                            aria-label={t('sessionTags.searchTags')}
                            className="h-8 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] pl-7 pr-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                        />
                    </div>
                </div>
                <div role="listbox" aria-label={t('sessionTags.filterLabel')} className="max-h-60 overflow-y-auto py-1">
                    <button
                        type="button"
                        role="option"
                        aria-selected={value === null}
                        onClick={() => select(null)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)]"
                    >
                        <span className="w-4">{value === null && <Check className="h-3.5 w-3.5 text-[var(--accent)]" />}</span>
                        <span className="flex-1">{t('sessionTags.allTags')}</span>
                    </button>
                    {filtered.map((tag) => (
                        <button
                            key={tag.name.toLowerCase()}
                            type="button"
                            role="option"
                            aria-selected={value?.toLowerCase() === tag.name.toLowerCase()}
                            onClick={() => select(tag.name)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)]"
                        >
                            <span className="w-4">{value?.toLowerCase() === tag.name.toLowerCase() && <Check className="h-3.5 w-3.5 text-[var(--accent)]" />}</span>
                            <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                            <span className="text-xs text-[var(--ink-muted)]">{tag.count}</span>
                        </button>
                    ))}
                    {filtered.length === 0 && (
                        <p className="px-3 py-5 text-center text-xs text-[var(--ink-muted)]">{t('sessionTags.noTags')}</p>
                    )}
                </div>
            </Popover>
        </>
    );
}
