import { CalendarRange, Clock3, Landmark } from 'lucide-react';
import { useState } from 'react';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import AnnualFiscalSettings from './AnnualFiscalSettings';
import FiscalPeriodsSettings from './FiscalPeriodsSettings';
import OpeningBalancesSettings from './OpeningBalancesSettings';
import { useUnsavedChanges } from './unsavedChanges';

type FiscalTab = 'annual' | 'periods' | 'openingBalances';

interface FiscalTabConfig {
  readonly id: FiscalTab;
  readonly labelKey: TranslationKey;
  readonly Icon: typeof CalendarRange;
}

const TABS: readonly FiscalTabConfig[] = [
  {
    id: 'annual',
    labelKey: 'settings.project.fiscal.tabs.annual',
    Icon: CalendarRange,
  },
  {
    id: 'periods',
    labelKey: 'settings.project.fiscal.tabs.periods',
    Icon: Clock3,
  },
  {
    id: 'openingBalances',
    labelKey: 'settings.project.fiscal.tabs.openingBalances',
    Icon: Landmark,
  },
];

export default function FiscalSettings() {
  const { t } = useI18n();
  const { confirmNavigation } = useUnsavedChanges();
  const [activeTab, setActiveTab] = useState<FiscalTab>('annual');
  const activeConfig = TABS.find((tab) => tab.id === activeTab) ?? TABS[0]!;

  return (
    <section
      aria-labelledby="fiscal-settings-heading"
      className="w-full max-w-full min-w-0 space-y-5"
    >
      <header className="min-w-0 space-y-1">
        <h2 id="fiscal-settings-heading" className="text-foreground text-lg font-semibold">
          {t('settings.project.fiscal.heading')}
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t('settings.project.fiscal.description')}
        </p>
      </header>

      <div className="w-full max-w-full min-w-0 space-y-5">
        <div
          role="tablist"
          aria-label={t('settings.project.fiscal.tablist')}
          className="border-border flex max-w-full min-w-0 flex-wrap gap-x-1 border-b"
        >
          {TABS.map(({ id, labelKey, Icon }) => {
            const selected = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`fiscal-settings-tab-${id}`}
                aria-selected={selected}
                aria-controls={`fiscal-settings-tabpanel-${id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => confirmNavigation(() => setActiveTab(id))}
                className={[
                  'relative inline-flex max-w-full min-w-0 items-center gap-2 border-b-2 px-3 py-3 text-start text-sm font-medium transition-colors sm:px-4',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
                  selected
                    ? 'border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent',
                ].join(' ')}
              >
                <Icon className="size-4" aria-hidden="true" />
                {t(labelKey)}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`fiscal-settings-tabpanel-${activeConfig.id}`}
          aria-labelledby={`fiscal-settings-tab-${activeConfig.id}`}
          className="w-full max-w-full min-w-0"
        >
          {activeTab === 'annual' ? (
            <AnnualFiscalSettings />
          ) : activeTab === 'periods' ? (
            <FiscalPeriodsSettings />
          ) : (
            <OpeningBalancesSettings />
          )}
        </div>
      </div>
    </section>
  );
}
