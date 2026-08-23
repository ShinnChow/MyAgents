import { DEFAULT_HOST_INTERACTION, type HostInteractionCapability } from '../shared/types/hostInteraction';
import type { InteractionScenario } from './system-prompt';

const CHANNEL_INTERACTION_TOOLS = ['EnterPlanMode', 'ExitPlanMode'] as const;

export type ChannelInteractionTool = typeof CHANNEL_INTERACTION_TOOLS[number] | 'AskUserQuestion';

/**
 * Resolve the optional group-specific tool deny overlay for one IM request.
 * Group channels are unrestricted by default; private messages never inherit
 * a group-only deny list.
 */
export function resolveImGroupToolsDeny(
  sourceType: 'private' | 'group' | undefined,
  configured: readonly string[] | undefined,
): string[] {
  return sourceType === 'group' ? [...(configured ?? [])] : [];
}

export function normalizeHostInteractionCapability(value: unknown): HostInteractionCapability {
  if (!value || typeof value !== 'object') return DEFAULT_HOST_INTERACTION;
  const askUserQuestion = (value as { askUserQuestion?: unknown }).askUserQuestion;
  return {
    askUserQuestion: askUserQuestion === 'native-card' ? 'native-card' : 'none',
  };
}

export function isChannelInteractionScenario(
  scenario: InteractionScenario,
): scenario is Extract<InteractionScenario, { type: 'im' | 'agent-channel' }> {
  return scenario.type === 'im' || scenario.type === 'agent-channel';
}

export function hostInteractionCapabilityForScenario(
  scenario: InteractionScenario,
): HostInteractionCapability {
  if (!isChannelInteractionScenario(scenario)) return DEFAULT_HOST_INTERACTION;
  return normalizeHostInteractionCapability(scenario.hostInteraction);
}

export function supportsAskUserQuestionNativeCard(scenario: InteractionScenario): boolean {
  return isChannelInteractionScenario(scenario)
    && hostInteractionCapabilityForScenario(scenario).askUserQuestion === 'native-card';
}

export function shouldDisallowAskUserQuestion(scenario: InteractionScenario): boolean {
  return isChannelInteractionScenario(scenario) && !supportsAskUserQuestionNativeCard(scenario);
}

export function channelInteractionDenyReason(scenario: InteractionScenario): string {
  return `当前 ${scenario.type} 渠道不支持结构化提问交互，请改用普通文本询问用户或在支持原生卡片的渠道中重试。`;
}

export function shouldHardDenyChannelInteractionTool(
  toolName: string,
  scenario: InteractionScenario,
): boolean {
  if (!isChannelInteractionScenario(scenario)) return false;
  if (toolName === 'AskUserQuestion') return shouldDisallowAskUserQuestion(scenario);
  return (CHANNEL_INTERACTION_TOOLS as readonly string[]).includes(toolName);
}

export function getChannelInteractionDisallowedTools(scenario: InteractionScenario): ChannelInteractionTool[] {
  if (!isChannelInteractionScenario(scenario)) return [];
  return [
    ...(shouldDisallowAskUserQuestion(scenario) ? ['AskUserQuestion' as const] : []),
    ...CHANNEL_INTERACTION_TOOLS,
  ];
}

export function shouldUseNonBypassForNativeAskUserQuestion(
  permissionMode: string | undefined,
  scenario: InteractionScenario,
): boolean {
  return (permissionMode === 'fullAgency' || permissionMode === 'bypassPermissions')
    && supportsAskUserQuestionNativeCard(scenario);
}

export function isBridgeAskUserQuestionTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === 'ask_user_question'
    || normalized === 'askuserquestion'
    || normalized.endsWith('_ask_user_question')
    || normalized.endsWith('_askuserquestion');
}
