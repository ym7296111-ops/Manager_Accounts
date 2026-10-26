import { ChevronDown, ChevronRight, Landmark, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  classifyFiscalSettingsReadError,
  classifyFiscalSettingsWriteError,
  useFiscalYears,
  useOpeningBalances,
  useSaveOpeningBalances,
  type FiscalSettingsWriteErrorCode,
  type OpeningBalance,
  type OpeningBalanceWrite,
} from '@/hooks/useFiscalSettings';
import { classifyClassificationsError, useClassifications } from '@/hooks/useClassifications';
import {
  classifyStationsError,
  useStationsDirectory,
  type StationWithWarehouses,
  type StationWarehouse,
} from '@/hooks/useStationsDirectory';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { FiscalBanner, FiscalLoading } from './FiscalSettingsFeedback';
import {
  amountToCents,
  flattenClassifications,
  formatCents,
  normalizeAmountText,
} from './fiscalSettingsUtils';

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

const OUTLINE_BUTTON_CLASS =
  'border-border text-foreground hover:bg-muted/50 inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

function balanceKey(fiscalYearId: string, warehouseId: string, classificationId: string): string {
  return `${fiscalYearId}:${warehouseId}:${classificationId}`;
}

function editableAmount(value: string | number): string {
  const cents = amountToCents(value);
  if (cents === null) {
    return String(value);
  }
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function originalBalance(
  balancesByKey: ReadonlyMap<string, OpeningBalance>,
  fiscalYearId: string,
  warehouseId: string,
  classificationId: string,
): OpeningBalance | undefined {
  return balancesByKey.get(balanceKey(fiscalYearId, warehouseId, classificationId));
}

function hasChanged(
  fiscalYearId: string,
  warehouseId: string,
  classificationId: string,
  drafts: Readonly<Record<string, string>>,
  balancesByKey: ReadonlyMap<string, OpeningBalance>,
): boolean {
  const key = balanceKey(fiscalYearId, warehouseId, classificationId);
  const draft = drafts[key];
  if (draft === undefined) {
    return false;
  }
  const existing = originalBalance(balancesByKey, fiscalYearId, warehouseId, classificationId);
  if (draft.trim() === '' && existing === undefined) {
    return false;
  }
  const newCents = draft.trim() === '' ? 0n : amountToCents(draft);
  if (newCents === null) {
    return true;
  }
  const oldCents = existing === undefined ? null : amountToCents(existing.amount);
  return oldCents === null || oldCents !== newCents;
}

function amountForTotal(
  fiscalYearId: string,
  warehouseId: string,
  classificationId: string,
  drafts: Readonly<Record<string, string>>,
  balancesByKey: ReadonlyMap<string, OpeningBalance>,
): bigint {
  const key = balanceKey(fiscalYearId, warehouseId, classificationId);
  const draft = drafts[key];
  const existing = originalBalance(balancesByKey, fiscalYearId, warehouseId, classificationId);
  if (draft !== undefined) {
    if (draft.trim() === '') {
      return 0n;
    }
    const draftCents = amountToCents(draft);
    if (draftCents !== null) {
      return draftCents;
    }
  }
  return existing === undefined ? 0n : (amountToCents(existing.amount) ?? 0n);
}

function warehouseTotal(
  fiscalYearId: string,
  warehouse: StationWarehouse,
  classifications: ReturnType<typeof flattenClassifications>,
  drafts: Readonly<Record<string, string>>,
  balancesByKey: ReadonlyMap<string, OpeningBalance>,
): bigint {
  return classifications.reduce(
    (total, entry) =>
      total + amountForTotal(fiscalYearId, warehouse.id, entry.node.id, drafts, balancesByKey),
    0n,
  );
}

function stationTotal(
  fiscalYearId: string,
  station: StationWithWarehouses,
  classifications: ReturnType<typeof flattenClassifications>,
  drafts: Readonly<Record<string, string>>,
  balancesByKey: ReadonlyMap<string, OpeningBalance>,
): bigint {
  return station.warehouses.reduce(
    (total, warehouse) =>
      total + warehouseTotal(fiscalYearId, warehouse, classifications, drafts, balancesByKey),
    0n,
  );
}

export default function OpeningBalancesSettings() {
  const { t, locale } = useI18n();
  const yearsQuery = useFiscalYears();
  const activeYear = yearsQuery.data?.find((year) => year.is_active) ?? null;
  const stationsQuery = useStationsDirectory({ enabled: activeYear !== null });
  const classificationsQuery = useClassifications({ enabled: activeYear !== null });
  const balancesQuery = useOpeningBalances(activeYear?.id ?? null);
  const saveBalances = useSaveOpeningBalances();
  const [expandedStations, setExpandedStations] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedWarehouses, setExpandedWarehouses] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [banner, setBanner] = useState<{
    readonly tone: 'error' | 'success';
    readonly key: TranslationKey;
  } | null>(null);

  const flatClassifications = useMemo(
    () => flattenClassifications(classificationsQuery.data ?? []),
    [classificationsQuery.data],
  );
  const balancesByKey = useMemo(() => {
    const result = new Map<string, OpeningBalance>();
    for (const balance of balancesQuery.data ?? []) {
      result.set(
        balanceKey(balance.fiscal_year_id, balance.warehouse_id, balance.classification_id),
        balance,
      );
    }
    return result;
  }, [balancesQuery.data]);

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
        <button type="button" onClick={retry} className={OUTLINE_BUTTON_CLASS}>
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

  const handleSaveWarehouse = async (warehouse: StationWarehouse) => {
    const changedClassifications = flatClassifications.filter((entry) =>
      hasChanged(activeYear.id, warehouse.id, entry.node.id, drafts, balancesByKey),
    );
    const rows: OpeningBalanceWrite[] = [];

    for (const entry of changedClassifications) {
      const key = balanceKey(activeYear.id, warehouse.id, entry.node.id);
      const raw = drafts[key] ?? '';
      const existing = originalBalance(balancesByKey, activeYear.id, warehouse.id, entry.node.id);
      if (raw.trim() === '' && existing === undefined) {
        continue;
      }
      const normalized = normalizeAmountText(raw.trim() === '' ? '0' : raw);
      if (normalized === null) {
        setBanner({ tone: 'error', key: 'settings.project.fiscal.writeError.validation' });
        return;
      }
      rows.push({
        fiscal_year_id: activeYear.id,
        warehouse_id: warehouse.id,
        classification_id: entry.node.id,
        amount: normalized,
      });
    }

    if (rows.length === 0) {
      return;
    }

    setBanner(null);
    try {
      await saveBalances.mutateAsync({ fiscalYearId: activeYear.id, rows });
      setDrafts((current) => {
        const next = { ...current };
        for (const row of rows) {
          delete next[balanceKey(row.fiscal_year_id, row.warehouse_id, row.classification_id)];
        }
        return next;
      });
      setBanner({ tone: 'success', key: 'settings.project.fiscal.openingBalances.success.saved' });
    } catch (error) {
      setBanner({
        tone: 'error',
        key: WRITE_ERROR_KEYS[classifyFiscalSettingsWriteError(error, 'saveOpeningBalances')],
      });
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
        <div className="bg-muted/30 text-muted-foreground max-w-full rounded-lg px-3 py-2 text-xs leading-relaxed">
          {t('settings.project.fiscal.openingBalances.totalHint')}
        </div>
      </header>

      {stations.length > 0 ? (
        <div className="space-y-3">
          {stations.map((station) => {
            const stationOpen = expandedStations.has(station.id);
            const stationToggleId = `opening-station-toggle-${station.id}`;
            const stationPanelId = `opening-station-panel-${station.id}`;
            const total = stationTotal(
              activeYear.id,
              station,
              flatClassifications,
              drafts,
              balancesByKey,
            );

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
                      {formatCents(total, locale)}
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
                  {station.warehouses.length > 0 ? (
                    <div className="space-y-3">
                      {station.warehouses.map((warehouse) => {
                        const warehouseKey = `${station.id}:${warehouse.id}`;
                        const warehouseOpen = expandedWarehouses.has(warehouseKey);
                        const warehouseToggleId = `opening-warehouse-toggle-${warehouse.id}`;
                        const warehousePanelId = `opening-warehouse-panel-${warehouse.id}`;
                        const warehouseBalanceTotal = warehouseTotal(
                          activeYear.id,
                          warehouse,
                          flatClassifications,
                          drafts,
                          balancesByKey,
                        );
                        const changedRows = flatClassifications.filter((entry) =>
                          hasChanged(
                            activeYear.id,
                            warehouse.id,
                            entry.node.id,
                            drafts,
                            balancesByKey,
                          ),
                        );
                        const invalidDraft = changedRows.some((entry) => {
                          const raw =
                            drafts[balanceKey(activeYear.id, warehouse.id, entry.node.id)] ?? '';
                          return raw.trim() !== '' && normalizeAmountText(raw) === null;
                        });

                        return (
                          <section
                            key={warehouse.id}
                            className="bg-background border-border w-full max-w-full min-w-0 rounded-xl border"
                          >
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 p-2.5 sm:p-3">
                              <button
                                type="button"
                                id={warehouseToggleId}
                                aria-expanded={warehouseOpen}
                                aria-controls={warehousePanelId}
                                aria-label={t(
                                  'settings.project.fiscal.openingBalances.toggleWarehouse',
                                  {
                                    name: warehouse.name,
                                  },
                                )}
                                onClick={() => toggleWarehouse(warehouseKey)}
                                className="focus-visible:ring-ring flex max-w-full min-w-0 flex-1 basis-full items-center justify-between gap-3 rounded-lg px-1.5 py-1 text-start focus-visible:ring-2 focus-visible:outline-none sm:basis-auto"
                              >
                                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                                  {warehouseOpen ? (
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
                                    <span className="text-foreground block text-sm font-semibold break-words">
                                      {warehouse.name}
                                    </span>
                                    <span className="text-muted-foreground block text-xs">
                                      {warehouse.code}
                                    </span>
                                  </span>
                                </span>
                                <span className="text-muted-foreground shrink-0 text-xs">
                                  {t('settings.project.fiscal.openingBalances.warehouseTotal')}{' '}
                                  <strong className="text-foreground tabular-nums">
                                    {formatCents(warehouseBalanceTotal, locale)}
                                  </strong>
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleSaveWarehouse(warehouse)}
                                disabled={
                                  saveBalances.isPending || changedRows.length === 0 || invalidDraft
                                }
                                aria-label={t(
                                  'settings.project.fiscal.openingBalances.saveWarehouse',
                                  {
                                    name: warehouse.name,
                                  },
                                )}
                                className={OUTLINE_BUTTON_CLASS}
                              >
                                <Save className="size-4" aria-hidden="true" />
                                {saveBalances.isPending
                                  ? t('settings.project.fiscal.openingBalances.saving')
                                  : t('settings.project.fiscal.openingBalances.save')}
                              </button>
                            </div>

                            <div
                              id={warehousePanelId}
                              role="region"
                              aria-labelledby={warehouseToggleId}
                              hidden={!warehouseOpen}
                              className="border-border border-t px-3 py-3 sm:px-4"
                            >
                              {flatClassifications.length > 0 ? (
                                <div className="space-y-2">
                                  {flatClassifications.map(({ node, depth, path }) => {
                                    const key = balanceKey(activeYear.id, warehouse.id, node.id);
                                    const existing = originalBalance(
                                      balancesByKey,
                                      activeYear.id,
                                      warehouse.id,
                                      node.id,
                                    );
                                    const inputValue =
                                      drafts[key] ??
                                      (existing === undefined
                                        ? ''
                                        : editableAmount(existing.amount));
                                    const isInvalid =
                                      inputValue.trim() !== '' &&
                                      normalizeAmountText(inputValue) === null;

                                    return (
                                      <div
                                        key={node.id}
                                        className="border-border/70 flex flex-wrap items-center justify-between gap-3 border-b py-2 last:border-b-0"
                                        style={{ paddingInlineStart: `${depth * 1.25}rem` }}
                                      >
                                        <div className="min-w-0 flex-1 basis-40">
                                          <p className="text-foreground text-sm font-medium">
                                            {node.name}
                                          </p>
                                          <p className="text-muted-foreground text-xs">
                                            {node.code}
                                          </p>
                                        </div>
                                        <label className="w-full max-w-56 min-w-0">
                                          <span className="sr-only">
                                            {t(
                                              'settings.project.fiscal.openingBalances.amountLabel',
                                              {
                                                path: path.join(' / '),
                                              },
                                            )}
                                          </span>
                                          <input
                                            type="number"
                                            min={0}
                                            max="9999999999999999.99"
                                            step="0.01"
                                            inputMode="decimal"
                                            value={inputValue}
                                            aria-label={t(
                                              'settings.project.fiscal.openingBalances.amountLabel',
                                              { path: path.join(' / ') },
                                            )}
                                            aria-invalid={isInvalid}
                                            onChange={(event) =>
                                              setDrafts((current) => ({
                                                ...current,
                                                [key]: event.target.value,
                                              }))
                                            }
                                            className="border-input bg-background text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/25 aria-invalid:border-destructive w-full rounded-lg border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
                                          />
                                        </label>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="text-muted-foreground py-3 text-sm">
                                  {t('settings.project.fiscal.openingBalances.noClassifications')}
                                </p>
                              )}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-muted-foreground py-3 text-sm">
                      {t('settings.project.fiscal.openingBalances.noWarehouses')}
                    </p>
                  )}
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
