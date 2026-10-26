import { CalendarRange, Minus, Plus, Save } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  classifyFiscalSettingsReadError,
  classifyFiscalSettingsWriteError,
  useFiscalMonths,
  useFiscalYears,
  useUpdateFiscalPeriod,
  type FiscalSettingsWriteErrorCode,
  type FiscalMonth,
} from '@/hooks/useFiscalSettings';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { FiscalBanner, FiscalLoading } from './FiscalSettingsFeedback';
import { formatFiscalDate, formatFiscalMonthName } from './fiscalSettingsUtils';

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

const BUTTON_CLASS =
  'border-border text-foreground hover:bg-muted/50 inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

export default function FiscalPeriodsSettings() {
  const { t, locale } = useI18n();
  const yearsQuery = useFiscalYears();
  const activeYear = yearsQuery.data?.find((year) => year.is_active) ?? null;
  const monthsQuery = useFiscalMonths(activeYear?.id ?? null);
  const updatePeriod = useUpdateFiscalPeriod();
  const [selectedMonthId, setSelectedMonthId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [banner, setBanner] = useState<{
    readonly tone: 'error' | 'success';
    readonly key: TranslationKey;
  } | null>(null);

  const months = monthsQuery.data ?? [];
  const selectedMonth: FiscalMonth | null =
    months.find((month) => month.id === selectedMonthId) ?? months[0] ?? null;

  if (yearsQuery.isLoading) {
    return <FiscalLoading label={t('settings.project.fiscal.periods.loadingYear')} />;
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
        icon={CalendarRange}
        title={t('settings.project.fiscal.periods.noActiveYear.title')}
        description={t('settings.project.fiscal.periods.noActiveYear.description')}
      />
    );
  }

  if (monthsQuery.isLoading) {
    return <FiscalLoading label={t('settings.project.fiscal.periods.loadingMonths')} />;
  }

  if (monthsQuery.isError) {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          className="text-destructive border-destructive/25 bg-destructive/5 rounded-xl border p-4 text-sm"
        >
          {t(READ_ERROR_KEYS[classifyFiscalSettingsReadError(monthsQuery.error)])}
        </div>
        <button type="button" onClick={() => void monthsQuery.refetch()} className={BUTTON_CLASS}>
          {t('settings.project.fiscal.retry')}
        </button>
      </div>
    );
  }

  if (selectedMonth === null) {
    return (
      <EmptyState
        icon={CalendarRange}
        title={t('settings.project.fiscal.periods.noMonths.title')}
        description={t('settings.project.fiscal.periods.noMonths.description')}
      />
    );
  }

  const selectedMonthName = formatFiscalMonthName(selectedMonth.start_date, locale);
  const currentDraft = drafts[selectedMonth.id];
  const inputValue = currentDraft ?? String(selectedMonth.current_period);
  const parsedPeriod = /^\d+$/.test(inputValue) ? Number(inputValue) : Number.NaN;
  const validPeriod = Number.isSafeInteger(parsedPeriod) && parsedPeriod >= 1;
  const isDirty = currentDraft !== undefined && parsedPeriod !== selectedMonth.current_period;
  const canEdit = !activeYear.is_closed && !selectedMonth.is_closed;
  const displayPeriod = validPeriod ? parsedPeriod : selectedMonth.current_period;

  const savePeriod = async () => {
    if (!validPeriod || !isDirty || !canEdit) {
      return;
    }
    setBanner(null);
    try {
      await updatePeriod.mutateAsync({
        fiscalYearId: activeYear.id,
        monthId: selectedMonth.id,
        currentPeriod: parsedPeriod,
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[selectedMonth.id];
        return next;
      });
      setBanner({ tone: 'success', key: 'settings.project.fiscal.periods.success.saved' });
    } catch (error) {
      setBanner({
        tone: 'error',
        key: WRITE_ERROR_KEYS[classifyFiscalSettingsWriteError(error, 'updatePeriod')],
      });
    }
  };

  const changeBy = (delta: -1 | 1) => {
    const base = validPeriod ? parsedPeriod : selectedMonth.current_period;
    setDrafts((current) => ({
      ...current,
      [selectedMonth.id]: String(Math.max(1, base + delta)),
    }));
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
            {t('settings.project.fiscal.periods.heading')}
          </h3>
          <p className="text-muted-foreground text-sm">
            {t('settings.project.fiscal.periods.activeYear', { name: activeYear.name })}
          </p>
        </div>
        {activeYear.is_closed ? (
          <span className="text-destructive bg-destructive/10 rounded-full px-3 py-1 text-xs font-semibold">
            {t('settings.project.fiscal.annual.status.closed')}
          </span>
        ) : null}
      </header>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.2fr)]">
        <nav
          aria-label={t('settings.project.fiscal.periods.monthList')}
          className="grid min-w-0 content-start gap-2 sm:grid-cols-2 lg:grid-cols-1"
        >
          {months.map((month) => {
            const selected = month.id === selectedMonth.id;
            return (
              <button
                key={month.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setSelectedMonthId(month.id);
                  setBanner(null);
                }}
                className={[
                  'border-border flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-start transition-colors',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                  selected ? 'border-primary/50 bg-primary/5' : 'bg-card hover:bg-muted/35',
                ].join(' ')}
              >
                <span className="min-w-0">
                  <span className="text-foreground block truncate text-sm font-semibold">
                    {formatFiscalMonthName(month.start_date, locale)}
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    {formatFiscalDate(month.start_date, locale)} –{' '}
                    {formatFiscalDate(month.end_date, locale)}
                  </span>
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {t('settings.project.fiscal.periods.periodLabel', {
                    period: month.current_period,
                  })}
                </span>
              </button>
            );
          })}
        </nav>

        <section
          aria-labelledby="selected-fiscal-month-heading"
          className="bg-card border-border min-w-0 rounded-2xl border p-4 sm:p-5"
        >
          <div className="space-y-1">
            <h4
              id="selected-fiscal-month-heading"
              className="text-foreground text-base font-semibold"
            >
              {selectedMonthName}
            </h4>
            <p className="text-muted-foreground text-sm">
              {formatFiscalDate(selectedMonth.start_date, locale)} –{' '}
              {formatFiscalDate(selectedMonth.end_date, locale)}
            </p>
          </div>

          <p
            aria-live="polite"
            className="bg-primary/5 text-foreground border-primary/15 mt-5 rounded-xl border px-4 py-3 text-sm font-semibold"
          >
            {t('settings.project.fiscal.periods.nowInPeriod', {
              period: selectedMonth.current_period,
              month: selectedMonthName,
            })}
          </p>

          <div className="mt-5 flex flex-wrap items-end gap-3">
            <div className="min-w-36 flex-1">
              <label
                htmlFor="current-fiscal-period"
                className="text-foreground text-sm font-medium"
              >
                {t('settings.project.fiscal.periods.currentPeriod')}
              </label>
              <input
                id="current-fiscal-period"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={inputValue}
                disabled={!canEdit || updatePeriod.isPending}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [selectedMonth.id]: event.target.value }))
                }
                className="border-input bg-background text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/25 mt-1 w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={t('settings.project.fiscal.periods.decrement')}
                onClick={() => changeBy(-1)}
                disabled={!canEdit || updatePeriod.isPending || displayPeriod <= 1}
                className="border-border hover:bg-muted/50 grid size-10 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Minus className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={t('settings.project.fiscal.periods.increment')}
                onClick={() => changeBy(1)}
                disabled={!canEdit || updatePeriod.isPending}
                className="border-border hover:bg-muted/50 grid size-10 place-items-center rounded-lg border disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="size-4" aria-hidden="true" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => void savePeriod()}
              disabled={!canEdit || !validPeriod || !isDirty || updatePeriod.isPending}
              className="bg-primary text-primary-foreground inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Save className="size-4" aria-hidden="true" />
              {updatePeriod.isPending
                ? t('settings.project.fiscal.periods.saving')
                : t('settings.project.fiscal.periods.save')}
            </button>
          </div>

          {!canEdit ? (
            <p className="text-muted-foreground mt-3 text-xs">
              {t('settings.project.fiscal.periods.closedHint')}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
