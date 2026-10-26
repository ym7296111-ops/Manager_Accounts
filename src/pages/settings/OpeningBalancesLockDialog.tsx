import { Loader2, Lock, Unlock } from 'lucide-react';
import { useId } from 'react';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Confirmation for «قفل أرصدة أول المدة» / «فتح الأرصدة».
 *
 * Both directions ask. Locking is the destructive-feeling one — it freezes a
 * year's opening figures for every user and is only undone by another
 * deliberate unlock — but unlocking is not harmless either: it reopens the
 * numbers the ledger starts from, and the database records who did it.
 *
 * Unsaved drafts are the one case the dialog has to say out loud: a row typed
 * but not saved cannot be written after the freeze, so locking drops those
 * drafts rather than leaving a permanently dirty editor behind. The caller
 * decides whether that applies; this component only renders it.
 */
export interface OpeningBalancesLockTarget {
  /** The state the switch is moving to. */
  readonly locked: boolean;
  readonly yearName: string;
  readonly hasUnsavedDrafts: boolean;
}

export interface OpeningBalancesLockDialogProps {
  readonly target: OpeningBalancesLockTarget | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function OpeningBalancesLockDialog({
  target,
  busy,
  onConfirm,
  onClose,
}: OpeningBalancesLockDialogProps) {
  const { t } = useI18n();
  const titleId = useId();

  useEscapeKey(onClose, !busy);

  if (target === null) {
    return null;
  }

  const Icon = target.locked ? Lock : Unlock;

  return (
    <ModalShell
      titleId={titleId}
      title={t(
        target.locked
          ? 'settings.project.fiscal.openingBalances.lock.title'
          : 'settings.project.fiscal.openingBalances.unlock.title',
      )}
      closeLabel={t('settings.project.fiscal.openingBalances.picker.close')}
      onClose={onClose}
      busy={busy}
    >
      <div className="text-muted-foreground mt-3 flex items-start gap-2 text-sm leading-relaxed">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          {t(
            target.locked
              ? 'settings.project.fiscal.openingBalances.lock.body'
              : 'settings.project.fiscal.openingBalances.unlock.body',
            { name: target.yearName },
          )}
        </p>
      </div>
      {target.locked && target.hasUnsavedDrafts ? (
        <p className="border-warning/30 bg-warning/10 text-foreground mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed">
          {t('settings.project.fiscal.openingBalances.lock.unsavedDrafts')}
        </p>
      ) : null}
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
          className={`${MODAL_BUTTON_CLASS} ${
            target.locked
              ? 'bg-warning text-warning-foreground'
              : 'bg-success text-success-foreground'
          }`}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t(
            target.locked
              ? 'settings.project.fiscal.openingBalances.lock.confirm'
              : 'settings.project.fiscal.openingBalances.unlock.confirm',
          )}
        </button>
      </div>
    </ModalShell>
  );
}
