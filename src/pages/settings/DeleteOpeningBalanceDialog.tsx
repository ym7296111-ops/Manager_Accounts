import { Loader2 } from 'lucide-react';
import { useId } from 'react';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Confirmation for removing a saved balance.
 *
 * A separate dialog from `ConfirmDeleteDialog` (stations/warehouses): that one
 * is typed to two entity kinds with their own translation keys, and widening it
 * would make both call sites read through a union they do not use.
 *
 * The body repeats the amount. Deleting a saved balance is irreversible and the
 * audit entry is the only remaining record of it, so the operator must see the
 * figure they are about to drop, not just the classification name.
 */
export interface DeleteOpeningBalanceTarget {
  readonly balanceId: string;
  readonly classification: string;
  readonly code: string | null;
  readonly amountText: string;
  readonly warehouse: string;
}

export interface DeleteOpeningBalanceDialogProps {
  readonly target: DeleteOpeningBalanceTarget | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function DeleteOpeningBalanceDialog({
  target,
  busy,
  onConfirm,
  onClose,
}: DeleteOpeningBalanceDialogProps) {
  const { t } = useI18n();
  const titleId = useId();

  useEscapeKey(onClose, !busy);

  if (target === null) {
    return null;
  }

  return (
    <ModalShell
      titleId={titleId}
      title={t('settings.project.fiscal.openingBalances.delete.title')}
      closeLabel={t('settings.project.fiscal.openingBalances.picker.close')}
      onClose={onClose}
      busy={busy}
    >
      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
        {t('settings.project.fiscal.openingBalances.delete.body', {
          classification: target.classification,
          code: target.code ?? '—',
          amount: target.amountText,
          warehouse: target.warehouse,
        })}
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
        >
          {t('settings.project.fiscal.openingBalances.delete.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`${MODAL_BUTTON_CLASS} bg-destructive text-destructive-foreground`}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t('settings.project.fiscal.openingBalances.delete.confirm')}
        </button>
      </div>
    </ModalShell>
  );
}
