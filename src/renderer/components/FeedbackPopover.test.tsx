import { render, screen } from '@testing-library/react';
import { createRef, type ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FeedbackPopover from './FeedbackPopover';

const mocks = vi.hoisted(() => ({
  popoverProps: null as ComponentProps<typeof import('@/components/ui/Popover').Popover> | null,
}));

vi.mock('@/components/ui/Popover', () => ({
  Popover: (props: ComponentProps<typeof import('@/components/ui/Popover').Popover>) => {
    mocks.popoverProps = props;
    return <div data-testid="feedback-popover">{props.children}</div>;
  },
}));

vi.mock('@/utils/browserMock', () => ({
  isTauriEnvironment: () => false,
}));

describe('FeedbackPopover', () => {
  beforeEach(() => {
    mocks.popoverProps = null;
  });

  it('opens beside the sidebar edge with the shared App Shell surface', () => {
    const triggerRef = createRef<HTMLDivElement>();

    render(
      <FeedbackPopover
        open
        onClose={vi.fn()}
        onOpenBugReport={vi.fn()}
        triggerRef={triggerRef}
      />,
    );

    expect(screen.getByTestId('feedback-popover')).toBeInTheDocument();
    expect(mocks.popoverProps).toMatchObject({
      placement: 'right-end',
      offset: 8,
      unstyled: true,
    });
    expect(mocks.popoverProps?.className).toContain('bg-[var(--paper-elevated)]');
    expect(mocks.popoverProps?.className).toContain('shadow-xl');
    expect(mocks.popoverProps?.className).toContain('rounded-xl');
  });
});
