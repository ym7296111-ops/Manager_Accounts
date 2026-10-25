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

/**
 * Project-settings screen (`/settings/project`).
 *
 * The route keeps its own capability gate (`project.settings:manage`) and
 * exposes five tabs under the header, in this order:
 *
 *   1. المحطات والمخازن        stations + warehouses (nested single read)
 *   2. التصنيفات               classifications (flat read assembled into a tree)
 *   3. جهات الوارد والمنصرف     parties (flat read, two sub-tabs by direction)
 *   4. الشركات الشقيقة          sister companies (a two-level parent → branch tree)
 *   5. عام                     a placeholder
 *
 * Every tab fetches only while its own panel is mounted, so switching tabs
 * costs no background traffic. Sister companies sits at the top level rather
 * than inside the parties tab: its shape is a tree while the parties
 * directories are flat lists, and its purpose (intercompany transfers) is
 * distinct, so it reads better as a peer tab with no sub-tabs of its own.
 * General is still a placeholder and issues no queries.
 */
type ProjectSettingsTab =
  'stations' | 'classifications' | 'parties' | 'sisterCompanies' | 'general';

interface ProjectSettingsTabConfig {
  id: ProjectSettingsTab;
  labelKey: TranslationKey;
  /** Placeholder copy for the tabs whose content has not been built yet. */
  placeholderKey?: TranslationKey;
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
    placeholderKey: 'settings.project.tabs.generalPlaceholder',
  },
] as const;

export default function ProjectSettings() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<ProjectSettingsTab>('stations');

  const activeConfig = (TABS.find((tab) => tab.id === activeTab) ?? TABS[0])!;

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

        {/* Tabs — standard pattern, directly under the header. Only the active
            panel is mounted, so only it fetches data. */}
        <div className="space-y-4">
          <div
            role="tablist"
            aria-label={t('nav.projectSettings')}
            className="border-border flex overflow-x-auto border-b"
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
                  onClick={() => setActiveTab(tab.id)}
                  className={[
                    'relative shrink-0 border-b-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors',
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
            className="bg-card border-border rounded-2xl border p-6 shadow-sm"
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
              <p className="text-muted-foreground text-sm leading-relaxed">
                {activeConfig.placeholderKey !== undefined ? t(activeConfig.placeholderKey) : null}
              </p>
            )}
          </div>
        </div>
      </div>
    </RequireCapability>
  );
}
