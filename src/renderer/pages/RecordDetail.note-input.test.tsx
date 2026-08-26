import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RecordDetail as RecordDetailData,
  RecordingSnapshot,
} from '@/../shared/types/record';
import RecordDetail, { safeRecordExportBaseName } from './RecordDetail';

const mocks = vi.hoisted(() => ({
  recordAddNote: vi.fn(),
  recordGet: vi.fn(),
  recordTranscript: vi.fn(),
  recordDiarization: vi.fn(),
  recordTimeline: vi.fn(),
  recordingSnapshot: vi.fn(),
  speechModelPackStatus: vi.fn(),
}));

vi.mock('@/api/recording', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/recording')>();
  return {
    ...actual,
    recordAddNote: mocks.recordAddNote,
    recordTranscript: mocks.recordTranscript,
    recordDiarization: mocks.recordDiarization,
    recordTimeline: mocks.recordTimeline,
    recordingSnapshot: mocks.recordingSnapshot,
    speechModelPackStatus: mocks.speechModelPackStatus,
  };
});

vi.mock('@/api/taskCenter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/taskCenter')>();
  return { ...actual, recordGet: mocks.recordGet };
});

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ config: {}, updateConfig: vi.fn() }),
}));

vi.mock('@/analytics', () => ({
  hashPrivateIdentity: vi.fn(async () => 'record-hash'),
  track: vi.fn(),
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: Array<{ segmentId: string }>;
    itemContent: (
      index: number,
      item: { segmentId: string },
    ) => React.ReactNode;
  }) => (
    <div data-testid="transcript-virtuoso" data-count={data.length}>
      {data.slice(0, 2).map((item, index) => itemContent(index, item))}
    </div>
  ),
}));

const SNAPSHOT: RecordingSnapshot = {
  recordId: 'record-note',
  revision: 2,
  generation: 1,
  captureStatus: 'recording',
  startedAtWallTime: 1_700_000_000_000,
  mediaDurationMs: 10_000,
  pausedWallMs: 0,
  sources: [
    {
      track: 'microphone',
      label: 'Default microphone',
      format: { channels: 1, sampleRate: 48_000 },
    },
  ],
  sourceActivity: [{ track: 'microphone', levelPercent: 37 }],
  warnings: [],
};

const RECORD: RecordDetailData = {
  id: SNAPSHOT.recordId,
  kind: 'audio',
  title: 'Meeting',
  tags: [],
  createdAt: SNAPSHOT.startedAtWallTime,
  updatedAt: SNAPSHOT.startedAtWallTime,
  archived: false,
  convertedTaskIds: [],
  revision: SNAPSHOT.revision,
  audio: {
    mediaDurationMs: SNAPSHOT.mediaDurationMs,
    captureStatus: 'recording',
    transcriptionStatus: 'live',
    diarizationStatus: 'not_applicable',
    tracks: ['microphone'],
    sizeBytes: 0,
  },
  artifacts: [],
};

describe('RecordDetail note input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordGet.mockResolvedValue(RECORD);
    mocks.recordTranscript.mockResolvedValue(null);
    mocks.recordDiarization.mockResolvedValue(null);
    mocks.recordTimeline.mockResolvedValue({
      recordId: RECORD.id,
      revision: 0,
      items: [],
    });
    mocks.recordingSnapshot.mockResolvedValue(SNAPSHOT);
    mocks.speechModelPackStatus.mockResolvedValue({ usable: true });
    mocks.recordAddNote.mockResolvedValue({
      recordId: RECORD.id,
      revision: 1,
      items: [],
    });
  });

  it('does not submit IME composition or Shift+Enter, then submits plain Enter', async () => {
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    const input = await screen.findByPlaceholderText(/记下此刻|Note the/);
    fireEvent.change(input, { target: { value: '讨论结论' } });

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.recordAddNote).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(mocks.recordAddNote).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.recordAddNote).toHaveBeenCalledOnce());
    expect(mocks.recordAddNote.mock.calls[0][0].text).toBe('讨论结论');
  });

  it('routes long transcripts through the existing virtual list', async () => {
    mocks.recordTranscript.mockResolvedValue({
      schemaVersion: 1,
      recordId: RECORD.id,
      projectionRevision: 1,
      state: 'ready',
      sampleRate: 16_000,
      provenance: {
        provider: 'sherpa-onnx',
        modelPackRevision: 'test',
        onnxRuntimeVersion: 'test',
      },
      segments: Array.from({ length: 100 }, (_, index) => ({
        segmentId: `segment-${index}`,
        track: 'microphone',
        startSample: index * 16_000,
        endSample: (index + 1) * 16_000,
        text: `segment ${index}`,
        revision: index + 1,
      })),
    });

    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    expect(await screen.findByTestId('transcript-virtuoso')).toHaveAttribute(
      'data-count',
      '100',
    );
    expect(screen.getByText('segment 0')).toBeInTheDocument();
    expect(screen.queryByText('segment 99')).not.toBeInTheDocument();
  });

  it('registers the current note draft so app lifecycle owners can save it before exit', async () => {
    let submitPendingNote: (() => Promise<boolean>) | undefined;
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
        registerPendingNoteSubmitter={(_recordId, submit) => {
          submitPendingNote = submit;
          return () => {
            submitPendingNote = undefined;
          };
        }}
      />,
    );

    const input = await screen.findByPlaceholderText(/记下此刻|Note the/);
    fireEvent.change(input, { target: { value: '退出前保存' } });
    await waitFor(() => expect(submitPendingNote).toBeTypeOf('function'));

    await act(async () => {
      expect(await submitPendingNote?.()).toBe(true);
    });
    expect(mocks.recordAddNote.mock.calls[0][0].text).toBe('退出前保存');
  });

  it('renders the authoritative capture activity instead of a constant source dot', async () => {
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    expect(await screen.findByLabelText(/37%/)).toBeInTheDocument();
  });

  it('stacks microphone and system activity as two live meter rows', async () => {
    const dualSourceSnapshot: RecordingSnapshot = {
      ...SNAPSHOT,
      sources: [
        ...SNAPSHOT.sources,
        {
          track: 'system',
          label: 'System audio',
          format: { channels: 2, sampleRate: 48_000 },
        },
      ],
      sourceActivity: [
        ...SNAPSHOT.sourceActivity,
        { track: 'system', levelPercent: 52 },
      ],
    };
    mocks.recordingSnapshot.mockResolvedValue(dualSourceSnapshot);

    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={dualSourceSnapshot}
      />,
    );

    const meters = await screen.findByTestId('recording-source-meters');
    expect(meters).toHaveClass('flex-col');
    expect(
      meters.querySelectorAll('[data-testid="recording-source-meter"]'),
    ).toHaveLength(2);
  });

  it('keeps the live failure recovery notice visible after stable segments exist', async () => {
    mocks.recordGet.mockResolvedValue({
      ...RECORD,
      audio: {
        ...RECORD.audio!,
        transcriptionStatus: 'failed',
      },
    });
    mocks.recordTranscript.mockResolvedValue({
      schemaVersion: 1,
      recordId: RECORD.id,
      projectionRevision: 1,
      state: 'failed',
      sampleRate: 16_000,
      provenance: {
        provider: 'sherpa-onnx',
        modelPackRevision: 'test',
        onnxRuntimeVersion: 'test',
      },
      segments: [
        {
          segmentId: 'stable-before-failure',
          track: 'microphone',
          startSample: 0,
          endSample: 8_000,
          text: '已经稳定转写的内容',
          revision: 1,
        },
      ],
    });

    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    expect(await screen.findByText('已经稳定转写的内容')).toBeInTheDocument();
    expect(
      await screen.findByText(
        /录音仍在安全保存.*停止后会自动重新处理|recording is still being saved safely.*processed again after you stop/i,
      ),
    ).toHaveAttribute('role', 'status');
  });

  it('keeps the completed playback timeline inside one dedicated progress control', async () => {
    mocks.recordGet.mockResolvedValue({
      ...RECORD,
      audio: {
        ...RECORD.audio!,
        captureStatus: 'ready',
        transcriptionStatus: 'ready',
        mediaDurationMs: 31_000,
      },
    });
    mocks.recordingSnapshot.mockResolvedValue(null);

    render(<RecordDetail recordId={RECORD.id} isActive />);

    expect(
      await screen.findByTestId('recording-playback-progress'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/音量|Volume/)).not.toBeInTheDocument();
  });

  it('renders the manager media clock without projecting wall time', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(SNAPSHOT.startedAtWallTime + 500_000);

    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    expect(
      await screen.findByTestId('recording-media-duration'),
    ).toHaveTextContent('00:10');
    now.mockRestore();
  });

  it('shows the non-blocking warning when the recording wake lock is unavailable', async () => {
    const warningSnapshot = {
      ...SNAPSHOT,
      warnings: [{ code: 'RECORDING_WAKE_LOCK_UNAVAILABLE' }],
    };
    mocks.recordingSnapshot.mockResolvedValue(warningSnapshot);

    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={warningSnapshot}
      />,
    );

    expect(
      await screen.findByText(
        /无法阻止系统自动休眠|Could not prevent automatic sleep/,
      ),
    ).toHaveAttribute('role', 'status');
  });

  it('builds cross-platform export names from the safe title without Record identity', () => {
    expect(
      safeRecordExportBaseName('  Roadmap: Q3/Q4?  ', 'Untitled record'),
    ).toBe('Roadmap- Q3-Q4-');
    expect(safeRecordExportBaseName('CON', 'Untitled record')).toBe(
      'CON-record',
    );
    expect(safeRecordExportBaseName('...', 'Untitled record')).toBe(
      'Untitled record',
    );
  });
});
