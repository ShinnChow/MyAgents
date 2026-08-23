// TaskSessionsList — "任务执行" section inside Task Detail overlay.
//
// Renders the sessions on which a task has actually executed. Population is
// driven by the execution adapter's admission callback, after the target
// Session has accepted the first Task turn. This keeps Task ↔ Session
// relations durable without exposing speculative, pre-admission rows.
//
// Clicking a row fires `OPEN_SESSION_IN_NEW_TAB`, routed by App.tsx to a
// freshly pre-seeded Chat tab (never hijacks the active tab). Clicking
// also closes this detail overlay so the user immediately lands in the
// chat they asked for.
//
// Visual language mirrors Launcher's 历史对话 list (DESIGN.md §15.6):
// `rounded-lg hover:bg-[var(--hover-bg)]` row with a timestamp column on
// the left and truncated title on the right. Timestamp column is 94px
// (vs Launcher's 56px w-14) because this list shows `MM-DD HH:mm` whereas
// Launcher's shows `HH:mm` only.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Clock } from 'lucide-react';

import { getSessions, type SessionMetadata } from '@/api/sessionClient';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import type { Task } from '@/../shared/types/task';
import { getSessionDisplayText } from '@/utils/sessionDisplay';

interface Props {
  task: Task;
  /**
   * Called right before dispatching OPEN_SESSION_IN_NEW_TAB, so the parent
   * TaskDetailOverlay can dismiss itself — otherwise the user clicks a row
   * and nothing visible happens until they manually close the overlay.
   */
  onBeforeOpen?: () => void;
}

const MAX_VISIBLE = 5;

function formatTimestamp(iso: string | number | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return sameYear ? `${mm}-${dd} ${hh}:${mi}` : `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

export function TaskSessionsList({ task, onBeforeOpen }: Props) {
  const { t } = useTranslation('task');
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE);

  // Fetch all sessions for the task's workspace once, then filter to the
  // task's sessionIds[]. Cheaper than N-round trips; session metadata is
  // small and the workspace-scoped endpoint already exists. We DON'T reset
  // `loading` to true when task changes — the existing list stays visible
  // briefly until the new fetch lands, which is less disruptive than a
  // full loading flash. The initial useState(true) covers first mount.
  //
  // Dep on the joined id string (stable primitive) instead of the raw
  // `task.sessionIds` array: the array reference churns every time the
  // parent `TaskDetailOverlay` calls `setTask(fresh)` (status-changed SSE,
  // reloadToken bumps, etc.) even when the ids themselves haven't changed,
  // and would otherwise re-fire the REST fetch on every overlay refresh.
  // Per specs/tech_docs/react_stability_rules.md rule 2 (no array refs as
  // effect deps).
  const sessionIdsKey = task.sessionIds.join(',');
  useEffect(() => {
    let cancelled = false;
    void getSessions(task.workspacePath)
      .then((all) => {
        if (cancelled) return;
        const idSet = new Set(sessionIdsKey.split(',').filter(Boolean));
        const matched = all.filter((s) => idSet.has(s.id));
        // Sort by lastActiveAt desc so newest executions surface first.
        // Tie-break on session id for deterministic rendering when two
        // executions land in the same second.
        matched.sort((a, b) => {
          const ta = new Date(a.lastActiveAt).getTime();
          const tb = new Date(b.lastActiveAt).getTime();
          if (tb !== ta) return tb - ta;
          return a.id < b.id ? 1 : -1;
        });
        setSessions(matched);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[TaskSessionsList] fetch sessions failed', err);
          setSessions([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.workspacePath, sessionIdsKey]);

  const visible = useMemo(
    () => sessions.slice(0, visibleCount),
    [sessions, visibleCount],
  );

  const handleOpen = (sessionId: string) => {
    onBeforeOpen?.();
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
        detail: { sessionId, workspacePath: task.workspacePath, historyEntrySource: 'task_run_history' },
      }),
    );
  };

  return (
    <div>
      {/* Keep section titles at one consistent weight so the property rail
          reads as a short hierarchy instead of a stack of unrelated cards. */}
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-[var(--ink)]">{t('sessions.title')}</h3>
        <span className="text-xs tabular-nums text-[var(--ink-muted)]">
          {task.sessionIds.length}
        </span>
      </div>
      {loading ? (
        <div className="py-3 text-xs text-[var(--ink-muted)]/60">
          {t('sessions.loading')}
        </div>
      ) : sessions.length === 0 ? (
        <div className="py-3 text-xs text-[var(--ink-muted)]/60">
          {task.sessionIds.length === 0 ? t('sessions.emptyNeverRun') : t('sessions.emptyMissing')}
        </div>
      ) : (
        <div className="space-y-0.5">
          {visible.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => handleOpen(session.id)}
              title={t('sessions.openTitle', { id: session.id })}
              className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--hover-bg)]"
            >
              <div className="flex w-[94px] shrink-0 items-center gap-1 text-xs text-[var(--ink-muted)]/60">
                <Clock className="h-2.5 w-2.5" />
                <span className="whitespace-nowrap tabular-nums">{formatTimestamp(session.lastActiveAt)}</span>
              </div>
              <span className="min-w-0 flex-1 truncate text-xs leading-5 text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                {getSessionDisplayText(session)}
              </span>
            </button>
          ))}
          {sessions.length > visibleCount && (
            <button
              type="button"
              onClick={() => setVisibleCount((count) => count + MAX_VISIBLE)}
              className="mt-1 flex w-full items-center justify-between rounded-md px-1.5 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
              <span>{t('sessions.expandMore')}</span>
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default TaskSessionsList;
