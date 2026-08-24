import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import RecordingSourceDialog from './RecordingSourceDialog';

describe('RecordingSourceDialog', () => {
  it('requires at least one source and returns the explicit selection', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <RecordingSourceDialog
        mode="start"
        initialSelection={{ microphone: true, system: true }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        onOpenSpeechSettings={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: /麦克风/ }));
    await user.click(screen.getByRole('checkbox', { name: /系统声音/ }));
    expect(screen.getByRole('button', { name: '录音' })).toBeDisabled();
    expect(screen.getByText('请至少选择一种录音来源。')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /麦克风/ }));
    await user.click(screen.getByRole('button', { name: '录音' }));
    expect(onConfirm).toHaveBeenCalledWith({ microphone: true, system: false });
  });

  it('keeps model installation optional and exposes the existing settings entry', async () => {
    const user = userEvent.setup();
    const onOpenSpeechSettings = vi.fn();
    render(
      <RecordingSourceDialog
        mode="start"
        initialSelection={{ microphone: true, system: true }}
        modelPackUsable={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onOpenSpeechSettings={onOpenSpeechSettings}
      />,
    );

    expect(screen.getByText(/仍会完整保存音频/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开语音识别设置' }));
    expect(onOpenSpeechSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '录音' })).toBeEnabled();
  });

  it('describes saved source changes as applying to the next recording', () => {
    render(
      <RecordingSourceDialog
        mode="settings"
        initialSelection={{ microphone: true, system: false }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onOpenSpeechSettings={vi.fn()}
      />,
    );

    expect(screen.getByText(/当前录音不会切换/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled();
  });
});
