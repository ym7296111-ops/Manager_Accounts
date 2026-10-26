import { ChevronDown, ChevronRight, Landmark } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  classifyClassificationsError,
  useActiveLeafClassifications,
} from '@/hooks/useClassifications';
import {
  classifyFiscalSettingsReadError,
  classifyFiscalSettingsWriteError,
  useDeleteOpeningBalance,
  useFiscalYears,
  useOpeningBalances,
  useSaveOpeningBalances,
  type FiscalSettingsWriteErrorCode,
  type OpeningBalanceWrite,
} from '@/hooks/useFiscalSettings';
import {
  classifyStationsError,
  useStationsDirectory,
  type StationWithWarehouses,
} from '@/hooks/useStationsDirectory';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import type { DeleteOpeningBalanceTarget } from './DeleteOpeningBalanceDialog';
import { FiscalBanner, FiscalLoading } from './FiscalSettingsFeedback';
import { OpeningBalancesWarehouse } from './OpeningBalancesWarehouse';
import { formatCents } from './fiscalSettingsUtils';
import { useOpeningBalanceDrafts } from './useOpeningBalanceDrafts';
import { useUnsavedChangesRegistration } from './unsavedChanges';

const READ_ERROR_KEYS: Record<
  ReturnType<typeof classifyFiscalSettingsReadError>,
  TranslationKey
> = {
  forbidden: 'settings.project.fiscal.error.forbidden',
  unavailable: 'settings.project.fiscal.error.unavailable',
  network: 'settings.project.fiscal.error.network',
  unknown: 'settings.project.fiscal.error.unknown',
};

const WRITE_ERROR_KEYS: Record<FiscalSettingsWriteErrorCode, TranslationKey> = {
  unavailable: 'settings.project.fiscal.writeError.unavailable',
  forbidden: 'settings.project.fiscal.writeError.forbidden',
  network: 'settings.project.fiscal.writeError.network',
  validation: 'settings.project.fiscal.writeError.validation',
  duplicate: 'settings.project.fiscal.writeError.duplicate',
  notFound: 'settings.project.fiscal.writeError.notFound',
  unknown: 'settings.project.fiscal.writeError.unknown',
};

const GUARD_KEY = 'opening-balances';

/**
 * «أرصدة أول المدة» — a sparse editor.
 *
 * What changed, and why (design study §3–§8):
 *
 * * the screen renders **entered lines only** — a saved balance, or one added in
 *   this session. The previous version mounted every active leaf in every
 *   warehouse, so an untouched project could still put a thousand inputs in the
 *   DOM;
 * * balances are read with their classification in the same response, so a row
 *   whose classification stopped being an active leaf (it gained children, or
 *   was deactivated) is detected exactly and shown in a read-only «needs
 *   review» block that still counts towards the totals;
 * * deleting is an explicit, confirmed action against the saved row, audited in
 *   the database; a line added in this session is just discarded;
 * * switching tabs with unsaved drafts asks first, and a reload warns through
 *   `beforeunload`.
 */
export default function OpeningBalancesSettings() {
  const { t, locale } = useI18n();
  const yearsQuery = useFiscalYears();
  const activeYear = yearsQuery.data?.find((year) => year.is_active) ?? null;
  const stationsQuery = useStationsDirectory({ enabled: activeYear !== null });
  const classificationsQuery = useActiveLeafClassifications({ enabled: activeYear !== null });
  const balancesQuery = useOpeningBalances(activeYear?.id ?? null);
  const saveBalances = useSaveOpeningBalances();
  const deleteBalance = useDeleteOpeningBalance();

  const [expandedStations, setExpandedStations] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedWarehouses, setExpandedWarehouses] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [savingWarehouseId, setSavingWarehouseId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    readonly tone: 'error' | 'success';
    readonly key: TranslationKey;
  } | null>(null);

  const activeLeafClassifications = useMemo(
    () => classificationsQuery.data ?? [],
    [classificationsQuery.data],
  );
  const drafts = useOpeningBalanceDrafts(
    balancesQuery.data ?? [],
    activeLeafClassifications,
    activeYear?.id ?? null,
  );

  /* A year switch invalidates every draft: they were typed against the previous
     year's balances, and carrying them over would write them to the wrong one. */
  const activeYearId = activeYear?.id ?? null;
  const { reset } = drafts;
  useEffect(() => {
    reset();
  }, [activeYearId, reset]);

  useUnsavedChangesRegistration(drafts.isDirty, GUARD_KEY);

  useEffect(() => {
    if (!drafts.isDirty) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [drafts.isDirty]);

  if (yearsQuery.isLoading) {
    return <FiscalLoading label={t('settings.project.fiscal.openingBalances.loadingYear')} />;
  }

  if (yearsQuery.isError) {
    return (
      <div
        role="alert"
        className="text-destructive border-destructive/25 bg-destructive/5 rounded-xl border p-4 text-sm"
      >
        {t(READ_ERROR_KEYS[classifyFiscalSettingsReadError(yearsQuery.error)])}
      </div>
    );
  }

  if (activeYear === null) {
    return (
      <EmptyState
        icon={Landmark}
        title={t('settings.project.fiscal.openingBalances.noActiveYear.title')}
        description={t('settings.project.fiscal.openingBalances.noActiveYear.description')}
      />
    );
  }

  const queryIsLoading =
    stationsQuery.isLoading || classificationsQuery.isLoading || balancesQuery.isLoading;
  if (queryIsLoading) {
    return <FiscalLoading label={t('settings.project.fiscal.openingBalances.loading')} />;
  }

  const readError = stationsQuery.isError
    ? classifyStationsError(stationsQuery.error)
    : classificationsQuery.isError
      ? classifyClassificationsError(classificationsQuery.error)
      : balancesQuery.isError
        ? classifyFiscalSettingsReadError(balancesQuery.error)
        : null;

  if (readError !== null) {
    const errorKey = READ_ERROR_KEYS[readError];
    const retry = () => {
      if (stationsQuery.isError) void stationsQuery.refetch();
      if (classificationsQuery.isError) void classificationsQuery.refetch();
      if (balancesQuery.isError) void balancesQuery.refetch();
    };
    return (
      <div className="space-y-4">
        <div
          role="alert"
          className="text-destructive border-destructive/25 bg-destructive/5 rounded-xl border p-4 text-sm"
        >
          {t(errorKey)}
        </div>
        <button
          type="button"
          onClick={retry}
          className="border-border text-foreground hover:bg-muted/50 inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold transition-colors"
        >
          {t('settings.project.fiscal.retry')}
        </button>
      </div>
    );
  }

  const stations = stationsQuery.data ?? [];

  const toggleStation = (id: string) => {
    setExpandedStations((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleWarehouse = (key: string) => {
    setExpandedWarehouses((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const stationTotal = (station: StationWithWarehouses): bigint =>
    station.warehouses.reduce(
      (total, warehouse) => total + drafts.modelFor(warehouse.id).totalCents,
      0n,
    );

  const handleSave = async (warehouseId: string) => {
    const model = drafts.modelFor(warehouseId);
    const rows: OpeningBalanceWrite[] = model.dirtyRows.filter((row) => row.amount !== '');
    if (rows.length === 0) {
      return;
    }
    setBanner(null);
    setSavingWarehouseId(warehouseId);
    try {
      await saveBalances.mutateAsync({ fiscalYearId: activeYear.id, rows });
      /* Only what reached the server is forgotten; lines added while the request
         was in flight are untouched. */
      drafts.clearSaved(rows);
      setBanner({ tone: 'success', key: 'settings.project.fiscal.openingBalances.success.saved' });
    } catch (error) {
      setBanner({
        tone: 'error',
        key: WRITE_ERROR_KEYS[classifyFiscalSettingsWriteError(error, 'saveOpeningBalances')],
      });
    } finally {
      setSavingWarehouseId(null);
    }
  };

  const handleDelete = async (target: DeleteOpeningBalanceTarget) => {
    setBanner(null);
    try {
      await deleteBalance.mutateAsync({
        fiscalYearId: activeYear.id,
        balanceId: target.balanceId,
      });
      setBanner({
        tone: 'success',
        key: 'settings.project.fiscal.openingBalances.success.deleted',
      });
    } catch (error) {
      const code = classifyFiscalSettingsWriteError(error, 'deleteOpeningBalance');
      if (code === 'notFound') {
        /* Already gone (another session), or filtered by RLS. Neither is an
           error the operator can act on — refresh and look again. */
        setBanner({
          tone: 'success',
          key: 'settings.project.fiscal.openingBalances.notice.alreadyDeleted',
        });
        void balancesQuery.refetch();
        return;
      }
      setBanner({ tone: 'error', key: WRITE_ERROR_KEYS[code] });
    }
  };

  return (
    <div className="w-full max-w-full min-w-0 space-y-4">
      {banner !== null ? (
        <FiscalBanner tone={banner.tone} onDismiss={() => setBanner(null)}>
          {t(banner.key)}
        </FiscalBanner>
      ) : null}

      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-foreground font-semibold">
            {t('settings.project.fiscal.openingBalances.heading')}
          </h3>
          <p className="text-muted-foreground text-sm">
            {t('settings.project.fiscal.openingBalances.activeYear', { name: activeYear.name })}
          </p>
        </div>
      </header>

      {stations.length > 0 ? (
        <div className="space-y-3">
          {stations.map((station) => {
            const stationOpen = expandedStations.has(station.id);
            const stationToggleId = `opening-station-toggle-${station.id}`;
            const stationPanelId = `opening-station-panel-${station.id}`;

            return (
              <section
                key={station.id}
                className="bg-card border-border w-full max-w-full min-w-0 overflow-hidden rounded-2xl border"
              >
                <button
                  type="button"
                  id={stationToggleId}
                  aria-expanded={stationOpen}
                  aria-controls={stationPanelId}
                  aria-label={t('settings.project.fiscal.openingBalances.toggleStation', {
                    name: station.name,
                  })}
                  onClick={() => toggleStation(station.id)}
                  className="hover:bg-muted/25 flex w-full min-w-0 flex-wrap items-start justify-between gap-3 px-3 py-3 text-start transition-colors sm:gap-4 sm:px-4 sm:py-4"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    {stationOpen ? (
                      <ChevronDown
                        className="text-muted-foreground size-4 shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronRight
                        className="text-muted-foreground size-4 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0">
                      <span className="text-foreground block font-semibold break-words">
                        {station.name}
                      </span>
                      <span className="text-muted-foreground block text-xs">{station.code}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-end">
                    <span className="text-muted-foreground block text-xs">
                      {t('settings.project.fiscal.openingBalances.stationTotal')}
                    </span>
                    <span className="text-foreground font-semibold tabular-nums">
                      {formatCents(stationTotal(station), locale)}
                    </span>
                  </span>
                </button>

                <div
                  id={stationPanelId}
                  role="region"
                  aria-labelledby={stationToggleId}
                  hidden={!stationOpen}
                  className="border-border border-t px-3 py-3 sm:px-4"
                >
                  {stationOpen ? (
                    station.warehouses.length > 0 ? (
                      <div className="space-y-3">
                        {station.warehouses.map((warehouse) => {
                          const warehouseKey = `${station.id}:${warehouse.id}`;
                          const model = drafts.modelFor(warehouse.id);
                          return (
                            <OpeningBalancesWarehouse
                              key={warehouse.id}
                              warehouse={warehouse}
                              model={model}
                              eligibleCount={activeLeafClassifications.length}
                              options={activeLeafClassifications}
                              open={expandedWarehouses.has(warehouseKey)}
                              onToggle={() => toggleWarehouse(warehouseKey)}
                              saving={savingWarehouseId === warehouse.id}
                              deleting={deleteBalance.isPending}
                              onAdd={(classificationIds) =>
                                drafts.addRows(warehouse.id, classificationIds)
                              }
                              onChangeAmount={(classificationId, text) =>
                                drafts.setAmount(warehouse.id, classificationId, text)
                              }
                              onDiscardAdded={(classificationId) =>
                                drafts.discardAdded(warehouse.id, classificationId)
                              }
                              onSave={() => void handleSave(warehouse.id)}
                              onDelete={handleDelete}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-muted-foreground py-3 text-sm">
                        {t('settings.project.fiscal.openingBalances.noWarehouses')}
                      </p>
                    )
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={Landmark}
          title={t('settings.project.fiscal.openingBalances.noStations.title')}
          description={t('settings.project.fiscal.openingBalances.noStations.description')}
        />
      )}
    </div>
  );
}
