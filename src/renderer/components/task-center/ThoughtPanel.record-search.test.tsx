import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordSummary } from '@/../shared/types/record';
import { ThoughtPanel } from './ThoughtPanel';

const mocks = vi.hoisted(() => ({
  thoughtList: vi.fn(),
  recordList: vi.fn(),
  searchRecords: vi.fn(),
}));

vi.mock('@/api/taskCenter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/taskCenter')>();
  return {
    ...actual,
    taskCenterAvailable: () => false,
    thoughtList: mocks.thoughtList,
    recordList: mocks.recordList,
  };
});

vi.mock('@/api/searchClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/searchClient')>();
  return { ...actual, searchRecords: mocks.searchRecords };
});

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ projects: [] }),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('./ThoughtInput', () => ({ ThoughtInput: () => <div /> }));

const AUDIO_RECORD: RecordSummary = {
  id: 'record-search',
  kind: 'audio',
  title: 'Weekly sync',
  tags: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  archived: false,
  convertedTaskIds: [],
  revision: 2,
  audio: {
    mediaDurationMs: 90_000,
    captureStatus: 'ready',
    transcriptionStatus: 'ready',
    diarizationStatus: 'ready',
    tracks: ['mixed'],
    sizeBytes: 4096,
  },
};

describe('ThoughtPanel Record search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.thoughtList.mockResolvedValue([]);
    mocks.recordList.mockResolvedValue([AUDIO_RECORD]);
    mocks.searchRecords.mockResolvedValue({
      hits: [
        {
          recordId: AUDIO_RECORD.id,
          kind: 'audio',
          title: AUDIO_RECORD.title,
          snippet: 'Alice: roadmap decision',
          mediaMs: 42_000,
        },
      ],
      total: 1,
      queryTimeMs: 2,
    });
  });

  it('uses the existing Record index and opens a hit at its media time', async () => {
    const onOpenRecord = vi.fn();
    render(<ThoughtPanel onOpenRecord={onOpenRecord} />);

    await screen.findByText(AUDIO_RECORD.title);
    fireEvent.change(screen.getByPlaceholderText('搜索记录…'), {
      target: { value: 'roadmap' },
    });

    await waitFor(() =>
      expect(mocks.searchRecords).toHaveBeenCalledWith('roadmap', 200),
    );
    expect(
      await screen.findByText('Alice: roadmap decision'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Weekly sync/ }));
    expect(onOpenRecord).toHaveBeenCalledWith(AUDIO_RECORD.id, 42_000);
  });

  it('names every deleted audio artifact in the bulk confirmation', async () => {
    render(<ThoughtPanel />);

    await screen.findByText(AUDIO_RECORD.title);
    fireEvent.click(screen.getByRole('button', { name: '多选' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(
      await screen.findByText(/音频、转写、笔记和重点标记/),
    ).toBeInTheDocument();
  });
});
