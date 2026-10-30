import { BookOpenText, Eye, FolderOpen } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { useI18n } from '@/i18n/I18nContext';
import { APS_LETTERS_PATH } from '@/lib/apsLetters';

/** APS currently exposes only the read-only letters tab. */
export default function ApsWorkspaceLayout() {
  const { t } = useI18n();

  return (
    <div className="@container min-w-0 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide">
            <FolderOpen className="text-primary size-4" aria-hidden="true" />
            {t('aps.workspace.eyebrow')}
          </div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight sm:text-3xl">
            {t('aps.workspace.title')}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t('aps.workspace.description')}
          </p>
        </div>
        <span className="border-border bg-card text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
          <Eye className="text-primary size-4" aria-hidden="true" />
          {t('aps.workspace.readOnly')}
        </span>
      </header>

      <nav aria-label={t('aps.workspace.navigation')} className="border-border border-b">
        <NavLink
          to={APS_LETTERS_PATH}
          className="text-primary border-primary inline-flex min-h-12 items-center gap-2 border-b-2 px-1 text-sm font-semibold"
        >
          <BookOpenText className="size-4" aria-hidden="true" />
          {t('aps.letters.tab')}
        </NavLink>
      </nav>

      <Outlet />
    </div>
  );
}
