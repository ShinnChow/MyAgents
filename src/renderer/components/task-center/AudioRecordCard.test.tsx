import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { RecordSummary } from '@/../shared/types/record';
import { AudioRecordCard } from './AudioRecordCard';

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    projects: [
      {
        id: 'workspace-1',
        name: 'weekly',
        displayName: 'Weekly workspace',
        path: '/Users/me/weekly',
        isHidden: false,
      },
    ],
  }),
}));

const RECORD: RecordSummary = {
  id: 'record-1',
  kind: 'audio',
  title: 'Weekly meeting',
  tags: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  archived: false,
  convertedTaskIds: [],
  revision: 2,
  audio: {
    mediaDurationMs: 65_000,
    captureStatus: 'ready',
    transcriptionStatus: 'ready',
    diarizationStatus: 'ready',
    tracks: ['microphone'],
    sizeBytes: 1024,
  },
};

describe('AudioRecordCard', () => {
  it('enters unified selection and becomes a checkbox without opening detail', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onEnterSelectMode = vi.fn();
    const onToggleSelect = vi.fn();
    const props = {
      record: RECORD,
      onOpen,
      onArchive: vi.fn(),
      onDelete: vi.fn(),
      onEnterSelectMode,
      onToggleSelect,
    };
    const { rerender } = render(<AudioRecordCard {...props} />);

    await user.click(screen.getByTitle('更多操作'));
    await user.click(screen.getByRole('button', { name: '多选' }));
    expect(onEnterSelectMode).toHaveBeenCalledOnce();

    rerender(<AudioRecordCard {...props} selectMode selected={false} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox.querySelector('button')).toBeNull();
    await user.click(checkbox);
    expect(onToggleSelect).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('starts AI discussion from the hover action and selects a workspace', async () => {
    const user = userEvent.setup();
    const onDiscuss = vi.fn();
    render(
      <AudioRecordCard record={RECORD} onOpen={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} onDiscuss={onDiscuss} />,
    );

    await user.click(screen.getByRole('button', { name: 'AI 讨论' }));
    await user.click(screen.getByRole('button', { name: /Weekly workspace/ }));

    expect(onDiscuss).toHaveBeenCalledWith(RECORD, 'workspace-1');
  });

  it('matches text Record date, hover action, icon, and width hierarchy', () => {
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValue(RECORD.createdAt + 8 * 60 * 60 * 1_000);
    const { container } = render(
      <AudioRecordCard
        record={RECORD}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onDiscuss={vi.fn()}
      />,
    );

    expect(screen.getByText(/8.*小时前/)).toBeInTheDocument();
    const discussButton = screen.getAllByRole('button', { name: 'AI 讨论' })[0];
    expect(discussButton).not.toHaveClass('absolute');
    const card = container.querySelector('article');
    expect(card).toHaveClass('w-full', 'max-w-full', 'overflow-hidden');
    const mic = container.querySelector('.lucide-mic');
    expect(mic).toHaveClass('h-3.5', 'w-3.5');

    dateNow.mockRestore();
  });

  it('opens a search hit at its indexed media time', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <AudioRecordCard
        record={RECORD}
        onOpen={onOpen}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        searchHit={{
          recordId: RECORD.id,
          kind: 'audio',
          title: RECORD.title,
          snippet: 'Alice: roadmap decision',
          mediaMs: 42_000,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Weekly meeting/ }));
    expect(onOpen).toHaveBeenCalledWith(RECORD.id, 42_000, false);
    expect(screen.queryByText('Alice: roadmap decision')).not.toBeInTheDocument();
  });

  it('opens from the whole card while keeping floating controls independent', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <AudioRecordCard
        record={RECORD}
        onOpen={onOpen}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onDiscuss={vi.fn()}
      />,
    );

    const card = screen.getByRole('button', { name: 'Weekly meeting' });
    await user.click(screen.getByText('01:05'));
    expect(onOpen).toHaveBeenCalledWith(RECORD.id, undefined, false);

    await user.click(screen.getByTitle('更多操作'));
    expect(onOpen).toHaveBeenCalledTimes(1);

    card.focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('keeps AI discussion and playback out of the More menu', async () => {
    const user = userEvent.setup();
    render(<AudioRecordCard record={RECORD} onOpen={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '播放' })).toBeNull();
    await user.click(screen.getByTitle('更多操作'));
    expect(screen.queryByRole('button', { name: '播放' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'AI 讨论' })).toBeNull();
    expect(screen.getByRole('button', { name: '归档' })).toBeInTheDocument();
  });

  it('renders the authoritative duration projected by the app owner', async () => {
    const { container } = render(
      <AudioRecordCard
        record={{
          ...RECORD,
          audio: {
            ...RECORD.audio!,
            mediaDurationMs: 5_000,
            captureStatus: 'recording',
          },
        }}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('00:05')).toBeInTheDocument());
    expect(container.querySelector('audio')).toBeNull();
  });
});
