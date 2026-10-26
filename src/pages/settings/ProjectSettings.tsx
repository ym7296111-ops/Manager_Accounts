import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { RequireCapability } from '@/components/auth/RequireAuth';
import { PROJECT_SETTINGS_CAPABILITY } from '@/components/layout/nav-items';
import { useI18n } from '@/i18n/I18nContext';
import type { TranslationKey } from '@/i18n/locales/ar';
import Classifications from '@/pages/settings/Classifications';
import Parties from '@/pages/settings/Parties';
import SisterCompanies from '@/pages/settings/SisterCompanies';
import StationsWarehouses from '@/pages/settings/StationsWarehouses';
import { useUnsavedChanges } from '@/pages/settings/unsavedChanges';
import FiscalSettings from '@/pages/settings/FiscalSettings';
import { UnsavedChangesProvider } from '@/pages/settings/UnsavedChangesProvider';

/**
 * Project-settings screen (`/settings/project`).
 *
 * The route keeps its own capability gate (`project.settings:manage`) and
 * exposes five tabs under the header, in this order:
 *
 *   1. المحطات والمخازن        stations + warehouses (nested single read)
 *   2. التصنيفات               classifications (flat read assembled into a tree)
 *   3. جهات الوارد وأغراض الصرف  parties (a two-root tree: inbound / outbound)
 *   4. الشركات الشقيقة          sister companies (a two-level parent → branch tree)
 *   5. عام                     financial settings (annual years, periods, opening balances)
 *
 * Every tab fetches only while its own panel is mounted, so switching tabs
 * costs no background traffic. Sister companies sits at the top level rather
 * than inside the parties tab: its shape is a tree while the parties
 * directories are flat lists, and its purpose (intercompany transfers) is
 * distinct, so it reads better as a peer tab with no sub-tabs of its own.
 * General owns the fiscal-settings sub-tabs; application identity and branding
 * remain on their separate settings screen.
 *
 * The whole screen sits inside `UnsavedChangesProvider`: tabs are local state
 * and the inactive panel is unmounted, so switching away would silently discard
 * an in-progress opening balance. Both tab bars ask the provider first.
 */
type ProjectSettingsTab =
  'stations' | 'classifications' | 'parties' | 'sisterCompanies' | 'general';

interface ProjectSettingsTabConfig {
  id: ProjectSettingsTab;
  labelKey: TranslationKey;
}

const TABS: readonly ProjectSettingsTabConfig[] = [
  {
    id: 'stations',
    labelKey: 'settings.project.tabs.stations',
  },
  {
    id: 'classifications',
    labelKey: 'settings.project.tabs.classifications',
  },
  {
    id: 'parties',
    labelKey: 'settings.project.tabs.parties',
  },
  {
    id: 'sisterCompanies',
    labelKey: 'settings.project.tabs.sisterCompanies',
  },
  {
    id: 'general',
    labelKey: 'settings.project.tabs.general',
  },
] as const;

export default function ProjectSettings() {
  return (
    <RequireCapability requirement={PROJECT_SETTINGS_CAPABILITY}>
      <UnsavedChangesProvider>
        <ProjectSettingsScreen />
      </UnsavedChangesProvider>
    </RequireCapability>
  );
}

/**
 * The screen itself, inside the guard provider.
 *
 * Kept as a separate component so `ProjectSettings` can own the provider
 * without re-indenting the whole tree: the provider must be an ancestor of the
 * tabs, and the tab handlers need its `confirmNavigation` through a hook.
 */
function ProjectSettingsScreen() {
  const { t } = useI18n();
  const { confirmNavigation } = useUnsavedChanges();
  const [activeTab, setActiveTab] = useState<ProjectSettingsTab>('stations');

  const activeConfig = (TABS.find((tab) => tab.id === activeTab) ?? TABS[0])!;

  return (
    <div className="w-full max-w-full min-w-0 space-y-6">
      <header className="min-w-0 space-y-3">
        <nav
          aria-label="Breadcrumb"
          className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1.5 text-xs"
        >
          <span>{t('nav.settings')}</span>
          <span aria-hidden="true">/</span>
          <span className="text-foreground font-medium">{t('nav.projectSettings')}</span>
        </nav>

        <div className="flex min-w-0 items-center gap-3">
          <span className="bg-primary/10 text-primary grid size-10 place-items-center rounded-xl">
            <Settings2 className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-foreground text-xl font-bold tracking-tight">
              {t('nav.projectSettings')}
            </h1>
            <p className="text-muted-foreground text-sm">{t('settings.project.desc')}</p>
          </div>
        </div>
      </header>

      {/* Tabs — standard pattern, directly under the header. Only the active
            panel is mounted, so only it fetches data. */}
      <div className="w-full max-w-full min-w-0 space-y-4">
        <div
          role="tablist"
          aria-label={t('nav.projectSettings')}
          className="border-border flex max-w-full min-w-0 flex-wrap gap-x-1 border-b"
        >
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`project-settings-tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`project-settings-tabpanel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => confirmNavigation(() => setActiveTab(tab.id))}
                className={[
                  'relative inline-flex max-w-full min-w-0 border-b-2 px-3 py-3 text-start text-sm font-medium transition-colors sm:px-4',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
                  isActive
                    ? 'border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent',
                ].join(' ')}
              >
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`project-settings-tabpanel-${activeConfig.id}`}
          aria-labelledby={`project-settings-tab-${activeConfig.id}`}
          className="bg-card border-border w-full max-w-full min-w-0 overflow-hidden rounded-2xl border p-4 shadow-sm sm:p-6"
        >
          {activeConfig.id === 'stations' ? (
            <StationsWarehouses />
          ) : activeConfig.id === 'classifications' ? (
            <Classifications />
          ) : activeConfig.id === 'parties' ? (
            <Parties />
          ) : activeConfig.id === 'sisterCompanies' ? (
            /* The tree opens straight away — no sub-tabs of its own. */
            <SisterCompanies />
          ) : (
            <FiscalSettings />
          )}
        </div>
      </div>
    </div>
  );
}
