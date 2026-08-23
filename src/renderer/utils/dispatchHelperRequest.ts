// dispatchHelperRequest — single producer of CUSTOM_EVENTS.LAUNCH_BUG_REPORT
// inside the renderer. BugReportOverlay, SettingsHelperInbox, and the
// Runtime-missing dialog's "让 AI 小助理安装" button all funnel through
// this util; Chat.tsx's BugReport entry remains as a separate dispatch site
// because it lives in a different module boundary (chat input toolbar) and
// the migration there is tracked as follow-up. Concentrating the dispatch
// here means the detail-shape contract lives in one place, and adding
// optional fields (e.g. a future `source` for analytics segmentation) is a
// single edit instead of 3.
//
// Note on the legacy event name: the event is called LAUNCH_BUG_REPORT for
// historical reasons but already serves multiple non-bug-report flows. The
// renaming is tracked as future cleanup; for 0.2.7 we preserve the name to
// avoid touching the App.tsx handler and its callers.

import type { ImageAttachment } from '@/components/SimpleChatInput';
import type { AssistantEntry } from '@/analytics';

import { CUSTOM_EVENTS } from '../../shared/constants';

interface HelperRequestBase {
    /** User's message body. Whitespace is trimmed before dispatch. */
    description: string;
    /** Optional explicit provider override; handler falls back to helper Agent. */
    providerId?: string;
    /** Optional explicit model override; handler falls back to helper Agent. */
    model?: string;
    /** Optional image attachments (data-url previews + File handles). */
    images?: ImageAttachment[];
    /**
     * Resume an existing helper session in a new Tab instead of starting a
     * fresh conversation. When set, `description`/`images`/picker are ignored
     * — the handler routes to the canonical existing-Session opener and leaves
     * the title to Chat.tsx's natural session-title flow.
     */
    resumeSessionId?: string;
    /** Fine-grained helper launch location for session_new analytics. */
    assistantEntry?: AssistantEntry;
}

type SupportHelperRequest = HelperRequestBase & {
    scenario?: 'support';
    /** App version, surfaced in the support conversation context. */
    appVersion: string;
};

type SpaceToolInstallHelperRequest = HelperRequestBase & {
    scenario: 'space_tool_install';
    appVersion?: never;
};

export type HelperRequestInput =
    | SupportHelperRequest
    | SpaceToolInstallHelperRequest;

export type HelperRequestDetail =
    | (Omit<SupportHelperRequest, 'scenario'> & { scenario: 'support' })
    | SpaceToolInstallHelperRequest;

export function dispatchHelperRequest(input: HelperRequestInput): void {
    const common = {
        description: input.description.trim(),
        providerId: input.providerId,
        model: input.model,
        images: input.images,
        resumeSessionId: input.resumeSessionId,
        assistantEntry: input.assistantEntry,
    };
    const detail: HelperRequestDetail = input.scenario === 'space_tool_install'
        ? { ...common, scenario: 'space_tool_install' }
        : { ...common, scenario: 'support', appVersion: input.appVersion };
    window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
            detail,
        }),
    );
}
