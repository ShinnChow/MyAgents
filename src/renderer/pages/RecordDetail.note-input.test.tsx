import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  recordTranscriptDelta: vi.fn(),
  recordDiarization: vi.fn(),
  recordTimeline: vi.fn(),
  recordingSnapshot: vi.fn(),
  recordingSetSourceEnabled: vi.fn(),
  recordStartTranscription: vi.fn(),
  speechModelPackStatus: vi.fn(),
  eventListeners: new Map<
    string,
    (event: { payload: Record<string, unknown> }) => void
  >(),
}));

vi.mock('@/api/recording', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/recording')>();
  return {
    ...actual,
    recordAddNote: mocks.recordAddNote,
    recordTranscript: mocks.recordTranscript,
    recordTranscriptDelta: mocks.recordTranscriptDelta,
    recordDiarization: mocks.recordDiarization,
    recordTimeline: mocks.recordTimeline,
    recordingSnapshot: mocks.recordingSnapshot,
    recordingSetSourceEnabled: mocks.recordingSetSourceEnabled,
    recordStartTranscription: mocks.recordStartTranscription,
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

vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(
    async (
      event: string,
      handler: (event: { payload: Record<string, unknown> }) => void,
      signal: AbortSignal,
    ) => {
      mocks.eventListeners.set(event, handler);
      signal.addEventListener(
        'abort',
        () => {
          if (mocks.eventListeners.get(event) === handler) {
            mocks.eventListeners.delete(event);
          }
        },
        { once: true },
      );
      return { unlisten: vi.fn(), isRegistered: () => true };
    },
  ),
}));

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: Array<Record<string, unknown>>;
    itemContent: (
      index: number,
      item: Record<string, unknown>,
    ) => React.ReactNode;
  }) => {
    const isTranscript = 'segmentId' in (data[0] ?? {});
    return (
      <div
        data-testid={isTranscript ? 'transcript-virtuoso' : 'timeline-virtuoso'}
        data-count={data.length}
      >
        {data.slice(0, 2).map((item, index) => (
          <div
            key={String(item.segmentId ?? item.noteId ?? item.markId ?? index)}
          >
            {itemContent(index, item)}
          </div>
        ))}
      </div>
    );
  },
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
  sourceActivity: [{ track: 'microphone', levelPercent: 37, enabled: true }],
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
    mocks.eventListeners.clear();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    HTMLElement.prototype.scrollTo = vi.fn();
    mocks.recordGet.mockResolvedValue(RECORD);
    mocks.recordTranscript.mockResolvedValue(null);
    mocks.recordTranscriptDelta.mockResolvedValue(null);
    mocks.recordDiarization.mockResolvedValue(null);
    mocks.recordTimeline.mockResolvedValue({
      recordId: RECORD.id,
      revision: 0,
      items: [],
    });
    mocks.recordingSnapshot.mockResolvedValue(SNAPSHOT);
    mocks.recordingSetSourceEnabled.mockImplementation(
      async (
        _snapshot: RecordingSnapshot,
        track: string,
        enabled: boolean,
      ) => ({
        ...SNAPSHOT,
        sourceActivity: SNAPSHOT.sourceActivity.map((source) =>
          source.track === track ? { ...source, enabled } : source,
        ),
      }),
    );
    mocks.speechModelPackStatus.mockResolvedValue({ usable: true });
    mocks.recordStartTranscription.mockResolvedValue(undefined);
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

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(mocks.recordAddNote).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(mocks.recordAddNote).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.recordAddNote).toHaveBeenCalledOnce());
    expect(mocks.recordAddNote.mock.calls[0][0].text).toBe('讨论结论');
  });

  it('deduplicates repeated Enter and preserves text typed while the save is pending', async () => {
    let resolveSave!: (value: {
      recordId: string;
      revision: number;
      items: [];
    }) => void;
    mocks.recordAddNote.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    const input = await screen.findByPlaceholderText(/记下此刻|Note the/);
    fireEvent.change(input, { target: { value: '第一条' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.recordAddNote).toHaveBeenCalledOnce();

    fireEvent.change(input, { target: { value: '保存期间的新草稿' } });
    await act(async () => {
      resolveSave({ recordId: RECORD.id, revision: 1, items: [] });
    });
    expect(input).toHaveValue('保存期间的新草稿');
  });

  it('keeps active recording controls available when an optional projection fails', async () => {
    mocks.recordTranscript.mockRejectedValueOnce(
      new Error('projection unavailable'),
    );
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    expect(
      await screen.findByRole('button', { name: /停止并保存|Stop and save/i }),
    ).toBeEnabled();
    expect(
      await screen.findByText(/projection unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重试|Retry/i })).toBeEnabled();
  });

  it('does not let an older snapshot request overwrite a newer lifecycle projection', async () => {
    let resolveSnapshot!: (value: RecordingSnapshot) => void;
    mocks.recordingSnapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const newest = {
      ...SNAPSHOT,
      revision: 8,
      generation: 3,
      mediaDurationMs: 18_000,
    };
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive
        initialRecordingSnapshot={newest}
      />,
    );

    expect(
      await screen.findByTestId('recording-media-duration'),
    ).toHaveTextContent('00:18');
    await act(async () => {
      resolveSnapshot({
        ...SNAPSHOT,
        revision: 2,
        generation: 1,
        mediaDurationMs: 2_000,
      });
    });
    expect(screen.getByTestId('recording-media-duration')).toHaveTextContent(
      '00:18',
    );
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

  it('drains a newer draft before the app lifecycle closes the recording', async () => {
    let resolveFirst!: (value: {
      recordId: string;
      revision: number;
      items: [];
    }) => void;
    let flushPendingNote: (() => Promise<boolean>) | undefined;
    mocks.recordAddNote.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
        registerPendingNoteSubmitter={(_recordId, submit) => {
          flushPendingNote = submit;
          return () => undefined;
        }}
      />,
    );

    const input = await screen.findByPlaceholderText(/记下此刻|Note the/);
    fireEvent.change(input, { target: { value: '第一条' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: '关闭前的新草稿' } });

    let flushResult: boolean | undefined;
    await act(async () => {
      const flushing = flushPendingNote?.().then((value) => {
        flushResult = value;
      });
      resolveFirst({ recordId: RECORD.id, revision: 1, items: [] });
      await flushing;
    });

    expect(flushResult).toBe(true);
    expect(mocks.recordAddNote).toHaveBeenCalledTimes(2);
    expect(mocks.recordAddNote.mock.calls[1][0].text).toBe('关闭前的新草稿');
    expect(input).toHaveValue('');
  });

  it('renders the authoritative capture activity without a flashing percentage label', async () => {
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    expect(
      await screen.findByRole('button', {
        name: /麦克风.*录入中|Microphone.*included/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('37%')).not.toBeInTheDocument();
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
        { track: 'system', levelPercent: 52, enabled: true },
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

  it('lets the user stop and restore one source without pausing the recording', async () => {
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: /麦克风.*录入中|Microphone.*included/i,
      }),
    );

    await waitFor(() =>
      expect(mocks.recordingSetSourceEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ recordId: RECORD.id }),
        'microphone',
        false,
      ),
    );
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

  it('keeps completed transcription failures recoverable after partial text exists', async () => {
    mocks.recordGet.mockResolvedValue({
      ...RECORD,
      audio: {
        ...RECORD.audio!,
        captureStatus: 'ready',
        transcriptionStatus: 'failed',
      },
    });
    mocks.recordingSnapshot.mockResolvedValue(null);
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
          segmentId: 'partial',
          track: 'microphone',
          startSample: 0,
          endSample: 8_000,
          text: '保留下来的部分',
          revision: 1,
        },
      ],
    });

    render(<RecordDetail recordId={RECORD.id} isActive />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /重新转录|Retry transcription/i,
      }),
    );
    await waitFor(() =>
      expect(mocks.recordStartTranscription).toHaveBeenCalledWith(RECORD.id),
    );
    expect(screen.getByText('保留下来的部分')).toBeInTheDocument();
  });

  it('virtualizes a large note timeline', async () => {
    mocks.recordTimeline.mockResolvedValue({
      recordId: RECORD.id,
      revision: 100,
      items: Array.from({ length: 100 }, (_, index) => ({
        type: 'mark' as const,
        markId: `mark-${index}`,
        mediaMs: index * 1_000,
        wallTime: SNAPSHOT.startedAtWallTime + index * 1_000,
      })),
    });

    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    expect(await screen.findByTestId('timeline-virtuoso')).toHaveAttribute(
      'data-count',
      '100',
    );
  });

  it('keeps the completed playback timeline inside one dedicated progress control', async () => {
    mocks.recordGet.mockResolvedValue({
      ...RECORD,
      audio: {
        ...RECORD.audio!,
        captureStatus: 'ready',
        transcriptionStatus: 'ready',
        mediaDurationMs: 31_000,
        tracks: ['microphone', 'system'],
      },
    });
    mocks.recordingSnapshot.mockResolvedValue(null);

    render(<RecordDetail recordId={RECORD.id} isActive />);

    expect(
      await screen.findByTestId('recording-playback-progress'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/音量|Volume/)).toHaveAttribute(
      'type',
      'range',
    );
    const playbackTimeline = screen.getByTestId('recording-playback-timeline');
    expect(playbackTimeline).toHaveClass('flex-col');
    const playbackTime = within(playbackTimeline).getByText('00:00 / 00:31');
    expect(playbackTime).toHaveClass('text-center');
    const playbackTools = screen.getByTestId('recording-playback-tools');
    expect(playbackTools).toHaveClass('flex-col');
    expect(playbackTools).toContainElement(
      screen.getByRole('button', { name: /音轨|Tracks/i }),
    );
    expect(playbackTools).toContainElement(
      screen.getByLabelText(/音量|Volume/),
    );
  });

  it('does not attach playback media while capture still owns the audio artifacts', async () => {
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    expect(
      await screen.findByRole('button', { name: /停止并保存|Stop and save/i }),
    ).toBeEnabled();
    expect(
      screen.queryByTestId('recording-primary-audio'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('recording-secondary-audio'),
    ).not.toBeInTheDocument();
  });

  it('keeps transcript seeking on its text without drawing playback markers', async () => {
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
    mocks.recordTranscript.mockResolvedValue({
      schemaVersion: 1,
      recordId: RECORD.id,
      projectionRevision: 1,
      state: 'recording_final',
      sampleRate: 16_000,
      provenance: {
        provider: 'sherpa-onnx',
        modelPackRevision: 'test',
        onnxRuntimeVersion: 'test',
      },
      segments: [
        {
          segmentId: 'focus-target',
          track: 'microphone',
          startSample: 16_000,
          endSample: 24_000,
          text: '需要定位的内容',
          revision: 1,
        },
      ],
    });

    render(<RecordDetail recordId={RECORD.id} isActive />);

    const transcriptText = await screen.findByRole('button', {
      name: '需要定位的内容',
    });
    expect(
      screen.queryByRole('button', {
        name: /转写.*00:01|Transcript.*00:01/i,
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(transcriptText);
    expect(transcriptText.closest('article')).toHaveFocus();
  });

  it('defaults dual physical tracks to real mixed playback with single-track choices', async () => {
    mocks.recordGet.mockResolvedValue({
      ...RECORD,
      audio: {
        ...RECORD.audio!,
        captureStatus: 'ready',
        transcriptionStatus: 'ready',
        mediaDurationMs: 31_000,
        tracks: ['microphone', 'system'],
      },
    });
    mocks.recordingSnapshot.mockResolvedValue(null);

    render(<RecordDetail recordId={RECORD.id} isActive />);

    expect(
      await screen.findByRole('button', { name: /音轨|Tracks/i }),
    ).toHaveTextContent(/混合|Mixed/i);
    expect(screen.getByTestId('recording-primary-audio')).toHaveAttribute(
      'src',
      expect.stringContaining('/microphone.opus'),
    );
    expect(screen.getByTestId('recording-secondary-audio')).toHaveAttribute(
      'src',
      expect.stringContaining('/system.opus'),
    );
  });

  it('keeps a pending seek position when switching tracks before metadata loads', async () => {
    mocks.recordGet.mockResolvedValue({
      ...RECORD,
      audio: {
        ...RECORD.audio!,
        captureStatus: 'ready',
        transcriptionStatus: 'ready',
        mediaDurationMs: 31_000,
        tracks: ['microphone', 'system'],
      },
    });
    mocks.recordingSnapshot.mockResolvedValue(null);

    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive
        seekMediaMs={9_000}
        seekNonce={1}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: /音轨|Tracks/i }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /系统声音|System audio/i }),
    );
    const primaryAudio = screen.getByTestId(
      'recording-primary-audio',
    ) as HTMLAudioElement;
    fireEvent.loadedMetadata(primaryAudio);

    expect(primaryAudio.currentTime).toBe(9);
  });

  it('does not reuse a stale pending seek after switching to a track with the same primary URL', async () => {
    mocks.recordGet.mockResolvedValue({
      ...RECORD,
      audio: {
        ...RECORD.audio!,
        captureStatus: 'ready',
        transcriptionStatus: 'ready',
        mediaDurationMs: 31_000,
        tracks: ['microphone', 'system'],
      },
    });
    mocks.recordingSnapshot.mockResolvedValue(null);

    render(<RecordDetail recordId={RECORD.id} isActive />);

    const primaryAudio = (await screen.findByTestId(
      'recording-primary-audio',
    )) as HTMLAudioElement;
    Object.defineProperty(primaryAudio, 'readyState', {
      configurable: true,
      value: HTMLMediaElement.HAVE_METADATA,
    });
    primaryAudio.currentTime = 4;

    fireEvent.click(screen.getByRole('button', { name: /音轨|Tracks/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /麦克风|Microphone/i }),
    );
    primaryAudio.currentTime = 7;

    fireEvent.click(screen.getByRole('button', { name: /音轨|Tracks/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /系统声音|System audio/i }),
    );
    fireEvent.loadedMetadata(primaryAudio);

    expect(primaryAudio.currentTime).toBe(7);
  });

  it('keeps the speaker badge and transcript text on the same first line', async () => {
    mocks.recordGet.mockResolvedValue({
      ...RECORD,
      audio: {
        ...RECORD.audio!,
        tracks: ['microphone', 'system'],
      },
    });
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
      segments: [
        {
          segmentId: 'inline-speaker',
          track: 'microphone',
          startSample: 0,
          endSample: 16_000,
          text: '今天怎么样。',
          revision: 1,
        },
      ],
    });

    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    const line = await screen.findByTestId('transcript-speaker-line');
    expect(line).toHaveTextContent(/Speaker A.*今天怎么样。/i);
    expect(line).not.toHaveTextContent('我');
    expect(line.textContent).not.toMatch(/\[Speaker A\]/i);
    expect(line).toHaveClass('flex');
    const article = line.closest('article');
    expect(article).toHaveClass(
      'grid-cols-[52px_minmax(0,1fr)]',
      'items-start',
    );
    expect(within(article!).getByText('00:00')).toHaveClass(
      'self-start',
      'pt-1',
    );
  });

  it('pulls a live transcript delta immediately after its change event', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mocks.recordTranscript.mockResolvedValue({
      schemaVersion: 1,
      recordId: RECORD.id,
      projectionRevision: 1,
      state: 'live',
      sampleRate: 16_000,
      provenance: {
        provider: 'sherpa-onnx',
        modelPackRevision: 'test',
        onnxRuntimeVersion: 'test',
      },
      segments: [],
    });

    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    await waitFor(() => {
      expect(mocks.eventListeners.has('record:changed')).toBe(true);
    });
    mocks.recordTranscriptDelta.mockResolvedValueOnce({
      recordId: RECORD.id,
      projectionRevision: 2,
      state: 'live',
      upserts: [
        {
          segmentId: 'event-segment',
          track: 'microphone',
          startSample: 16_000,
          endSample: 24_000,
          text: '通知后立即显示',
          revision: 1,
        },
      ],
      cursor: { journalBytes: 256, projectionRevision: 2 },
    });

    mocks.eventListeners.get('record:changed')?.({
      payload: {
        sequence: 1,
        id: RECORD.id,
        kind: 'transcript',
      },
    });

    expect(await screen.findByText('通知后立即显示')).toBeInTheDocument();
  });

  it('keeps the status beside the title and note shortcuts inside one borderless composer', async () => {
    render(
      <RecordDetail
        recordId={RECORD.id}
        isActive={false}
        initialRecordingSnapshot={SNAPSHOT}
      />,
    );

    const titleStatus = await screen.findByTestId('record-title-status');
    expect(titleStatus).toContainElement(
      within(titleStatus).getByRole('status'),
    );

    const composer = screen.getByTestId('recording-note-composer');
    expect(composer).toContainElement(
      screen.getByRole('button', { name: /标记重点|Mark highlight/i }),
    );
    expect(composer).toContainElement(
      screen.getByRole('button', { name: /添加笔记|Add note/i }),
    );
    expect(composer).not.toHaveClass('border');
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
