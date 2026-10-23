import { Navigate, useParams } from 'react-router';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/i18n/I18nContext';
import { getWorkspaceBySlug } from '@/lib/workspaces';

/**
 * Prepared workspace shell for APS, the independent 10th workshops entity,
 * and the future read-only reports aggregation layer.
 *
 * Internal accounting/workshop/report modules are deliberately not mounted in
 * this restructuring milestone. No data is shared or written across entities.
 */
export default function WorkspacePage() {
  const { t } = useI18n();
  const { workspaceSlug } = useParams();
  const workspace = getWorkspaceBySlug(workspaceSlug);

  if (workspace === null) {
    return <Navigate to="/404" replace />;
  }

  const Icon = workspace.icon;

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-3">
        <span className="bg-primary/10 text-primary grid size-10 shrink-0 place-items-center rounded-xl">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <h1 className="text-foreground text-xl font-bold tracking-tight">
            {t(workspace.labelKey)}
          </h1>
          <p className="text-muted-foreground text-sm">{t(workspace.descriptionKey)}</p>
        </div>
      </header>

      <EmptyState
        icon={Icon}
        title={t('workspace.emptyTitle')}
        description={t('workspace.emptyBody')}
      />
    </div>
  );
}
