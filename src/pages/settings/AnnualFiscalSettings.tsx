import { CalendarDays, CalendarPlus, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, MODAL_FIELD_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import {
  classifyFiscalSettingsReadError,
  classifyFiscalSettingsWriteError,
  isValidFiscalYearRange,
  useActivateFiscalYear,
  useCreateFiscalYear,
  useFiscalMonths,
  useFiscalYears,
  type FiscalSettingsWriteErrorCode,
  type FiscalSettingsWriteOperation,
  type FiscalYear,
} from '@/hooks/useFiscalSettings';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { StatusIcon } from '@/components/ui/StatusIcon';
import { FiscalBanner, FiscalLoading } from './FiscalSettingsFeedback';
import {
  deriveFiscalYearName,
  formatFiscalDate,
  formatFiscalMonthName,
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

interface BannerState {
  readonly tone: 'error' | 'success';
  readonly key: TranslationKey;
}

const OUTLINE_BUTTON_CLASS =
  'border-border text-foreground hover:bg-muted/50 inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

function yearWriteErrorKey(
  error: unknown,
  operation: Extract<FiscalSettingsWriteOperation, 'createYear' | 'activateYear'>,
): TranslationKey {
  return WRITE_ERROR_KEYS[classifyFiscalSettingsWriteError(error, operation)];
}

function FiscalYearRow({
  year,
  onActivate,
  activating,
  expanded,
  onToggle,
}: {
  readonly year: FiscalYear;
  readonly onActivate: (year: FiscalYear) => void;
  readonly activating: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const { t, locale } = useI18n();
  const monthsQuery = useFiscalMonths(expanded ? year.id : null);
  const toggleId = `fiscal-year-toggle-${year.id}`;
  const panelId = `fiscal-year-months-${year.id}`;

  const monthsError = monthsQuery.isError
    ? READ_ERROR_KEYS[classifyFiscalSettingsReadError(monthsQuery.error)]
    : null;

  return (
    <>
      <tr className="border-border/70 border-t align-middle">
        <td className="px-3 py-3.5">
          <button
            type="button"
            id={toggleId}
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label={t('settings.project.fiscal.annual.toggleMonths', { name: year.name })}
            onClick={onToggle}
            className="focus-visible:ring-ring inline-flex items-center gap-2 rounded-md text-start font-semibold focus-visible:ring-2 focus-visible:outline-none"
          >
            {expanded ? (
              <ChevronDown className="text-muted-foreground size-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="text-muted-foreground size-4" aria-hidden="true" />
            )}
            <span>{year.name}</span>
          </button>
        </td>
        <td className="text-muted-foreground px-3 py-3.5 text-sm">
          {formatFiscalDate(year.start_date, locale)}
        </td>
        <td className="text-muted-foreground px-3 py-3.5 text-sm">
          {formatFiscalDate(year.end_date, locale)}
        </td>
        <td className="px-3 py-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <StatusIcon
                active={year.is_active}
                label={
                  year.is_active
                    ? t('settings.project.fiscal.annual.status.active')
                    : t('settings.project.fiscal.annual.status.inactive')
                }
              />
              <span>
                {year.is_active
                  ? t('settings.project.fiscal.annual.status.active')
                  : t('settings.project.fiscal.annual.status.inactive')}
              </span>
            </span>
            {year.is_closed ? (
              <span className="text-destructive">
                {t('settings.project.fiscal.annual.status.closed')}
              </span>
            ) : null}
          </div>
        </td>
        <td className="px-3 py-3.5 text-end">
          {year.is_active ? (
            <span className="text-success text-xs font-semibold">
              {t('settings.project.fiscal.annual.status.current')}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onActivate(year)}
              disabled={activating || year.is_closed}
              aria-label={t('settings.project.fiscal.annual.activateNamed', {
                name: year.name,
              })}
              className={`${OUTLINE_BUTTON_CLASS} px-3 py-1.5 text-xs`}
            >
              {t('settings.project.fiscal.annual.activate')}
            </button>
          )}
        </td>
      </tr>
      <tr className="border-border/70 border-t">
        <td colSpan={5} className="p-0">
          <div id={panelId} role="region" aria-labelledby={toggleId} hidden={!expanded}>
            {expanded ? (
              <div className="bg-muted/20 px-4 py-4 sm:px-6">
                {monthsQuery.isLoading ? (
                  <FiscalLoading label={t('settings.project.fiscal.annual.monthsLoading')} />
                ) : monthsError !== null ? (
                  <div
                    role="alert"
                    className="text-destructive flex flex-wrap items-center gap-3 py-3 text-sm"
                  >
                    <span>{t(monthsError)}</span>
                    <button
                      type="button"
                      onClick={() => void monthsQuery.refetch()}
                      className="underline underline-offset-4"
                    >
                      {t('settings.project.fiscal.retry')}
                    </button>
                  </div>
                ) : (
                  <>
                    <h3 className="text-foreground mb-3 text-sm font-semibold">
                      {t('settings.project.fiscal.annual.monthsCount', {
                        count: monthsQuery.data?.length ?? 0,
                      })}
                    </h3>
                    {monthsQuery.data?.length ? (
                      <ul className="divide-border divide-y rounded-xl border">
                        {monthsQuery.data.map((month) => (
                          <li
                            key={month.id}
                            data-testid="fiscal-month-row"
                            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2.5 text-sm"
                          >
                            <span className="font-medium">
                              {formatFiscalMonthName(month.start_date, locale)}
                            </span>
                            <span className="text-muted-foreground">
                              {formatFiscalDate(month.start_date, locale)} –{' '}
                              {formatFiscalDate(month.end_date, locale)}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {t('settings.project.fiscal.periods.periodLabel', {
                                period: month.current_period,
                              })}
                            </span>
                            {month.is_closed ? (
                              <span className="text-destructive text-xs">
                                {t('settings.project.fiscal.annual.status.closed')}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        {t('settings.project.fiscal.annual.monthsEmpty')}
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : null}
          </div>
        </td>
      </tr>
    </>
  );
}

function FiscalYearCard({
  year,
  onActivate,
  activating,
  expanded,
  onToggle,
}: {
  readonly year: FiscalYear;
  readonly onActivate: (year: FiscalYear) => void;
  readonly activating: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const { t, locale } = useI18n();
  const monthsQuery = useFiscalMonths(expanded ? year.id : null);
  const toggleId = `fiscal-year-mobile-toggle-${year.id}`;
  const panelId = `fiscal-year-mobile-months-${year.id}`;
  const statusLabel = year.is_active
    ? t('settings.project.fiscal.annual.status.active')
    : t('settings.project.fiscal.annual.status.inactive');
  const monthsError = monthsQuery.isError
    ? READ_ERROR_KEYS[classifyFiscalSettingsReadError(monthsQuery.error)]
    : null;

  return (
    <article className="bg-card border-border min-w-0 rounded-xl border p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <button
          type="button"
          id={toggleId}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={t('settings.project.fiscal.annual.toggleMonths', { name: year.name })}
          onClick={onToggle}
          className="focus-visible:ring-ring inline-flex min-w-0 flex-1 items-center gap-2 rounded-md text-start font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          {expanded ? (
            <ChevronDown className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 break-words">{year.name}</span>
        </button>
        {year.is_active ? (
          <span className="text-success shrink-0 text-xs font-semibold">
            {t('settings.project.fiscal.annual.status.current')}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onActivate(year)}
            disabled={activating || year.is_closed}
            aria-label={t('settings.project.fiscal.annual.activateNamed', { name: year.name })}
            className={`${OUTLINE_BUTTON_CLASS} px-3 py-1.5 text-xs`}
          >
            {t('settings.project.fiscal.annual.activate')}
          </button>
        )}
      </div>

      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-3 text-sm">
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs font-medium">
            {t('settings.project.fiscal.annual.column.start')}
          </dt>
          <dd className="mt-0.5 break-words">{formatFiscalDate(year.start_date, locale)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs font-medium">
            {t('settings.project.fiscal.annual.column.end')}
          </dt>
          <dd className="mt-0.5 break-words">{formatFiscalDate(year.end_date, locale)}</dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <StatusIcon active={year.is_active} label={statusLabel} />
          <span>{statusLabel}</span>
        </span>
        {year.is_closed ? (
          <span className="text-destructive">
            {t('settings.project.fiscal.annual.status.closed')}
          </span>
        ) : null}
      </div>

      <div
        id={panelId}
        role="region"
        aria-labelledby={toggleId}
        hidden={!expanded}
        className="border-border mt-3 border-t pt-3"
      >
        {expanded ? (
          monthsQuery.isLoading ? (
            <FiscalLoading label={t('settings.project.fiscal.annual.monthsLoading')} />
          ) : monthsError !== null ? (
            <div
              role="alert"
              className="text-destructive flex flex-wrap items-center gap-3 py-3 text-sm"
            >
              <span>{t(monthsError)}</span>
              <button
                type="button"
                onClick={() => void monthsQuery.refetch()}
                className="underline underline-offset-4"
              >
                {t('settings.project.fiscal.retry')}
              </button>
            </div>
          ) : (
            <>
              <h3 className="text-foreground mb-3 text-sm font-semibold">
                {t('settings.project.fiscal.annual.monthsCount', {
                  count: monthsQuery.data?.length ?? 0,
                })}
              </h3>
              {monthsQuery.data?.length ? (
                <ul className="divide-border divide-y rounded-xl border">
                  {monthsQuery.data.map((month) => (
                    <li
                      key={month.id}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2.5 text-sm"
                    >
                      <span className="min-w-0 font-medium break-words">
                        {formatFiscalMonthName(month.start_date, locale)}
                      </span>
                      <span className="text-muted-foreground break-words">
                        {formatFiscalDate(month.start_date, locale)} –{' '}
                        {formatFiscalDate(month.end_date, locale)}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {t('settings.project.fiscal.periods.periodLabel', {
                          period: month.current_period,
                        })}
                      </span>
                      {month.is_closed ? (
                        <span className="text-destructive text-xs">
                          {t('settings.project.fiscal.annual.status.closed')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t('settings.project.fiscal.annual.monthsEmpty')}
                </p>
              )}
            </>
          )
        ) : null}
      </div>
    </article>
  );
}

export default function AnnualFiscalSettings() {
  const { t } = useI18n();
  const yearsQuery = useFiscalYears();
  const createYear = useCreateFiscalYear();
  const activateYear = useActivateFiscalYear();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  const busy = createYear.isPending;
  const closeDialog = useCallback(() => {
    if (!busy) {
      setDialogOpen(false);
    }
  }, [busy]);
  useEscapeKey(closeDialog, dialogOpen);

  const dateRangeValid = isValidFiscalYearRange(startDate, endDate);
  const namePreview = dateRangeValid ? deriveFiscalYearName(startDate, endDate) : null;

  const submitCreateYear = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dateRangeValid) {
      setBanner({ tone: 'error', key: WRITE_ERROR_KEYS.validation });
      return;
    }

    setBanner(null);
    try {
      const year = await createYear.mutateAsync({ start_date: startDate, end_date: endDate });
      setExpandedIds((current) => new Set([...current, year.id]));
      setDialogOpen(false);
      setStartDate('');
      setEndDate('');
      setBanner({ tone: 'success', key: 'settings.project.fiscal.annual.success.created' });
    } catch (error) {
      setBanner({ tone: 'error', key: yearWriteErrorKey(error, 'createYear') });
    }
  };

  const handleActivate = async (year: FiscalYear) => {
    setBanner(null);
    try {
      await activateYear.mutateAsync(year.id);
      setBanner({ tone: 'success', key: 'settings.project.fiscal.annual.success.activated' });
    } catch (error) {
      setBanner({ tone: 'error', key: yearWriteErrorKey(error, 'activateYear') });
    }
  };

  if (yearsQuery.isLoading) {
    return <FiscalLoading label={t('settings.project.fiscal.annual.loading')} />;
  }

  if (yearsQuery.isError) {
    const errorKey = READ_ERROR_KEYS[classifyFiscalSettingsReadError(yearsQuery.error)];
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
          onClick={() => void yearsQuery.refetch()}
          className={OUTLINE_BUTTON_CLASS}
        >
          {t('settings.project.fiscal.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-full min-w-0 space-y-4">
      {banner !== null ? (
        <FiscalBanner tone={banner.tone} onDismiss={() => setBanner(null)}>
          {t(banner.key)}
        </FiscalBanner>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="text-foreground font-semibold">
            {t('settings.project.fiscal.annual.heading')}
          </h3>
          <p className="text-muted-foreground text-sm">
            {t('settings.project.fiscal.annual.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setBanner(null);
            setDialogOpen(true);
          }}
          className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold shadow-sm transition-opacity hover:opacity-90"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('settings.project.fiscal.annual.add')}
        </button>
      </div>

      {yearsQuery.data?.length ? (
        <>
          <div className="min-w-0 space-y-3 xl:hidden">
            {yearsQuery.data.map((year) => (
              <FiscalYearCard
                key={`mobile-${year.id}`}
                year={year}
                onActivate={(candidate) => void handleActivate(candidate)}
                activating={activateYear.isPending}
                expanded={expandedIds.has(year.id)}
                onToggle={() =>
                  setExpandedIds((current) => {
                    const next = new Set(current);
                    if (next.has(year.id)) {
                      next.delete(year.id);
                    } else {
                      next.add(year.id);
                    }
                    return next;
                  })
                }
              />
            ))}
          </div>
          <div className="hidden w-full max-w-full min-w-0 scrollbar-thin overflow-x-auto rounded-xl border xl:block">
            <table className="w-full min-w-[760px] border-collapse text-start">
              <thead className="bg-muted/40 text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    {t('settings.project.fiscal.annual.column.year')}
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    {t('settings.project.fiscal.annual.column.start')}
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    {t('settings.project.fiscal.annual.column.end')}
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold">
                    {t('settings.project.fiscal.annual.column.status')}
                  </th>
                  <th scope="col" className="px-3 py-3 text-end font-semibold">
                    {t('settings.project.fiscal.annual.column.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {yearsQuery.data.map((year) => (
                  <FiscalYearRow
                    key={year.id}
                    year={year}
                    onActivate={(candidate) => void handleActivate(candidate)}
                    activating={activateYear.isPending}
                    expanded={expandedIds.has(year.id)}
                    onToggle={() =>
                      setExpandedIds((current) => {
                        const next = new Set(current);
                        if (next.has(year.id)) {
                          next.delete(year.id);
                        } else {
                          next.add(year.id);
                        }
                        return next;
                      })
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <EmptyState
          icon={CalendarDays}
          title={t('settings.project.fiscal.annual.empty.title')}
          description={t('settings.project.fiscal.annual.empty.description')}
        />
      )}

      {dialogOpen ? (
        <ModalShell
          titleId="create-fiscal-year-title"
          title={t('settings.project.fiscal.annual.dialog.title')}
          closeLabel={t('settings.project.fiscal.annual.dialog.close')}
          onClose={closeDialog}
          busy={busy}
        >
          <form onSubmit={(event) => void submitCreateYear(event)} className="mt-5 space-y-4">
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t('settings.project.fiscal.annual.dialog.description')}
            </p>

            <div>
              <label
                htmlFor="fiscal-year-start-date"
                className="text-foreground text-sm font-medium"
              >
                {t('settings.project.fiscal.annual.dialog.startDate')}
              </label>
              <input
                id="fiscal-year-start-date"
                type="date"
                required
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className={MODAL_FIELD_CLASS}
              />
            </div>

            <div>
              <label htmlFor="fiscal-year-end-date" className="text-foreground text-sm font-medium">
                {t('settings.project.fiscal.annual.dialog.endDate')}
              </label>
              <input
                id="fiscal-year-end-date"
                type="date"
                required
                value={endDate}
                min={startDate || undefined}
                onChange={(event) => setEndDate(event.target.value)}
                className={MODAL_FIELD_CLASS}
              />
            </div>

            <div className="bg-muted/35 space-y-1 rounded-xl p-3.5 text-sm">
              <p className="text-foreground font-medium" aria-live="polite">
                {namePreview !== null
                  ? t('settings.project.fiscal.annual.dialog.namePreview', { name: namePreview })
                  : t('settings.project.fiscal.annual.dialog.namePending')}
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t('settings.project.fiscal.annual.dialog.monthsGenerated')}
              </p>
            </div>

            {startDate !== '' && endDate !== '' && !dateRangeValid ? (
              <p role="alert" className="text-destructive text-sm">
                {t('settings.project.fiscal.writeError.validation')}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={closeDialog}
                disabled={busy}
                className={`${MODAL_BUTTON_CLASS} text-muted-foreground hover:bg-muted/50`}
              >
                {t('settings.project.fiscal.annual.dialog.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy || namePreview === null}
                className={`${MODAL_BUTTON_CLASS} bg-primary text-primary-foreground`}
              >
                <CalendarPlus className="size-4" aria-hidden="true" />
                {busy
                  ? t('settings.project.fiscal.annual.dialog.saving')
                  : t('settings.project.fiscal.annual.dialog.save')}
              </button>
            </div>
          </form>
        </ModalShell>
      ) : null}
    </div>
  );
}
