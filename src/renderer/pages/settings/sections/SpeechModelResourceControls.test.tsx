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
  it('requires explicit installation while explaining the separate Agent switch', async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(
      <SpeechModelResourceControls
        status={modelStatus()}
        onInstall={onInstall}
      />,
    );

    expect(screen.getByText('尚未安装本地模型')).toBeInTheDocument();
    expect(screen.getByText(/上方开关只控制 Agent/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '安装模型' }));
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it('projects real install progress', () => {
    render(
      <SpeechModelResourceControls
        status={modelStatus({
          status: 'installing',
          downloadedBytes: 70 * 1024 * 1024,
        })}
      />,
    );

    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('removes a ready pack only through the resource action', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <SpeechModelResourceControls
        status={modelStatus({
          status: 'ready',
          usable: true,
          activeRevision: 'speech-pack-1',
          downloadedBytes: 280 * 1024 * 1024,
        })}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText(/speech-pack-1/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '移除' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
