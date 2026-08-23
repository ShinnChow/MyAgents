import { describe, expect, it } from 'vitest';

import {
  getChannelInteractionDisallowedTools,
  isBridgeAskUserQuestionTool,
  resolveImGroupToolsDeny,
  shouldDisallowAskUserQuestion,
  shouldHardDenyChannelInteractionTool,
  shouldUseNonBypassForNativeAskUserQuestion,
  supportsAskUserQuestionNativeCard,
} from './host-interaction';
import type { InteractionScenario } from './system-prompt';

describe('host interaction policy', () => {
  it('defaults group tool deny to empty while preserving explicit overrides', () => {
    expect(resolveImGroupToolsDeny('group', undefined)).toEqual([]);
    expect(resolveImGroupToolsDeny('group', [])).toEqual([]);
    expect(resolveImGroupToolsDeny('group', ['CustomDangerousTool'])).toEqual([
      'CustomDangerousTool',
    ]);
    expect(resolveImGroupToolsDeny('private', ['CustomDangerousTool'])).toEqual([]);
  });

  it('defaults channel sessions to disabling AskUserQuestion', () => {
    const scenario: InteractionScenario = { type: 'im', platform: 'telegram', sourceType: 'private' };

    expect(shouldDisallowAskUserQuestion(scenario)).toBe(true);
    expect(getChannelInteractionDisallowedTools(scenario)).toEqual([
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
    ]);
  });

  it('allows AskUserQuestion only for native-card capable channel hosts', () => {
    const scenario: InteractionScenario = {
      type: 'im',
      platform: 'feishu',
      sourceType: 'private',
      hostInteraction: { askUserQuestion: 'native-card' },
    };

    expect(supportsAskUserQuestionNativeCard(scenario)).toBe(true);
    expect(shouldDisallowAskUserQuestion(scenario)).toBe(false);
    expect(getChannelInteractionDisallowedTools(scenario)).toEqual([
      'EnterPlanMode',
      'ExitPlanMode',
    ]);
  });

  it('forces builtin fullAgency native-card sessions through non-bypass permission path', () => {
    const scenario: InteractionScenario = {
      type: 'agent-channel',
      platform: 'feishu',
      sourceType: 'private',
      hostInteraction: { askUserQuestion: 'native-card' },
    };

    expect(shouldUseNonBypassForNativeAskUserQuestion('fullAgency', scenario)).toBe(true);
    expect(shouldUseNonBypassForNativeAskUserQuestion('bypassPermissions', scenario)).toBe(true);
    expect(shouldUseNonBypassForNativeAskUserQuestion('auto', scenario)).toBe(false);
    expect(shouldUseNonBypassForNativeAskUserQuestion('fullAgency', { type: 'desktop' })).toBe(false);
  });

  it('hard-denies channel interaction tools before SDK permission resolver can bypass canUseTool', () => {
    const unsupported: InteractionScenario = { type: 'im', platform: 'telegram', sourceType: 'private' };
    const nativeCard: InteractionScenario = {
      type: 'im',
      platform: 'feishu',
      sourceType: 'private',
      hostInteraction: { askUserQuestion: 'native-card' },
    };

    expect(shouldHardDenyChannelInteractionTool('AskUserQuestion', unsupported)).toBe(true);
    expect(shouldHardDenyChannelInteractionTool('AskUserQuestion', nativeCard)).toBe(false);
    expect(shouldHardDenyChannelInteractionTool('EnterPlanMode', nativeCard)).toBe(true);
    expect(shouldHardDenyChannelInteractionTool('Bash', unsupported)).toBe(false);
  });

  it('recognizes OpenClaw ask_user_question bridge tools without removing oauth tools', () => {
    expect(isBridgeAskUserQuestionTool('feishu_ask_user_question')).toBe(true);
    expect(isBridgeAskUserQuestionTool('lark_askUserQuestion')).toBe(true);
    expect(isBridgeAskUserQuestionTool('feishu_oauth_start')).toBe(false);
  });
});
