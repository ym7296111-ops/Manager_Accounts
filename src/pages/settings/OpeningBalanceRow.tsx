import { AlertTriangle, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n/I18nContext';

/**
 * One line of the sparse opening-balance editor.
 *
 * Three shapes, and the difference is functional, not decorative:
 *
 * * `persisted` — a saved balance; editing it schedules an update.
 * * `added` — typed in this session and not saved yet; the delete control only
 *   discards it, which is why it carries no confirmation.
 * * `review` — a saved balance whose classification is no longer an active
 *   leaf. It is read-only and still counted: the money exists in the database,
 *   so hiding it would make the warehouse total disagree with the ledger.
 *
 * Amounts stay `inputMode="decimal"` with two decimals and `tabular-nums`;
 * the minus sign is blocked at the keyboard as well as by validation, because
 * `type="number"` alone accepts `-` and `e`.
 */

const AMOUNT_CLASS =
  'border-input bg-background text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/25 aria-invalid:border-destructive w-full rounded-lg border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60';

function blockNonDecimalKeys(event: React.KeyboardEvent<HTMLInputElement>) {
  if (['-', '+', 'e', 'E'].includes(event.key)) {
    event.preventDefault();
  }
}

export interface OpeningBalanceRowViewProps {
  readonly classificationId: string;
  readonly code: string;
  readonly name: string;
  readonly amountText: string;
  readonly invalid: boolean;
  readonly added: boolean;
  readonly disabled: boolean;
  readonly inputRef?: (element: HTMLInputElement | null) => void;
  readonly onChange: (text: string) => void;
  readonly onRemove: () => void;
}

export function OpeningBalanceRowView({
  classificationId,
  code,
  name,
  amountText,
  invalid,
  added,
  disabled,
  inputRef,
  onChange,
  onRemove,
}: OpeningBalanceRowViewProps) {
  const { t } = useI18n();
  const label = t('settings.project.fiscal.openingBalances.amountLabel', {
    classification: name,
  });

  return (
    <div
      className="border-border/70 flex flex-wrap items-center justify-between gap-3 border-b py-2.5 last:border-b-0"
      data-testid={`opening-row-${classificationId}`}
    >
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-foreground flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">{name}</span>
          {added ? (
            <span className="bg-primary/10 text-primary shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold">
              {t('settings.project.fiscal.openingBalances.row.new')}
            </span>
          ) : null}
        </p>
        <p className="text-muted-foreground text-xs">{code}</p>
        {invalid ? (
          <p className="text-destructive mt-0.5 text-xs">
            {t('settings.project.fiscal.writeError.validation')}
          </p>
        ) : added && amountText.trim() === '' ? (
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t('settings.project.fiscal.openingBalances.row.emptyHint')}
          </p>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <label className="w-40 min-w-0 sm:w-52">
          <span className="sr-only">{label}</span>
          <input
            ref={inputRef}
            type="number"
            min={0}
            max="9999999999999999.99"
            step="0.01"
            inputMode="decimal"
            value={amountText}
            aria-label={label}
            aria-invalid={invalid}
            disabled={disabled}
            onKeyDown={blockNonDecimalKeys}
            onChange={(event) => onChange(event.target.value)}
            className={AMOUNT_CLASS}
          />
        </label>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={
            added
              ? t('settings.project.fiscal.openingBalances.row.discard', { classification: name })
              : t('settings.project.fiscal.openingBalances.delete.action', {
                  classification: name,
                })
          }
          className="text-muted-foreground hover:text-destructive focus-visible:ring-ring shrink-0 rounded-lg p-2 transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export interface OpeningBalanceReviewRowViewProps {
  readonly balanceId: string;
  readonly code: string | null;
  readonly name: string | null;
  readonly amountText: string;
  readonly reasonLabel: string;
  readonly deleting: boolean;
  readonly onDelete: () => void;
}

/** A saved balance whose classification is no longer eligible. Read-only. */
export function OpeningBalanceReviewRowView({
  balanceId,
  code,
  name,
  amountText,
  reasonLabel,
  deleting,
  onDelete,
}: OpeningBalanceReviewRowViewProps) {
  const { t } = useI18n();
  const label = name ?? t('settings.project.fiscal.openingBalances.review.unavailable');

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 py-2.5"
      data-testid={`opening-review-row-${balanceId}`}
    >
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-foreground flex min-w-0 items-center gap-2 text-sm font-medium">
          <AlertTriangle className="text-warning size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </p>
        <p className="text-muted-foreground text-xs">
          {code ?? '—'} · {reasonLabel}
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-foreground w-40 min-w-0 text-end text-sm font-semibold tabular-nums sm:w-52">
          {amountText}
        </span>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          aria-label={t('settings.project.fiscal.openingBalances.delete.action', {
            classification: label,
          })}
          className="text-muted-foreground hover:text-destructive focus-visible:ring-ring shrink-0 rounded-lg p-2 transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
