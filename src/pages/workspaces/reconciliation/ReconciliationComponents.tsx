import { ModalShell } from '@/components/ui/ModalShell';
import { useI18n } from '@/i18n/I18nContext';
import {
  formatReconciliationAmount,
  type MonthOption,
  type MonthSummary,
  type ReconciliationLine,
  type StationOption,
} from '@/lib/apsReconciliation';

const button =
  'rounded-lg border border-border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 hover:bg-muted';
export interface Draft {
  value: string;
  baseline: string;
  error?: string;
}

export function ReconciliationStatus({ message, retry }: { message: string; retry?: () => void }) {
  const { t } = useI18n();
  return (
    <div role="status" className="border-border bg-card rounded-xl border p-4 text-sm">
      {message}
      {retry && (
        <button type="button" className={`${button} ms-3`} onClick={retry}>
          {t('aps.recon.retry')}
        </button>
      )}
    </div>
  );
}
export function ReconciliationHeader({
  months,
  stations,
  monthId,
  stationId,
  onMonthChange,
  onStationChange,
  disabled,
}: {
  months: MonthOption[];
  stations: StationOption[];
  monthId: string;
  stationId: string;
  onMonthChange: (id: string) => void;
  onStationChange: (id: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-semibold">
        {t('aps.recon.month')}
        <select
          value={monthId}
          disabled={disabled}
          onChange={(e) => onMonthChange(e.target.value)}
          className="bg-card border-border rounded-lg border p-2"
        >
          <option value="">{t('aps.recon.chooseMonth')}</option>
          {months.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.is_active ? ` — ${t('aps.recon.active')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-semibold">
        {t('aps.recon.station')}
        <select
          value={stationId}
          disabled={disabled}
          onChange={(e) => onStationChange(e.target.value)}
          className="bg-card border-border rounded-lg border p-2"
        >
          <option value="">{t('aps.recon.chooseStation')}</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
export function ReconciliationSummary({
  summary,
  fiscalClosed,
  onStation,
}: {
  summary: MonthSummary;
  fiscalClosed: boolean;
  onStation: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <section
      aria-labelledby="recon-summary"
      className="border-border bg-card space-y-3 rounded-xl border p-4"
    >
      <h2 id="recon-summary" className="font-bold">
        {t('aps.recon.summary')}
      </h2>
      <p className="text-sm">
        {t(fiscalClosed ? 'aps.recon.fiscalClosed' : 'aps.recon.fiscalOpen')}
      </p>
      <div className="grid gap-2 text-sm sm:grid-cols-3">
        <span>{t('aps.recon.openSessions', { count: summary.open_sessions_count })}</span>
        <span>
          {t('aps.recon.eligibleSessions', { count: summary.eligible_open_screen_sessions })}
        </span>
        <span>
          {t('aps.recon.eligibleStations', { count: summary.eligible_open_stations_count })}
        </span>
      </div>
      {summary.stations_with_nonzero_difference.length ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
            {t('aps.recon.unbalanced')}
          </p>
          <ul className="space-y-2">
            {summary.stations_with_nonzero_difference.map((s) => (
              <li key={s.station_id} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="break-words">{s.station_name}</span>
                <span dir="ltr">{formatReconciliationAmount(s.total_difference, locale)}</span>
                <button type="button" className={button} onClick={() => onStation(s.station_id)}>
                  {t('aps.recon.details')}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">{t('aps.recon.netWarning')}</p>
        </div>
      ) : (
        <p className="text-sm">{t('aps.recon.noDifferences')}</p>
      )}
      <p className="text-sm">
        {t('aps.recon.closedSessions', { count: summary.eligible_closed_screen_sessions })} ·{' '}
        {t('aps.recon.totalStations', { count: summary.total_stations_with_sessions })}
      </p>
      <p className="text-sm font-semibold">
        {t('aps.recon.total')}{' '}
        <span dir="ltr" className="inline-block">
          {formatReconciliationAmount(summary.total_month_difference, locale)}
        </span>
      </p>
    </section>
  );
}
export function ReconciliationActions({
  canOpen,
  canClose,
  showReopen,
  canReopen,
  busy,
  onOpen,
  onClose,
  onReopen,
}: {
  canOpen: boolean;
  canClose: boolean;
  showReopen: boolean;
  canReopen: boolean;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onReopen: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={!canOpen || busy} onClick={onOpen}>
        {t('aps.recon.open')}
      </button>
      <button type="button" className={button} disabled={!canClose || busy} onClick={onClose}>
        {t('aps.recon.closeMonth')}
      </button>
      {showReopen && (
        <button type="button" className={button} disabled={!canReopen || busy} onClick={onReopen}>
          {t('aps.recon.reopen')}
        </button>
      )}
    </div>
  );
}
export function ReconciliationRow({
  line,
  draft,
  readOnly,
  busy,
  onChange,
  onSave,
  onDiscard,
}: {
  line: ReconciliationLine;
  draft?: Draft;
  readOnly: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { t, locale } = useI18n();
  const conflict = !!draft && draft.baseline !== line.accountant_amount;
  return (
    <tr className="border-border border-t align-top">
      <th scope="row" className="max-w-72 p-3 text-start font-medium break-words whitespace-normal">
        {line.classification_name}
      </th>
      <td className="p-3">
        <span dir="ltr" className="inline-block">
          {formatReconciliationAmount(line.book_amount, locale)}
        </span>
      </td>
      <td className="p-3">
        {readOnly ? (
          <span dir="ltr" className="inline-block">
            {formatReconciliationAmount(line.accountant_amount, locale)}
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label={t('aps.recon.amountFor', { name: line.classification_name })}
              inputMode="decimal"
              maxLength={50}
              dir="ltr"
              value={draft?.value ?? line.accountant_amount}
              disabled={busy}
              onChange={(e) => onChange(e.target.value)}
              className="bg-background border-border w-36 rounded-md border p-2"
            />
            <button
              type="button"
              aria-label={t('aps.recon.saveFor', { name: line.classification_name })}
              className={button}
              onClick={onSave}
              disabled={!draft || conflict || busy}
            >
              {t('aps.recon.save')}
            </button>
          </div>
        )}
        {readOnly && draft && (
          <p className="mt-1 text-sm">
            {t('aps.recon.unsavedValue')} <span dir="ltr">{draft.value}</span>
          </p>
        )}
        {draft?.error && (
          <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">
            {draft.error}
          </p>
        )}
        {conflict && (
          <div role="alert" className="mt-1 text-sm">
            <p>{t('aps.recon.conflict')}</p>
            <button type="button" className={button} onClick={onDiscard} disabled={busy}>
              {t('aps.recon.useSaved')}
            </button>
          </div>
        )}
      </td>
      <td className="p-3">
        <span dir="ltr" className="inline-block">
          {formatReconciliationAmount(line.difference, locale)}
        </span>
        {draft && (
          <p className="text-muted-foreground mt-1 text-xs">{t('aps.recon.previousDifference')}</p>
        )}
      </td>
      <td className="p-3 text-sm">
        {readOnly ? t('aps.recon.readOnly') : draft ? t('aps.recon.unsaved') : t('aps.recon.saved')}
      </td>
    </tr>
  );
}
export function ReconciliationTable({
  lines,
  drafts,
  readOnly,
  busy,
  hasMore,
  loadingMore,
  onChange,
  onSave,
  onDiscard,
  onMore,
}: {
  lines: ReconciliationLine[];
  drafts: Record<string, Draft>;
  readOnly: boolean;
  busy: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onChange: (line: ReconciliationLine, value: string) => void;
  onSave: (line: ReconciliationLine) => void;
  onDiscard: (id: string) => void;
  onMore: () => void;
}) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t('aps.recon.table')}
      className="border-border bg-card overflow-hidden rounded-xl border"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px] text-sm">
          <thead>
            <tr className="text-start">
              <th className="p-3 text-start">{t('aps.recon.classification')}</th>
              <th className="p-3 text-start">{t('aps.recon.book')}</th>
              <th className="p-3 text-start">{t('aps.recon.accountant')}</th>
              <th className="p-3 text-start">{t('aps.recon.difference')}</th>
              <th className="p-3 text-start">{t('aps.recon.rowStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <ReconciliationRow
                key={line.id}
                line={line}
                draft={drafts[line.id]}
                readOnly={readOnly}
                busy={busy}
                onChange={(value) => onChange(line, value)}
                onSave={() => onSave(line)}
                onDiscard={() => onDiscard(line.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {!lines.length && <p className="p-4 text-sm">{t('aps.recon.noLines')}</p>}
      {hasMore && (
        <div className="p-3">
          <button type="button" className={button} disabled={busy || loadingMore} onClick={onMore}>
            {t(loadingMore ? 'aps.recon.loading' : 'aps.recon.more')}
          </button>
        </div>
      )}
    </section>
  );
}
export function ReasonDialog({
  operation,
  reason,
  busy,
  canConfirm,
  error,
  summary,
  onChange,
  onConfirm,
  onCancel,
}: {
  operation: 'close' | 'reopen';
  reason: string;
  busy: boolean;
  canConfirm: boolean;
  error: string | null;
  summary: MonthSummary;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const valid = Array.from(reason.trim()).length >= 3 && Array.from(reason.trim()).length <= 500;
  return (
    <ModalShell
      titleId="reconciliation-reason-title"
      title={t(operation === 'close' ? 'aps.recon.closeTitle' : 'aps.recon.reopenTitle')}
      closeLabel={t('aps.recon.cancel')}
      onClose={onCancel}
      busy={busy}
    >
      <div className="mt-4 space-y-4 text-sm">
        <p>{t(operation === 'close' ? 'aps.recon.closeScope' : 'aps.recon.reopenScope')}</p>
        {operation === 'close' && (
          <p>
            {t('aps.recon.closeCounts', {
              sessions: summary.eligible_open_screen_sessions,
              stations: summary.eligible_open_stations_count,
            })}
          </p>
        )}
        <label className="grid gap-1 font-semibold">
          {t('aps.recon.reason')}
          <textarea
            autoFocus
            value={reason}
            maxLength={500}
            disabled={busy}
            onChange={(e) => onChange(e.target.value)}
            className="border-border bg-background min-h-24 rounded-lg border p-2"
          />
        </label>
        <p className="text-muted-foreground">{t('aps.recon.reasonHint')}</p>
        {error && (
          <p role="alert" className="text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" className={button} onClick={onCancel} disabled={busy}>
            {t('aps.recon.cancel')}
          </button>
          <button
            type="button"
            className={button}
            onClick={onConfirm}
            disabled={busy || !valid || !canConfirm}
          >
            {t('aps.recon.confirm')}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
