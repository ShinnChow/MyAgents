import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { sanitizeSessionUserTags } from '../../../shared/session-user-tags';
import { Popover } from '@/components/ui/Popover';

interface UserTagPillsProps {
    tags?: readonly string[];
    onTagClick: (name: string) => void;
    maxVisible?: number;
    className?: string;
}

function TagButton({ name, onClick }: { name: string; onClick: () => void }) {
    return (
        <button
            type="button"
            title={name}
            aria-label={name}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
            className="inline-flex h-5 max-w-28 shrink-0 items-center truncate rounded-full border border-[var(--accent)]/20 bg-[var(--accent-warm-subtle)] px-2 text-xs font-medium text-[var(--accent)] transition-colors hover:border-[var(--accent)]/35 hover:bg-[var(--accent-warm-subtle)]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/25"
        >
            <span className="truncate">{name}</span>
        </button>
    );
}

/** Read-only user Tag cluster used by Chat and global history surfaces. */
export default function UserTagPills({
    tags,
    onTagClick,
    maxVisible = 2,
    className = '',
}: UserTagPillsProps) {
    const { t } = useTranslation('common');
    const names = sanitizeSessionUserTags(tags);
    const visible = names.slice(0, maxVisible);
    const overflow = names.slice(maxVisible);
    const moreRef = useRef<HTMLButtonElement | null>(null);
    const [overflowOpen, setOverflowOpen] = useState(false);
    const closeOverflow = () => {
        setOverflowOpen(false);
        queueMicrotask(() => moreRef.current?.focus());
    };

    if (names.length === 0) return null;

    return (
        <div className={`flex min-w-0 shrink items-center gap-1 ${className}`.trim()} data-user-tag-pills>
            {visible.map((name) => (
                <TagButton key={name.toLowerCase()} name={name} onClick={() => onTagClick(name)} />
            ))}
            {overflow.length > 0 && (
                <>
                    <button
                        ref={moreRef}
                        type="button"
                        aria-label={t('sessionTags.showMore', { count: overflow.length })}
                        aria-expanded={overflowOpen}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setOverflowOpen((current) => !current);
                        }}
                        className="inline-flex h-5 shrink-0 items-center rounded-full border border-[var(--line)] bg-[var(--paper-inset)] px-1.5 text-xs font-medium text-[var(--ink-muted)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/25"
                    >
                        +{overflow.length}
                    </button>
                    <Popover
                        open={overflowOpen}
                        onClose={closeOverflow}
                        anchorRef={moreRef}
                        placement="bottom-start"
                        className="w-48 p-1"
                    >
                        <div className="flex flex-wrap gap-1 p-1" role="list" aria-label={t('sessionTags.remainingTags')}>
                            {overflow.map((name) => (
                                <TagButton
                                    key={name.toLowerCase()}
                                    name={name}
                                    onClick={() => {
                                        setOverflowOpen(false);
                                        onTagClick(name);
                                    }}
                                />
                            ))}
                        </div>
                    </Popover>
                </>
            )}
        </div>
    );
}
