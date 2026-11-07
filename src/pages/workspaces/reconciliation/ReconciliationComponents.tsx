import { ModalShell } from '@/components/ui/ModalShell';
import { useI18n } from '@/i18n/I18nContext';
import type { TranslationKey } from '@/i18n/locales/ar';
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
const columns: { key: keyof ReconciliationLine['monthly']; label: TranslationKey }[] = [
  { key: 'book_inbound', label: 'aps.recon.v2.bookInbound' },
  { key: 'accountant_inbound', label: 'aps.recon.v2.accountantInbound' },
  { key: 'book_outbound', label: 'aps.recon.v2.bookOutbound' },
  { key: 'accountant_outbound', label: 'aps.recon.v2.accountantOutbound' },
  { key: 'book_balance', label: 'aps.recon.v2.bookBalance' },
  { key: 'accountant_balance', label: 'aps.recon.v2.accountantBalance' },
  { key: 'balance_difference', label: 'aps.recon.difference' },
];
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
      <section
        aria-label={t('aps.recon.v2.monthly')}
        className="bg-card border-border overflow-x-auto rounded-xl border"
      >
        <h2 className="p-3 font-semibold">{t('aps.recon.v2.monthly')}</h2>
        <table className="w-full min-w-[1000px] text-sm">
          <thead>
            <tr>
              <th className="p-3 text-start">{t('aps.recon.classification')}</th>
              {columns.map((c) => (
                <th key={c.key} className="p-3 text-start">
                  {t(c.label)}
                </th>
              ))}
              <th className="p-3 text-start">{t('aps.recon.rowStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-border border-t">
                <th scope="row" className="p-3 text-start break-words">
                  {line.classification_name}
                </th>
                {columns.map((c) => (
                  <td key={c.key} className="p-3">
                    <Amount value={line.monthly[c.key]} />
                  </td>
                ))}
                <td className="p-3">
                  {draftIds.has(line.id) && <p>{t('aps.recon.v2.pendingDraft')}</p>}
                  <button
                    type="button"
                    className={button}
                    disabled={readOnly}
                    onClick={() => onEdit(line)}
                  >
                    {t('aps.recon.v2.edit', { name: line.classification_name })}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!lines.length && <p className="p-3">{t('aps.recon.noLines')}</p>}
      </section>
      <details className="bg-card border-border rounded-xl border">
        <summary className="cursor-pointer p-3 font-semibold">{t('aps.recon.v2.ytd')}</summary>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-sm">
            <thead>
              <tr>
                {(
                  [
                    'aps.recon.classification',
                    'aps.recon.v2.bookOpening',
                    'aps.recon.v2.accountantOpening',
                    'aps.recon.v2.bookInbound',
                    'aps.recon.v2.accountantInbound',
                    'aps.recon.v2.bookOutbound',
                    'aps.recon.v2.accountantOutbound',
                    'aps.recon.v2.bookClosing',
                    'aps.recon.v2.accountantClosing',
                    'aps.recon.difference',
                  ] as TranslationKey[]
                ).map((key) => (
                  <th className="p-3 text-start" key={key}>
                    {t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id} className="border-border border-t">
                  <th scope="row" className="p-3 text-start break-words">
                    {line.classification_name}
                  </th>
                  <td className="p-3">
                    <Amount value={line.ytd.book_opening} />
                  </td>
                  <td className="p-3">
                    <Amount value={line.ytd.accountant_opening} />
                    <p className="text-muted-foreground text-xs">
                      {t(
                        line.ytd.accountant_opening_source === 'manual'
                          ? 'aps.recon.v2.openingManual'
                          : line.ytd.accountant_opening_source === 'trusted_system'
                            ? 'aps.recon.v2.openingSystem'
                            : 'aps.recon.v2.openingMissing',
                      )}
                    </p>
                  </td>
                  {columns.map((c) => (
                    <td key={c.key} className="p-3">
                      <Amount value={line.ytd[c.key]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
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
