// TaskListRow — dense single-line row used by the list view for fast scan +
// filter. No card chrome (no rounded corners, no shadow, no per-row border
// box) so the list reads as a table.
//
// Layout (left → right): category chip · name (flex-1) · workspace ·
// updated-at / hover Session action · overflow menu. Lifecycle status is
// expressed by the owning section and remains fully visible in Task Detail.

import type { Task, TaskExecutionMode } from '@/../shared/types/task';
import { useTranslation } from 'react-i18next';
import { relativeTime } from '@/utils/taskCenterUtils';
import { TaskCategoryBadge } from '../TaskCategoryBadge';
import { TaskTriggerBadge } from '../TaskTriggerBadge';
import { TaskItemActions, deriveTaskRowStatus } from './TaskItemActions';
import { ViewSessionButton } from './TaskCardItem';
import type { LegacyCronRow } from './types';
import { isSupportedLocale } from '@/../shared/i18n';

export interface TaskListRowProps {
  task?: Task;
  legacy?: LegacyCronRow;
  highlighted?: boolean;
  busy?: boolean;
  onOpen: () => void;
  onEdit?: () => void;
  onRun?: () => void;
  onStop?: () => void;
  onRerun?: () => void;
  onDelete?: () => void;
}

export function TaskListRow(props: TaskListRowProps) {
  const { task, legacy, highlighted, busy, onOpen, onEdit, onRun, onStop, onRerun, onDelete } = props;
  const { i18n } = useTranslation('task');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const isLegacy = !!legacy && !task;
  const status = deriveTaskRowStatus(task ?? null);
  const name = task?.name ?? legacy?.name ?? '—';
  const workspacePath = task?.workspacePath ?? legacy?.workspacePath;
  const workspace = workspacePath
    ? shortenPath(workspacePath)
    : '';
  const updatedAt = task?.updatedAt ?? legacy?.updatedAt ?? 0;
  const category: TaskExecutionMode = task
    ? task.executionMode
    : inferLegacyCategory(legacy);
  const hasSession = !!task?.sessionIds.length;
  const isRunning = task?.status === 'running' || legacy?.status === 'running';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`group flex w-full cursor-pointer items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-2 text-left transition-colors hover:bg-[var(--hover-bg)] ${
        highlighted ? 'bg-[var(--accent-warm-subtle)]' : ''
      }`}
    >
      {/* Category remains the only row-level tag. Exact lifecycle status is
          available in Task Detail; the section header supplies scan context. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {task?.trigger?.detector.type === 'command' && <TaskTriggerBadge compact />}
        <TaskCategoryBadge mode={category} legacy={isLegacy} compact />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm text-[var(--ink)]">
          {name}
        </span>
        {isRunning && (
          <span
            className="relative flex h-1.5 w-1.5 shrink-0"
            data-task-running-indicator
            aria-hidden="true"
          >
            <span className="absolute inset-0 rounded-full bg-[var(--success)]" />
            <span className="absolute inset-0 animate-[tab-dot-pulse_1.6s_cubic-bezier(.22,.61,.36,1)_infinite] rounded-full bg-[var(--success)] motion-reduce:animate-none" />
          </span>
        )}
      </div>
      {workspace && (
        <span className="hidden max-w-[110px] shrink-0 truncate text-xs text-[var(--ink-muted)] sm:block">
          {workspace}
        </span>
      )}
      <div className="group/session-slot relative h-6 w-[88px] shrink-0">
        <span
          className={`absolute inset-0 flex items-center justify-end whitespace-nowrap text-xs text-[var(--ink-muted)]/80 transition-opacity ${
            hasSession ? 'group-hover:opacity-0 group-focus:opacity-0 group-focus-within/session-slot:opacity-0' : ''
          }`}
        >
          {relativeTime(updatedAt, locale)}
        </span>
        {hasSession && (
          <div className="absolute inset-0 flex items-center justify-end">
            <ViewSessionButton task={task} />
          </div>
        )}
      </div>
      <TaskItemActions
        variant={isLegacy ? 'legacy' : 'task'}
        status={status}
        executionState={task?.executionState}
        canRerun={task?.dispatchOrigin !== 'attached-session'}
        busy={busy}
        onRun={onRun}
        onStop={onStop}
        onRerun={onRerun}
        onOpenDetail={onOpen}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

/** Best guess at the "kind" of a legacy cron from its schedule shape —
 *  same logic as TaskCardItem; kept local so the two files stay
 *  independent of each other's internals. */
function inferLegacyCategory(legacy?: LegacyCronRow): TaskExecutionMode {
  if (!legacy) return 'once';
  const sched = (legacy.raw as { schedule?: { kind?: string } }).schedule;
  const kind = sched?.kind;
  if (kind === 'loop') return 'loop';
  if (kind === 'at') return 'scheduled';
  return 'recurring';
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
