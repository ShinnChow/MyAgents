// RecentThoughtsRow — single-line strip of the latest thoughts, shown
// under the Launcher input when 「想法」 mode is active (PRD §4.2).
//
// Shape is a single horizontal row: most recent thought first, followed by
// a trailing 「查看更多 →」 chip that opens the full Task Center tab. Saving
// a new thought from the input above bumps `refreshKey` and the strip
// re-fetches so the just-saved note slides in as the first chip.
//
// Positioned absolutely by the caller so it hangs below the input without
// changing the parent's vertical layout.

import { useEffect, useState } from 'react';
import { ArrowRight, Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { recordList } from '@/api/taskCenter';
import { relativeTime } from '@/utils/taskCenterUtils';
import type { RecordSummary } from '@/../shared/types/record';

interface Props {
  /** Bumped by caller after a thoughtCreate succeeds → triggers refetch. */
  refreshKey: number;
  /** Open the Task Center tab (see App.tsx OPEN_TASK_CENTER listener). */
  onOpenTaskCenter: () => void;
  /** Max number of cards before the 「查看更多」 chip. */
  limit?: number;
  onOpenRecord?: (recordId: string) => void;
}

export function RecentThoughtsRow({
  refreshKey,
  onOpenTaskCenter,
  limit = 3,
  onOpenRecord,
}: Props) {
  const { t } = useTranslation('launcher');
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Launcher strip is a passive recent-activity view — archived
        // thoughts shouldn't bubble up here even though search would
        // still find them.
        const list = await recordList({ limit, archived: 'active' });
        if (!cancelled) {
          setRecords(list);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, limit]);

  // Hide the whole strip until the first fetch resolves, so an empty
  // flicker doesn't appear before data arrives on Launcher mount.
  if (!loaded) return null;

  // Layout contract: no horizontal scroll — each chip shrinks as needed via
  // `flex-1 min-w-0` and truncates text, so the 「更多」 button stays pinned
  // to the right regardless of content length.
  return (
    <div className="flex w-full items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {records.map((record) => (
          <RecordChip
            key={record.id}
            record={record}
            onClick={() =>
              record.kind === 'audio'
                ? onOpenRecord?.(record.id)
                : onOpenTaskCenter()
            }
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onOpenTaskCenter}
        className="flex shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2.5 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent-warm)]"
        title={t('recentThoughts.openTaskCenterTitle')}
      >
        <span>{t('recentThoughts.more')}</span>
        <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
}

interface ChipProps {
  record: RecordSummary;
  onClick: () => void;
}

function RecordChip({ record, onClick }: ChipProps) {
  const { t } = useTranslation('launcher');
  // `flex-1 min-w-0` lets the chip shrink when the row is tight, while
  // `truncate` on the label adds an ellipsis so no chip overflows its slot.
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
      title={record.title}
    >
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--ink-secondary)] group-hover:text-[var(--ink)]">
        {record.kind === 'audio' && (
          <Mic className="mr-1 inline h-3 w-3 text-[var(--accent-warm)]" />
        )}
        {record.title || t('recentThoughts.emptyThought')}
      </span>
      <span className="shrink-0 text-xs text-[var(--ink-muted)]/70">
        {relativeTime(record.createdAt)}
      </span>
    </button>
  );
}

export default RecentThoughtsRow;
