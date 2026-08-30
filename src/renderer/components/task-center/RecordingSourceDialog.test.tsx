import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import RecordingSourceDialog from './RecordingSourceDialog';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

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

    expect(
      screen.queryByText(/确认本次录音要保存的声音/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /麦克风/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('checkbox', { name: /麦克风/ }));
    await user.click(screen.getByRole('checkbox', { name: /系统声音/ }));
    expect(screen.getByRole('button', { name: '开始录音' })).toBeDisabled();
    expect(screen.getByText('请至少选择一种录音来源。')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /麦克风/ }));
    await user.click(screen.getByRole('button', { name: '开始录音' }));
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
    expect(screen.getByRole('button', { name: '开始录音' })).toBeEnabled();
  });

  it('shows only the system setting relevant to a macOS permission failure', () => {
    const platform = vi
      .spyOn(window.navigator, 'platform', 'get')
      .mockReturnValue('MacIntel');

    render(
      <RecordingSourceDialog
        mode="start"
        initialSelection={{ microphone: true, system: true }}
        error="RECORDING_SCREEN_PERMISSION_REQUIRED"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onOpenSpeechSettings={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: '打开屏幕录制权限设置' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开麦克风权限设置' }),
    ).not.toBeInTheDocument();

    platform.mockRestore();
  });

  it('opens the exact recording privacy setting through the trusted Tauri command', async () => {
    const user = userEvent.setup();
    const platform = vi
      .spyOn(window.navigator, 'platform', 'get')
      .mockReturnValue('MacIntel');
    mocks.invoke.mockResolvedValue(undefined);

    render(
      <RecordingSourceDialog
        mode="start"
        initialSelection={{ microphone: true, system: true }}
        error="RECORDING_MICROPHONE_PERMISSION_REQUIRED"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onOpenSpeechSettings={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: '打开麦克风权限设置' }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      'cmd_open_recording_privacy_settings',
      { source: 'microphone' },
    );

    platform.mockRestore();
  });

  it('keeps an opener failure visible to the user', async () => {
    const user = userEvent.setup();
    const platform = vi
      .spyOn(window.navigator, 'platform', 'get')
      .mockReturnValue('MacIntel');
    mocks.invoke.mockRejectedValueOnce(new Error('open failed'));

    render(
      <RecordingSourceDialog
        mode="start"
        initialSelection={{ microphone: true, system: false }}
        error="RECORDING_MICROPHONE_PERMISSION_REQUIRED"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onOpenSpeechSettings={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: '打开麦克风权限设置' }),
    );
    expect(
      screen.getByText('无法自动打开系统设置，请手动打开隐私与安全设置。'),
    ).toBeInTheDocument();

    platform.mockRestore();
  });

  it('keeps settings mode concise while preserving its save action', () => {
    render(
      <RecordingSourceDialog
        mode="settings"
        initialSelection={{ microphone: true, system: false }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onOpenSpeechSettings={vi.fn()}
      />,
    );

    expect(screen.queryByText(/当前录音不会切换/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled();
  });

  it('traps focus, closes once on Escape, and restores the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onCancel = vi.fn();
    const { unmount } = render(
      <RecordingSourceDialog
        mode="start"
        initialSelection={{ microphone: true, system: true }}
        onConfirm={vi.fn()}
        onCancel={onCancel}
        onOpenSpeechSettings={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /麦克风/ })).toHaveFocus(),
    );
    const last = screen.getByRole('button', { name: '开始录音' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(screen.getByRole('checkbox', { name: /麦克风/ })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
