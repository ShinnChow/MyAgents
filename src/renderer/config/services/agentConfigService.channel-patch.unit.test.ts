import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../types';
import type { ChannelConfig } from '../../../shared/types/agent';

const configState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('./appConfigService', () => ({
  atomicModifyConfig: vi.fn(async (modify: (config: AppConfig) => AppConfig) => {
    configState.current = modify(configState.current as AppConfig);
    return configState.current;
  }),
  loadAppConfig: vi.fn(async () => configState.current),
}));

import {
  applyAgentChannelCredentialProvisioning,
  patchAgentChannelConfig,
  patchAgentChannelOpenClawConfig,
} from './agentConfigService';

function initialConfig(): AppConfig {
  return {
    defaultPermissionMode: 'auto',
    themeId: 'myagents-default',
    appearanceMode: 'system',
    minimizeToTray: true,
    showDevTools: false,
    autoStart: false,
    osNotifications: true,
    notificationSound: true,
    agents: [{
      id: 'agent-1',
      name: 'Agent',
      enabled: true,
      permissionMode: 'auto',
      channels: [{
        id: 'channel-1',
        name: 'Lark',
        type: 'openclaw:openclaw-lark',
        enabled: true,
        setupCompleted: true,
        openclawPluginConfig: { timeout: 30, streaming: true },
      }],
    }],
  };
}

describe('disk-latest Agent channel patches', () => {
  beforeEach(() => {
    configState.current = initialConfig();
  });

  it('preserves a scalar deletion when another channel control writes next', async () => {
    await patchAgentChannelOpenClawConfig(
      'agent-1',
      'channel-1',
      { type: 'delete', key: 'timeout' },
    );
    await patchAgentChannelConfig(
      'agent-1',
      'channel-1',
      { groupActivation: 'always' },
    );

    expect((configState.current as AppConfig).agents?.[0].channels?.[0]).toMatchObject({
      groupActivation: 'always',
      openclawPluginConfig: { streaming: true },
    });
  });

  it('atomically merges provisioned credentials and the scanning user into disk-latest state', async () => {
    (configState.current as AppConfig).agents![0].channels![0] = {
      ...(configState.current as AppConfig).agents![0].channels![0],
      openclawPluginConfig: { streaming: true, preserved: 'yes' },
      allowedUsers: ['ou_existing'],
    };

    const updated = await applyAgentChannelCredentialProvisioning(
      'agent-1',
      'channel-1',
      { appId: 'cli_app', appSecret: 'secret', domain: 'lark' },
      'ou_scanner',
    );

    expect(updated.openclawPluginConfig).toEqual({
      streaming: true,
      preserved: 'yes',
      appId: 'cli_app',
      appSecret: 'secret',
      domain: 'lark',
    });
    expect(updated.allowedUsers).toEqual(['ou_existing', 'ou_scanner']);
  });

  it('atomically creates a provisioned channel without replacing concurrently persisted channels', async () => {
    (configState.current as AppConfig).agents![0].channels!.push({
      id: 'channel-concurrent',
      name: 'Concurrent Channel',
      type: 'telegram',
      enabled: false,
      botToken: 'preserve-me',
    });
    const initialChannel = {
      id: 'channel-new',
      name: 'Feishu',
      type: 'openclaw:openclaw-lark',
      enabled: true,
      setupCompleted: true,
      openclawPluginConfig: { streaming: true },
      allowedUsers: [],
    } satisfies ChannelConfig;

    const updated = await applyAgentChannelCredentialProvisioning(
      'agent-1',
      'channel-new',
      { appId: 'cli_app', appSecret: 'secret', domain: 'feishu' },
      'ou_scanner',
      initialChannel,
    );

    expect(updated).toMatchObject({
      id: 'channel-new',
      openclawPluginConfig: {
        streaming: true,
        appId: 'cli_app',
        appSecret: 'secret',
        domain: 'feishu',
      },
      allowedUsers: ['ou_scanner'],
    });
    expect((configState.current as AppConfig).agents?.[0].channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'channel-1' }),
      expect.objectContaining({ id: 'channel-concurrent', botToken: 'preserve-me' }),
      expect.objectContaining({ id: 'channel-new' }),
    ]));
  });

  it('accepts only the native permission vocabulary for a system Runtime channel', async () => {
    (configState.current as AppConfig).agents![0].runtime = 'codex';

    await expect(patchAgentChannelConfig('agent-1', 'channel-1', {
      overrides: { permissionMode: 'fullAgency' },
    })).rejects.toThrow("Invalid Channel permissionMode 'fullAgency'");

    await expect(patchAgentChannelConfig('agent-1', 'channel-1', {
      overrides: { permissionMode: '' },
    })).rejects.toThrow("Invalid Channel permissionMode ''");

    await expect(patchAgentChannelConfig('agent-1', 'channel-1', {
      overrides: { permissionMode: 'full-auto' },
    })).resolves.toMatchObject({ overrides: { permissionMode: 'full-auto' } });
  });

  it('keeps managed Channel writes in the product permission vocabulary', async () => {
    (configState.current as AppConfig).agents![0].providerId = 'codex-sub';

    await expect(patchAgentChannelConfig('agent-1', 'channel-1', {
      overrides: { permissionMode: 'full-auto' },
    })).rejects.toThrow("Invalid Channel permissionMode 'full-auto'");

    await expect(patchAgentChannelConfig('agent-1', 'channel-1', {
      overrides: { permissionMode: 'fullAgency' },
    })).resolves.toMatchObject({ overrides: { permissionMode: 'fullAgency' } });
  });

  it('preserves a historical managed native permission during a model-only edit', async () => {
    (configState.current as AppConfig).agents![0].providerId = 'codex-sub';
    (configState.current as AppConfig).agents![0].channels![0].overrides = {
      permissionMode: 'suggest',
      model: 'gpt-old',
    };

    await expect(patchAgentChannelConfig('agent-1', 'channel-1', {
      overrides: { permissionMode: 'suggest', model: 'gpt-new' },
    })).resolves.toMatchObject({
      overrides: { permissionMode: 'suggest', model: 'gpt-new' },
    });
  });
});
