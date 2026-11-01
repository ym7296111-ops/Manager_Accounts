import { LoaderCircle } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, MODAL_FIELD_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';

export interface FiscalMonthActivationDialogProps {
  readonly monthName: string;
  readonly busy: boolean;
  readonly error: TranslationKey | null;
  readonly onSubmit: (reason: string) => void;
  readonly onClose: () => void;
}

/** The database requires a protected role AND this reason for a closed period. */
export function FiscalMonthActivationDialog({
  monthName,
  busy,
  error,
  onSubmit,
  onClose,
}: FiscalMonthActivationDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const trimmedReason = reason.trim();
  // PostgreSQL char_length counts characters, not UTF-16 code units.
  const validReason = Array.from(trimmedReason).length >= 10;

  useEscapeKey(onClose, !busy);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (validReason && !busy) onSubmit(trimmedReason);
  };

  return (
    <ModalShell
      titleId={titleId}
      title={t('settings.project.fiscal.periods.activateClosedTitle')}
      closeLabel={t('settings.project.fiscal.periods.closeDialog')}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} className="mt-4 space-y-4">
        <p className="text-foreground text-sm font-medium">
          {t('settings.project.fiscal.periods.activateClosedBody', { month: monthName })}
        </p>
        <p className="border-warning/30 bg-warning/10 text-warning rounded-lg border px-3 py-2 text-xs leading-relaxed">
          {t('settings.project.fiscal.periods.activateProtectedHint')}
        </p>
        <div>
          <label htmlFor={reasonId} className="text-foreground text-sm font-medium">
            {t('settings.project.fiscal.periods.activateReason')}
          </label>
          <textarea
            id={reasonId}
            autoFocus
            required
            rows={3}
            value={reason}
            disabled={busy}
            aria-describedby={`${reasonId}-hint`}
            onChange={(event) => setReason(event.target.value)}
            className={MODAL_FIELD_CLASS}
          />
          <p id={`${reasonId}-hint`} className="text-muted-foreground mt-1.5 text-xs">
            {t('settings.project.fiscal.periods.activateReasonHint')}
          </p>
        </div>
        {error !== null ? (
          <p role="alert" className="text-destructive text-sm">
            {t(error)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
          >
            {t('settings.project.fiscal.periods.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy || !validReason}
            className={`${MODAL_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy
              ? t('settings.project.fiscal.periods.activating')
              : t('settings.project.fiscal.periods.activate')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
