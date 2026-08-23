import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../../../shared/types/agent';
import ChannelWizard from './ChannelWizard';

vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => false }));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    config: { agents: [] },
    refreshConfig: vi.fn(),
  }),
}));
vi.mock('@/config/services/agentConfigService', () => ({
  patchAgentConfig: vi.fn(),
  invokeStartAgentChannel: vi.fn(),
}));

const agent: AgentConfig = {
  id: 'agent-1',
  name: 'Agent',
  enabled: true,
  permissionMode: 'auto',
  channels: [],
};

describe('ChannelWizard Feishu credential provisioning', () => {
  it('defaults the official Feishu plugin to QR provisioning with a manual fallback', () => {
    render(
      <ChannelWizard
        agent={agent}
        platform="openclaw:openclaw-lark"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('tab', { name: '扫码添加' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '手动配置' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('扫码创建机器人')).toBeInTheDocument();
    expect(screen.getByText(/将创建新的 飞书 机器人/)).toBeInTheDocument();
    expect(screen.queryByAltText('飞书开放平台 — 凭证与基础信息')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('tab', { name: '手动配置' }));

    expect(screen.getByRole('tab', { name: '扫码添加' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: '手动配置' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText(/appId/)).toBeInTheDocument();
    expect(screen.getByLabelText(/appSecret/)).toHaveAttribute('type', 'password');
    expect(screen.getByRole('link', { name: /前往飞书开放平台创建自建应用/ })).toHaveAttribute(
      'href',
      'https://open.feishu.cn/app',
    );
    expect(screen.getByAltText('飞书开放平台 — 凭证与基础信息')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/appId/), { target: { value: 'cli_app' } });
    fireEvent.change(screen.getByLabelText(/appSecret/), { target: { value: 'secret' } });
    expect(screen.getByRole('button', { name: /下一步/ })).toBeEnabled();
  });
});
