import type { TranslationKey } from '@/i18n/locales/ar';
import { ModalShell } from '@/components/ui/ModalShell';
import { useI18n } from '@/i18n/I18nContext';
import {
  formatReconciliationAmount,
  type ReconciliationLine,
  type Draft,
} from '@/lib/apsReconciliation';

export const button =
  'rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
export function Amount({ value }: { value: string | null }) {
  const { t, locale } = useI18n();
  return value === null ? (
    <span className="font-semibold text-amber-700 dark:text-amber-300">
      {t('aps.recon.v2.notEntered')}
    </span>
  ) : (
    <span dir="ltr" className="inline-block">
      {formatReconciliationAmount(value, locale)}
    </span>
  );
}
const columns: (keyof ReconciliationLine['monthly'])[] = [
  'book_inbound',
  'accountant_inbound',
  'book_outbound',
  'accountant_outbound',
  'book_balance',
  'accountant_balance',
  'balance_difference',
];
function GroupedHeader() {
  const { t } = useI18n();
  return (
    <thead>
      <tr>
        <th rowSpan={2} scope="col" className="p-3 text-start">
          {t('aps.recon.classification')}
        </th>
        <th colSpan={2} scope="colgroup" className="p-3">
          {t('aps.recon.v3.inbound')}
        </th>
        <th colSpan={2} scope="colgroup" className="p-3">
          {t('aps.recon.v3.outbound')}
        </th>
        <th colSpan={2} scope="colgroup" className="p-3">
          {t('aps.recon.v3.balance')}
        </th>
        <th rowSpan={2} scope="col" className="p-3">
          {t('aps.recon.difference')}
        </th>
        <th rowSpan={2} scope="col" className="p-3">
          {t('aps.recon.rowStatus')}
        </th>
      </tr>
      <tr>
        {(['in', 'out', 'balance'] as const).flatMap((group) => [
          <th key={`${group}-book`} scope="col" className="p-3">
            {t('aps.recon.v3.costs')}
          </th>,
          <th key={`${group}-accountant`} scope="col" className="p-3">
            {t('aps.recon.v3.accounts')}
          </th>,
        ])}
      </tr>
    </thead>
  );
}
export function ReconciliationTables({
  lines,
  readOnly,
  draftIds,
  onEdit,
}: {
  lines: ReconciliationLine[];
  readOnly: boolean;
  draftIds: Set<string>;
  onEdit: (line: ReconciliationLine) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-5">
      {(['monthly', 'ytd'] as const).map((period) => {
        const table = (
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[1000px] text-sm"
              aria-label={t(period === 'monthly' ? 'aps.recon.v2.monthly' : 'aps.recon.v2.ytd')}
            >
              <GroupedHeader />
              <tbody>
                {lines.map((line) => {
                  const value = line[period];
                  const incomplete =
                    value.book_inbound === null ||
                    value.book_outbound === null ||
                    value.accountant_inbound === null ||
                    value.accountant_outbound === null ||
                    (period === 'ytd' && line.ytd.book_opening === null);
                  const mismatch =
                    !incomplete &&
                    [
                      value.inbound_difference,
                      value.outbound_difference,
                      value.balance_difference,
                    ].some((v) => v !== '0.00');
                  return (
                    <tr key={line.id} className="border-border border-t">
                      <th scope="row" className="p-3 text-start break-words">
                        {line.classification_name}
                        {period === 'ytd' && (
                          <div className="text-xs font-normal">
                            <p>
                              {t('aps.recon.v2.bookOpening')}:{' '}
                              <Amount value={line.ytd.book_opening} />
                            </p>
                            <p>
                              {t('aps.recon.v2.accountantOpening')}:{' '}
                              <Amount value={line.ytd.accountant_opening} />
                            </p>
                            <p>
                              {t(
                                line.ytd.accountant_opening_source === 'manual'
                                  ? 'aps.recon.v2.openingManual'
                                  : line.ytd.accountant_opening_source === 'trusted_system'
                                    ? 'aps.recon.v2.openingSystem'
                                    : 'aps.recon.v2.openingMissing',
                              )}
                            </p>
                          </div>
                        )}
                      </th>
                      {columns.map((key) => (
                        <td key={key} className="p-3">
                          <Amount value={value[key]} />
                        </td>
                      ))}
                      <td className="p-3">
                        <p>
                          {t(
                            incomplete
                              ? 'aps.recon.v3.rowIncomplete'
                              : mismatch
                                ? 'aps.recon.v3.rowMismatch'
                                : 'aps.recon.v3.rowMatched',
                          )}
                        </p>
                        {draftIds.has(line.id) && <p>{t('aps.recon.v2.pendingDraft')}</p>}
                        {period === 'monthly' && (
                          <button
                            type="button"
                            className={button}
                            disabled={readOnly}
                            onClick={() => onEdit(line)}
                          >
                            {t('aps.recon.v2.edit', { name: line.classification_name })}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!lines.length && <p className="p-3">{t('aps.recon.noLines')}</p>}
          </div>
        );
        return period === 'monthly' ? (
          <section key={period} className="bg-card border-border rounded-xl border">
            <h2 className="p-3 font-semibold">{t('aps.recon.v2.monthly')}</h2>
            {table}
          </section>
        ) : (
          <details key={period} className="bg-card border-border rounded-xl border">
            <summary className="cursor-pointer p-3 font-semibold">{t('aps.recon.v2.ytd')}</summary>
            {table}
          </details>
        );
      })}
    </div>
  );
}
export function EntryDialog({
  line,
  draft,
  busy,
  error,
  onChange,
  onSave,
  onClose,
  onRebase,
  canAccept,
  onAccept,
}: {
  line: ReconciliationLine;
  draft: Draft;
  busy: boolean;
  error: string | null;
  onChange: (draft: Draft) => void;
  onSave: () => void;
  onClose: () => void;
  onRebase: () => void;
  canAccept: boolean;
  onAccept: () => void;
}) {
  const { t } = useI18n();
  const conflict = draft.version !== line.version || !!draft.submitted;
  const fields: {
    key: 'monthlyInbound' | 'monthlyOutbound' | 'ytdInbound' | 'ytdOutbound';
    label: TranslationKey;
  }[] = [
    { key: 'monthlyInbound', label: 'aps.recon.v2.accountantInbound' },
    { key: 'monthlyOutbound', label: 'aps.recon.v2.accountantOutbound' },
    { key: 'ytdInbound', label: 'aps.recon.v2.ytdInbound' },
    { key: 'ytdOutbound', label: 'aps.recon.v2.ytdOutbound' },
  ];
  return (
    <ModalShell
      titleId="entry-title"
      title={t('aps.recon.v2.edit', { name: line.classification_name })}
      closeLabel={t('aps.recon.cancel')}
      onClose={onClose}
      busy={busy}
    >
      <div className="mt-4 space-y-4">
        <fieldset className="space-y-3">
          <legend className="font-semibold">{t('aps.recon.v2.movementSection')}</legend>
          {fields.map((f) => (
            <label key={f.key} className="grid gap-1 text-sm">
              {t(f.label)}
              <input
                dir="ltr"
                inputMode="decimal"
                maxLength={50}
                className="border-border bg-background rounded border p-2"
                disabled={busy || conflict}
                value={draft[f.key]}
                onChange={(e) => onChange({ ...draft, [f.key]: e.target.value })}
              />
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="font-semibold">{t('aps.recon.v2.openingSection')}</legend>
          <p className="text-muted-foreground text-sm">{t('aps.recon.v2.openingHelp')}</p>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={draft.manual}
              disabled={busy || conflict}
              onChange={(e) => onChange({ ...draft, manual: e.target.checked })}
            />
            {t('aps.recon.v2.useManual')}
          </label>
          {draft.manual && (
            <label className="grid gap-1 text-sm">
              {t('aps.recon.v2.accountantOpening')}
              <input
                dir="ltr"
                inputMode="decimal"
                maxLength={50}
                className="border-border bg-background rounded border p-2"
                disabled={busy || conflict}
                value={draft.opening}
                onChange={(e) => onChange({ ...draft, opening: e.target.value })}
              />
            </label>
          )}
        </fieldset>
        <p className="text-sm">{t('aps.recon.v2.allRequired')}</p>
        {conflict && (
          <div role="alert">
            <p>{t('aps.recon.v2.versionConflict')}</p>
            <p className="mt-2 font-semibold">{t('aps.recon.v2.currentValues')}</p>
            <ul className="space-y-1 text-sm">
              <li>
                {t('aps.recon.v2.accountantInbound')}:{' '}
                <Amount value={line.monthly.accountant_inbound} />
              </li>
              <li>
                {t('aps.recon.v2.accountantOutbound')}:{' '}
                <Amount value={line.monthly.accountant_outbound} />
              </li>
              <li>
                {t('aps.recon.v2.ytdInbound')}: <Amount value={line.ytd.accountant_inbound} />
              </li>
              <li>
                {t('aps.recon.v2.ytdOutbound')}: <Amount value={line.ytd.accountant_outbound} />
              </li>
              <li>
                {t('aps.recon.v2.accountantOpening')}:{' '}
                <Amount value={line.ytd.accountant_opening} /> (
                {t(
                  line.ytd.accountant_opening_source === 'manual'
                    ? 'aps.recon.v2.openingManual'
                    : line.ytd.accountant_opening_source === 'trusted_system'
                      ? 'aps.recon.v2.openingSystem'
                      : 'aps.recon.v2.openingMissing',
                )}
                )
              </li>
            </ul>
            <button type="button" className={button} disabled={busy} onClick={onRebase}>
              {t('aps.recon.v2.refreshRead')}
            </button>
            <button
              type="button"
              className={button}
              disabled={busy || !canAccept}
              onClick={onAccept}
            >
              {t('aps.recon.v2.rebaseDraft')}
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        <button type="button" className={button} onClick={onSave} disabled={busy || conflict}>
          {t('aps.recon.save')}
        </button>
      </div>
    </ModalShell>
  );
}
