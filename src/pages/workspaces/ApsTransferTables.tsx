import { ArrowDownLeft, ArrowUpRight, Plus, Scale, Trash2 } from 'lucide-react';
import { SearchCombobox, type SearchComboboxOption } from '@/components/ui/SearchCombobox';
import { useI18n } from '@/i18n/I18nContext';
import {
  entryTransferTotals,
  newEntryLine,
  type EntryDirection,
  type EntryLine,
  type EntryOption,
} from '@/lib/apsLetterEntry';
import { formatLetterAmount } from '@/lib/apsLetters';

const CELL_CONTROL =
  'border-input bg-card text-foreground focus:border-primary/60 focus:ring-primary/25 min-h-11 w-full min-w-0 rounded-lg border px-2 text-sm outline-none focus:ring-2 disabled:opacity-60';
const AMOUNT_CONTROL = `${CELL_CONTROL} text-center tabular-nums`;

/**
 * The internal transfer screen: two facing tables over one free-line list.
 *
 * The transfer is stored as independent lines — `out` rows (the source table)
 * and `in` rows (the destination table) — with no pairing column and no
 * many-to-one relationship the clerk has to maintain. Both tables therefore
 * edit the same `lines` array; only the filter differs, which is why a row
 * added to the left table cannot silently renumber the right one.
 *
 * The meter is a statement, not a gate: an unbalanced draft is saved (the
 * database allows it) and refused only at approval, so the meter turns red and
 * says so without blocking the write.
 */
export function ApsTransferTables({
  lines,
  warehouses,
  classifications,
  maxLines,
  highlightedKey,
  onLinesChange,
}: {
  readonly lines: readonly EntryLine[];
  /** Warehouses already shaped for the picker, label and station included. */
  readonly warehouses: readonly SearchComboboxOption[];
  readonly classifications: readonly EntryOption[];
  readonly maxLines: number;
  /** The row a validation error points at, or null. */
  readonly highlightedKey: string | null;
  readonly onLinesChange: (lines: readonly EntryLine[]) => void;
}) {
  const { t, locale } = useI18n();
  const totals = entryTransferTotals(lines);
  const add = (direction: EntryDirection) =>
    onLinesChange([...lines, newEntryLine('', '', direction)]);
  const remove = (key: string) => onLinesChange(lines.filter((line) => line.key !== key));
  const patch = (key: string, change: Partial<EntryLine>) =>
    onLinesChange(lines.map((line) => (line.key === key ? { ...line, ...change } : line)));
  const full = lines.length >= maxLines;

  const table = (direction: EntryDirection) => {
    const side = lines.filter((line) => (line.direction ?? 'out') === direction);
    const source = direction === 'out';
    const title = t(
      source ? 'aps.entry.transfer.sourceTitle' : 'aps.entry.transfer.destinationTitle',
    );
    const hint = t(source ? 'aps.entry.transfer.sourceHint' : 'aps.entry.transfer.destinationHint');
    const tone = source
      ? 'border-orange-300/70 bg-orange-500/5'
      : 'border-emerald-300/70 bg-emerald-500/5';
    return (
      <section
        aria-label={title}
        data-transfer-side={direction}
        className={`min-w-0 rounded-2xl border p-3 sm:p-4 ${tone}`}
      >
        <header className="flex min-w-0 items-start gap-2">
          {source ? (
            <ArrowUpRight
              className="mt-0.5 size-4 shrink-0 text-orange-700 dark:text-orange-300"
              aria-hidden="true"
            />
          ) : (
            <ArrowDownLeft
              className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <h4 className="text-foreground text-sm font-bold">{title}</h4>
            <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>
          </div>
        </header>

        {side.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
            {t(source ? 'aps.entry.transfer.emptySource' : 'aps.entry.transfer.emptyDestination')}
          </p>
        ) : (
          <table className="mt-3 w-full min-w-0 table-fixed border-collapse text-sm">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="text-muted-foreground text-xs">
                <th scope="col" className="pb-1 text-start font-semibold">
                  {t('aps.letters.warehouse')}
                </th>
                <th scope="col" className="pb-1 text-start font-semibold">
                  {t('aps.letters.classification')}
                </th>
                <th scope="col" className="w-20 pb-1 text-start font-semibold sm:w-28">
                  {t('aps.letters.amount')}
                </th>
                <th scope="col" className="w-10 pb-1 sm:w-11">
                  <span className="sr-only">{t('aps.entry.transfer.removeColumn')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {side.map((line, index) => {
                const row = index + 1;
                return (
                  <tr
                    key={line.key}
                    data-highlighted={line.key === highlightedKey ? 'true' : undefined}
                    className={line.key === highlightedKey ? 'bg-destructive/5' : undefined}
                  >
                    <td className="min-w-0 py-1 pe-1">
                      <SearchCombobox
                        hideLabel
                        label={t('aps.entry.transfer.rowField', {
                          side: title,
                          row,
                          field: t('aps.letters.warehouse'),
                        })}
                        value={line.warehouseId}
                        options={warehouses}
                        placeholder={t('aps.entry.chooseWarehouse')}
                        searchPlaceholder={t('aps.entry.searchWarehouse')}
                        noMatches={t('aps.entry.noWarehouseMatches')}
                        clearLabel={t('aps.entry.clearWarehouse')}
                        missingLabel={t('aps.entry.unavailableOption')}
                        onChange={(warehouseId) => patch(line.key, { warehouseId })}
                      />
                    </td>
                    <td className="min-w-0 py-1 pe-1">
                      <SearchCombobox
                        hideLabel
                        label={t('aps.entry.transfer.rowField', {
                          side: title,
                          row,
                          field: t('aps.letters.classification'),
                        })}
                        value={line.classificationId}
                        options={classifications.map((item) => ({
                          value: item.id,
                          label: item.name,
                          keywords: `${item.name} ${item.code}`,
                        }))}
                        placeholder={t('aps.entry.chooseClassification')}
                        searchPlaceholder={t('aps.entry.searchClassification')}
                        noMatches={t('aps.entry.noClassificationMatches')}
                        clearLabel={t('aps.entry.clearClassification')}
                        missingLabel={t('aps.entry.unavailableOption')}
                        onChange={(classificationId) => patch(line.key, { classificationId })}
                      />
                    </td>
                    <td className="py-1 pe-1">
                      <input
                        className={AMOUNT_CONTROL}
                        dir="ltr"
                        inputMode="decimal"
                        aria-label={t('aps.entry.transfer.rowField', {
                          side: title,
                          row,
                          field: t('aps.letters.amount'),
                        })}
                        placeholder={t('aps.entry.amountPlaceholder')}
                        value={line.amount}
                        onChange={(event) => patch(line.key, { amount: event.target.value })}
                      />
                    </td>
                    <td className="py-1">
                      <button
                        type="button"
                        aria-label={t(
                          source
                            ? 'aps.entry.transfer.removeSource'
                            : 'aps.entry.transfer.removeDestination',
                          { number: row },
                        )}
                        onClick={() => remove(line.key)}
                        className="text-muted-foreground hover:text-destructive grid size-10 place-items-center rounded-lg"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <button
          type="button"
          disabled={full}
          onClick={() => add(direction)}
          className="border-primary/25 text-primary hover:bg-primary/5 mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t(source ? 'aps.entry.transfer.addSource' : 'aps.entry.transfer.addDestination')}
        </button>
      </section>
    );
  };

  const amount = (value: string | null) =>
    value === null ? t('aps.entry.waitingAmount') : formatLetterAmount(value, locale);
  const balanced = totals.balanced === true;
  const unbalanced = totals.balanced === false;

  return (
    <div className="grid min-w-0 gap-3 @4xl:grid-cols-2">
      <div className="order-1 min-w-0">{table('out')}</div>
      <div className="order-2 min-w-0 @4xl:order-3 @4xl:col-span-2">
        <div
          role="status"
          aria-live="polite"
          data-testid="transfer-balance"
          data-balance={balanced ? 'balanced' : unbalanced ? 'unbalanced' : 'unknown'}
          className={`flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border px-3 py-2.5 ${
            unbalanced
              ? 'border-destructive/40 bg-destructive/5'
              : balanced
                ? 'border-emerald-300/70 bg-emerald-500/5'
                : 'border-border bg-muted/55'
          }`}
        >
          <span className="text-foreground inline-flex items-center gap-2 text-sm font-bold">
            <Scale
              className={
                unbalanced
                  ? 'text-destructive size-4'
                  : balanced
                    ? 'size-4 text-emerald-700 dark:text-emerald-300'
                    : 'text-muted-foreground size-4'
              }
              aria-hidden="true"
            />
            {t('aps.entry.transfer.balanceTitle')}
          </span>
          <dl className="grid min-w-0 flex-1 grid-cols-3 gap-2 text-xs">
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t('aps.entry.transfer.totalSource')}</dt>
              <dd className="text-foreground mt-0.5 font-bold tabular-nums" dir="ltr">
                {amount(totals.source)}
              </dd>
            </div>
            <div className="border-border min-w-0 border-s ps-2">
              <dt className="text-muted-foreground">{t('aps.entry.transfer.totalDestination')}</dt>
              <dd className="text-foreground mt-0.5 font-bold tabular-nums" dir="ltr">
                {amount(totals.destination)}
              </dd>
            </div>
            <div className="border-border min-w-0 border-s ps-2">
              <dt className="text-muted-foreground">{t('aps.entry.transfer.difference')}</dt>
              <dd
                className={`mt-0.5 overflow-hidden font-bold break-words tabular-nums ${
                  unbalanced
                    ? 'text-destructive'
                    : balanced
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-foreground'
                }`}
                dir="ltr"
                data-testid="transfer-difference"
              >
                {amount(totals.difference)}
              </dd>
            </div>
          </dl>
          <p
            className={`text-xs font-semibold ${
              unbalanced
                ? 'text-destructive'
                : balanced
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-muted-foreground'
            }`}
          >
            {balanced
              ? t('aps.entry.transfer.balanced')
              : unbalanced
                ? t('aps.entry.transfer.unbalanced')
                : t('aps.entry.transfer.balancePending')}
          </p>
          <p className="text-muted-foreground w-full text-[11px] leading-relaxed">
            {t('aps.entry.transfer.balanceHint')}
          </p>
        </div>
      </div>
      <div className="order-3 min-w-0 @4xl:order-2">{table('in')}</div>
    </div>
  );
}
