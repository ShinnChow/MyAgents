import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { Popover } from '@/components/ui/Popover';
import { isProjectVisibleToUser, type Project } from '@/config/types';
import { useConfig } from '@/hooks/useConfig';
import { getFolderName } from '@/types/tab';

interface Props {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  tags?: string[];
  onSelect: (workspaceId: string) => void;
}

export function RecordWorkspacePicker({ open, onClose, anchorRef, tags = [], onSelect }: Props) {
  const { t } = useTranslation('task');
  const { projects } = useConfig();
  const pickableWorkspaces = useMemo<Project[]>(() => {
    return projects
      .filter(isProjectVisibleToUser)
      .slice()
      .sort((left, right) => {
        const leftOpened = left.lastOpened ? new Date(left.lastOpened).getTime() : 0;
        const rightOpened = right.lastOpened ? new Date(right.lastOpened).getTime() : 0;
        return rightOpened - leftOpened;
      });
  }, [projects]);
  const suggestedWorkspaceId = useMemo(() => {
    const normalizedTags = tags.map((tag) => tag.toLowerCase());
    const matched = pickableWorkspaces.find((project) => normalizedTags.includes(project.name.toLowerCase()));
    return (matched ?? pickableWorkspaces[0])?.id;
  }, [pickableWorkspaces, tags]);

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      placement="bottom-end"
      className="min-w-[240px] max-w-[320px] py-1"
    >
      <div className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]/70">
        {t('thoughts.workspacePicker')}
      </div>
      <div className="max-h-[280px] overflow-y-auto py-1">
        {pickableWorkspaces.length === 0 ? (
          <div className="px-3 py-4 text-xs text-[var(--ink-muted)]">{t('thoughts.noWorkspace')}</div>
        ) : (
          pickableWorkspaces.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => {
                onClose();
                onSelect(project.id);
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--hover-bg)] ${
                project.id === suggestedWorkspaceId ? 'bg-[var(--accent-warm-subtle)]' : ''
              }`}
            >
              <WorkspaceIcon icon={project.icon} size={20} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--ink)]">
                  {project.displayName || getFolderName(project.path)}
                </div>
                <div className="truncate text-xs text-[var(--ink-muted)]/70">{project.path}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </Popover>
  );
}

export default RecordWorkspacePicker;
