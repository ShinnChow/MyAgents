import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordSummary } from '@/../shared/types/record';
import { AudioRecordCard } from './AudioRecordCard';

const mocks = vi.hoisted(() => ({
  recordingSnapshot: vi.fn(),
  hashPrivateIdentity: vi.fn(),
  track: vi.fn(),
}));

vi.mock('@/api/recording', () => ({
  recordingSnapshot: mocks.recordingSnapshot,
  recordMediaUrl: (recordId: string, track: string) =>
    `record://${recordId}/${track}`,
}));
vi.mock('@/analytics/hash', () => ({
  hashPrivateIdentity: mocks.hashPrivateIdentity,
}));
vi.mock('@/analytics/tracker', () => ({ track: mocks.track }));

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
  beforeEach(() => {
    mocks.recordingSnapshot.mockReset();
    mocks.recordingSnapshot.mockResolvedValue(null);
    mocks.hashPrivateIdentity.mockReset();
    mocks.hashPrivateIdentity.mockResolvedValue('record-hash');
    mocks.track.mockReset();
  });

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

    await user.click(screen.getByRole('button', { name: '多选' }));
    expect(onEnterSelectMode).toHaveBeenCalledOnce();

    rerender(<AudioRecordCard {...props} selectMode selected={false} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox.querySelector('button')).toBeNull();
    await user.click(checkbox);
    expect(onToggleSelect).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
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
    expect(onOpen).toHaveBeenCalledWith(RECORD.id, 42_000);
    expect(screen.getByText('Alice: roadmap decision')).toBeInTheDocument();
  });

  it('projects the authoritative active snapshot into a continuously updated duration', async () => {
    mocks.recordingSnapshot.mockResolvedValue({
      recordId: RECORD.id,
      revision: 3,
      generation: 1,
      captureStatus: 'recording',
      startedAtWallTime: Date.now() - 5_000,
      mediaDurationMs: 5_000,
      pausedWallMs: 0,
      sources: [],
      sourceActivity: [],
      warnings: [],
    });
    render(
      <AudioRecordCard
        record={{
          ...RECORD,
          audio: {
            ...RECORD.audio!,
            mediaDurationMs: 0,
            captureStatus: 'recording',
          },
        }}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('00:05')).toBeInTheDocument());
  });

  it('tracks one privacy-safe event per stopped-to-playing session', async () => {
    const { container } = render(
      <AudioRecordCard
        record={RECORD}
        onOpen={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();

    fireEvent.play(audio!);
    fireEvent.pause(audio!);
    fireEvent.play(audio!);
    await waitFor(() => expect(mocks.track).toHaveBeenCalledTimes(1));
    fireEvent.ended(audio!);
    fireEvent.play(audio!);
    await waitFor(() => expect(mocks.track).toHaveBeenCalledTimes(2));

    expect(mocks.hashPrivateIdentity).toHaveBeenCalledWith('record', RECORD.id);
    expect(mocks.track).toHaveBeenLastCalledWith('record_use', {
      event_schema_version: 1,
      record_hash: 'record-hash',
      record_kind: 'audio',
      operation: 'play',
      source: 'desktop',
      surface: 'task_center',
    });
    expect(JSON.stringify(mocks.track.mock.calls)).not.toContain(RECORD.id);
  });
});
