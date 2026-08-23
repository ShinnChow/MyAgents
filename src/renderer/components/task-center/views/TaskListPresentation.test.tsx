import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '@/../shared/types/task';

import { TaskListRow } from './TaskListRow';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-row',
    name: '每日 AI 行业新闻与暴论',
    executor: 'agent',
    workspaceId: 'workspace-1',
    workspacePath: '/Users/me/mino',
    executionMode: 'recurring',
    runMode: 'new-session',
    sessionIds: ['session-1'],
    status: 'running',
    tags: [],
    createdAt: Date.parse('2026-08-20T00:00:00+08:00'),
    updatedAt: Date.parse('2026-08-22T11:00:00+08:00'),
    statusHistory: [],
    dispatchOrigin: 'direct',
    ...overrides,
  };
}

describe('Task list presentation', () => {
  it('uses the bucket for status and overlays the Session action in the date slot', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <TaskListRow
        task={task()}
        onOpen={onOpen}
        onEdit={vi.fn()}
        onStop={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.queryByText('进行中')).not.toBeInTheDocument();
    expect(screen.getByText('周期')).toBeInTheDocument();
    expect(container.querySelector('[data-task-running-indicator]')).not.toBeNull();

    const sessionButton = screen.getByRole('button', { name: '查看会话详情' });
    expect(sessionButton.parentElement).toHaveClass(
      'opacity-0',
      'group-hover:opacity-100',
      'group-focus:opacity-100',
      'focus-within:opacity-100',
    );
    expect(sessionButton.parentElement?.parentElement).toHaveClass(
      'absolute',
      'inset-0',
    );
    const dateSlot = sessionButton.parentElement?.parentElement?.parentElement;
    expect(dateSlot).toHaveClass(
      'relative',
      'w-[88px]',
    );
    expect(dateSlot?.firstElementChild).toHaveClass('group-focus:opacity-0');

    const row = container.firstElementChild;
    expect(row).toHaveAttribute('role', 'button');
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row!, { key: 'Enter' });
    fireEvent.keyDown(row!, { key: ' ' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('only shows the breathing indicator for a running task', () => {
    const { container } = render(
      <TaskListRow
        task={task({ status: 'stopped' })}
        onOpen={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-task-running-indicator]')).toBeNull();
  });
});
