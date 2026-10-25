import { ArrowDownToLine, ArrowUpFromLine, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import PartiesDirectory from '@/pages/settings/PartiesDirectory';

/**
 * Parties — «جهات الوارد والمنصرف» — split by the direction of the relationship
 * into the two flat groups the company actually works with:
 *
 *   inbound   green   ArrowDownToLine   local suppliers + foreign suppliers
 *   outbound  orange  ArrowUpFromLine   customers (no local/foreign split)
 *
 * Each group is a sub-tab of its own, with its own icon and colour, and only
 * the open sub-tab is mounted — so switching costs no background queries and
 * the two tables keep separate caches.
 *
 * Sister companies deliberately do NOT live here: that screen is a two-level
 * parent → branch tree with its own purpose (intercompany transfers), while
 * these two are flat lists. It is a top-level tab of Project Settings.
 *
 * The split is also a write rule, not decoration: the create dialog in the
 * inbound tab offers `local_supplier` / `foreign_supplier` only, and the
 * outbound tab creates `customer` only. `validatePartyForm` re-checks that
 * against the tab's allowed set before any request leaves the client, so a
 * tampered form cannot mint a code from the other tab's sequence.
 *
 * There is no `internal` party anywhere: the type was retired in
 * 20261108000000, and the UI carries no trace of it.
 */

export type PartiesSubTab = 'inbound' | 'outbound';

interface SubTabConfig {
  readonly id: PartiesSubTab;
  readonly labelKey: TranslationKey;
  readonly icon: LucideIcon;
  /** Active pill: the group's colour, never the only cue (icon + label too). */
  readonly activeClass: string;
  /** The icon keeps its colour even while the tab is closed. */
  readonly iconClass: string;
}

const SUB_TABS: readonly SubTabConfig[] = [
  {
    id: 'inbound',
    labelKey: 'settings.project.parties.tabs.inbound',
    icon: ArrowDownToLine,
    activeClass: 'border-success/50 bg-success/10 text-success',
    iconClass: 'text-success',
  },
  {
    id: 'outbound',
    labelKey: 'settings.project.parties.tabs.outbound',
    icon: ArrowUpFromLine,
    activeClass: 'border-orange-500/50 bg-orange-500/10 text-orange-600 dark:text-orange-400',
    iconClass: 'text-orange-600 dark:text-orange-400',
  },
];

export default function Parties() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<PartiesSubTab>('inbound');

  const activeConfig = SUB_TABS.find((tab) => tab.id === activeTab) ?? SUB_TABS[0]!;

  return (
    <section aria-labelledby="parties-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="parties-heading" className="text-foreground text-sm font-semibold">
          {t('settings.project.parties.heading')}
        </h2>
        <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">
          {t('settings.project.parties.description')}
        </p>
      </div>

      <div
        role="tablist"
        aria-label={t('settings.project.parties.heading')}
        className="flex flex-wrap gap-2"
      >
        {SUB_TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`parties-subtab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`parties-subtabpanel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-semibold transition-colors',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
                isActive
                  ? tab.activeClass
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted/40',
              ].join(' ')}
            >
              <Icon
                className={`size-4 shrink-0 ${isActive ? '' : tab.iconClass}`}
                aria-hidden="true"
              />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`parties-subtabpanel-${activeConfig.id}`}
        aria-labelledby={`parties-subtab-${activeConfig.id}`}
      >
        <PartiesDirectory scope={activeConfig.id} />
      </div>
    </section>
  );
}
