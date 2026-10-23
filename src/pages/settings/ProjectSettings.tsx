import { Settings2 } from 'lucide-react';
import { RequireCapability } from '@/components/auth/RequireAuth';
import { PROJECT_SETTINGS_CAPABILITY } from '@/components/layout/nav-items';
import { useI18n } from '@/i18n/I18nContext';
import GeneralSettings from '@/pages/settings/GeneralSettings';

/**
 * Project identity administration (`/settings/project`).
 *
 * The route and the data hook have separate gates: the route provides an
 * immediate accessible 403, while the dedicated server RPCs remain the actual
 * security boundary. Saving reuses the validated branding form and its atomic
 * audit trail without weakening the existing general-settings permission.
 */
export default function ProjectSettings() {
  const { t } = useI18n();

  return (
    <RequireCapability requirement={PROJECT_SETTINGS_CAPABILITY}>
      <div className="space-y-6">
        <header className="space-y-3">
          <nav
            aria-label="Breadcrumb"
            className="text-muted-foreground flex items-center gap-1.5 text-xs"
          >
            <span>{t('nav.settings')}</span>
            <span aria-hidden="true">/</span>
            <span className="text-foreground font-medium">{t('nav.projectSettings')}</span>
          </nav>

          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary grid size-10 place-items-center rounded-xl">
              <Settings2 className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-foreground text-xl font-bold tracking-tight">
                {t('nav.projectSettings')}
              </h1>
              <p className="text-muted-foreground text-sm">{t('settings.project.desc')}</p>
            </div>
          </div>
        </header>

        <GeneralSettings scope="project" />
      </div>
    </RequireCapability>
  );
}
