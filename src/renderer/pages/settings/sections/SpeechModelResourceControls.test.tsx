import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { SpeechModelPackStatus } from '../../../../shared/types/record';
import { SpeechModelResourceControls } from './SpeechModelResourceControls';

function modelStatus(
  overrides: Partial<SpeechModelPackStatus> = {},
): SpeechModelPackStatus {
  return {
    status: 'not_installed',
    usable: false,
    availableRevision: 'speech-pack-1',
    downloadedBytes: 0,
    totalDownloadBytes: 280 * 1024 * 1024,
    installedModelBytes: 512 * 1024 * 1024,
    ...overrides,
  };
}

describe('SpeechModelResourceControls', () => {
  it('keeps the not-installed state to one status-and-action row', async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(
      <SpeechModelResourceControls
        status={modelStatus()}
        onInstall={onInstall}
      />,
    );

    expect(screen.getByText('尚未安装本地模型')).toBeInTheDocument();
    expect(screen.queryByText('ASR')).not.toBeInTheDocument();
    expect(screen.queryByText(/sherpa-onnx/)).not.toBeInTheDocument();
    expect(screen.queryByText(/下载 280 MiB/)).not.toBeInTheDocument();
    expect(screen.queryByText(/上方开关只控制 Agent/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '安装模型' }));
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it('projects real install progress', () => {
    render(
      <SpeechModelResourceControls
        status={modelStatus({
          status: 'downloading',
          downloadedBytes: 70 * 1024 * 1024,
        })}
      />,
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    expect(screen.queryByText(/70\.0 MiB \/ 280 MiB/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '安装中' })).toBeDisabled();
  });

  it.each([
    ['checking', '正在核验官方模型清单'],
    ['verifying', '正在校验本地模型'],
    ['installing', '正在加载并激活本地模型'],
  ] as const)('projects the %s installation stage', (status, label) => {
    render(<SpeechModelResourceControls status={modelStatus({ status })} />);

    expect(
      screen.getByRole('progressbar', { name: label }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '安装中' })).toBeDisabled();
  });

  it('offers the available revision without treating the old pack as usable', async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(
      <SpeechModelResourceControls
        status={modelStatus({
          status: 'update_available',
          activeRevision: 'speech-pack-0',
          availableRevision: 'speech-pack-1',
        })}
        onInstall={onInstall}
      />,
    );

    expect(screen.getByText('本地模型有可用更新')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '更新模型' }));
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it('shows the structured install error and retries explicitly', async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(
      <SpeechModelResourceControls
        status={modelStatus({
          status: 'error',
          lastErrorCode: 'SPEECH_RESOURCE_NETWORK',
        })}
        onInstall={onInstall}
      />,
    );

    expect(screen.getByText(/无法连接官方模型清单/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试安装' }));
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it.each([
    ['SPEECH_RESOURCE_ACTIVATION_FAILED', /无法安全激活/],
    ['SPEECH_WORKER_START_FAILED', /内置语音引擎无法启动/],
    ['SPEECH_WORKER_PROTOCOL_ERROR', /内置语音引擎响应异常/],
    ['SPEECH_PATH_ENCODING_UNSUPPORTED', /路径无法用于本地语音引擎/],
  ] as const)('shows actionable copy for %s', (lastErrorCode, copy) => {
    render(
      <SpeechModelResourceControls
        status={modelStatus({ status: 'error', lastErrorCode })}
      />,
    );

    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it('keeps a removal failure visible and retries the removal action', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <SpeechModelResourceControls
        status={modelStatus({
          status: 'error',
          usable: true,
          activeRevision: 'speech-pack-1',
          lastErrorCode: 'SPEECH_RESOURCE_REMOVE_FAILED',
        })}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText(/无法安全移除本地模型/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试移除' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('hides the complete resource area when the pack is ready', () => {
    const { container } = render(
      <SpeechModelResourceControls
        status={modelStatus({
          status: 'ready',
          usable: true,
          activeRevision: 'speech-pack-1',
          downloadedBytes: 280 * 1024 * 1024,
        })}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('restores a recovery row for a ready pack with an activation warning', async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(
      <SpeechModelResourceControls
        status={modelStatus({
          status: 'ready',
          usable: true,
          activeRevision: 'speech-pack-1',
          lastErrorCode: 'SPEECH_RESOURCE_ACTIVATION_DURABILITY_UNCONFIRMED',
        })}
        onInstall={onInstall}
      />,
    );

    expect(screen.getByText(/系统未能确认目录同步完成/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新安装' }));
    expect(onInstall).toHaveBeenCalledOnce();
  });
});
