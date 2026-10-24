import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { RequireCapability } from '@/components/auth/RequireAuth';
import { PROJECT_SETTINGS_CAPABILITY } from '@/components/layout/nav-items';
import { useI18n } from '@/i18n/I18nContext';
import type { TranslationKey } from '@/i18n/locales/ar';

/**
 * Project-settings shell (`/settings/project`) — UI shell only (tabs, no fields).
 *
 * The route keeps its own capability gate (`project.settings:manage`) and
 * exposes four tabs under the header. Each tab panel is a placeholder for
 * future fields — no queries/RPCs are issued (Phase 5 — UI Shell).
 */
type ProjectSettingsTab = 'stations' | 'classifications' | 'parties' | 'general';

interface ProjectSettingsTabConfig {
  id: ProjectSettingsTab;
  labelKey: TranslationKey;
  placeholderKey: TranslationKey;
}

const TABS: readonly ProjectSettingsTabConfig[] = [
  {
    id: 'stations',
    labelKey: 'settings.project.tabs.stations',
    placeholderKey: 'settings.project.tabs.stationsPlaceholder',
  },
  {
    id: 'classifications',
    labelKey: 'settings.project.tabs.classifications',
    placeholderKey: 'settings.project.tabs.classificationsPlaceholder',
  },
  {
    id: 'parties',
    labelKey: 'settings.project.tabs.parties',
    placeholderKey: 'settings.project.tabs.partiesPlaceholder',
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

        {/* Tabs — standard pattern, directly under the header, no data fetching */}
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
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t(activeConfig.placeholderKey)}
            </p>
          </div>
        </div>
      </div>
    </RequireCapability>
  );
}
