import { FolderKanban } from 'lucide-react';
import { useParams } from 'react-router';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Workspace screen (1..3).
 *
 * Deliberately an empty, fully prepared slot — the sidebar accordion above it
 * demonstrates the expand/collapse behaviour while the workspace fills up
 * with real units in later milestones.
 */
export default function WorkspacePage() {
  const { t } = useI18n();
  const { workspaceId } = useParams();
  const workspaceNumber = workspaceId ?? '1';

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary grid size-10 place-items-center rounded-xl">
          <FolderKanban className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-foreground text-xl font-bold tracking-tight">
            {t('workspace.title', { n: workspaceNumber })}
          </h1>
        </div>
      </header>

      <EmptyState
        icon={FolderKanban}
        title={t('workspace.emptyTitle')}
        description={t('workspace.emptyBody')}
      />
    </div>
  );
}
