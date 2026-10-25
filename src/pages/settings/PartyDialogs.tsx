import { Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, MODAL_FIELD_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import { useI18n } from '@/i18n/I18nContext';
import type { PartyBranch } from '@/lib/database.types';
import { validateName } from '@/lib/nameValidation';

/**
 * Dialogs for the parties tree.
 *
 * A party's identity is the server's:
 *
 * * `code` never appears as a field. `parties_before_write` mints `IN-###` for
 *   an inbound party and `OUT-###` for an outbound one, from that branch's own
 *   sequence; on edit it renders as plain text.
 * * `branch` is chosen exactly once, by *which* root's "add" button opened the
 *   dialog. There is no branch control to get wrong, and no path that could
 *   send it on an update (the trigger refuses a change with 22023).
 *
 * The only editable field is the name. A party carries no other attribute: the
 * commercial profile (tax number, commercial register, address, contact
 * person, phone, email, credit limit, payment terms) was retired with its
 * columns in 20261109000000.
 */

export interface PartyFormDialogProps {
  /** Create: the root whose "add" button opened the dialog. */
  readonly branch: PartyBranch;
  readonly mode: 'create' | 'edit';
  /** Edit: the stored name, prefilled. */
  readonly initialName?: string;
  /** Edit: the stored code, rendered read-only. */
  readonly code?: string;
  readonly busy: boolean;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}

/** The shape of the code the server is about to mint, for the one-line hint. */
const CODE_SHAPE: Record<PartyBranch, string> = {
  inbound: 'IN-###',
  outbound: 'OUT-###',
};

export function PartyFormDialog({
  branch,
  mode,
  initialName,
  code,
  busy,
  onSubmit,
  onClose,
}: PartyFormDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const nameId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(initialName ?? '');
  const [error, setError] = useState<'required' | 'tooShort' | null>(null);

  useEscapeKey(onClose, !busy);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const titleKey =
    mode === 'create'
      ? branch === 'inbound'
        ? 'settings.project.parties.dialog.addInbound'
        : 'settings.project.parties.dialog.addOutbound'
      : 'settings.project.parties.dialog.edit';

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validateName(name);
    if (!result.ok) {
      setError(result.code);
      return;
    }
    setError(null);
    onSubmit(result.value);
  }

  return (
    <ModalShell
      titleId={titleId}
      title={t(titleKey)}
      closeLabel={t('settings.project.parties.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      {/* noValidate: the localized inline error mirrors the shared name rule,
          which is one step stricter than the database's blank-name CHECK. */}
      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
        {mode === 'edit' && code !== undefined ? (
          <div className="space-y-1.5">
            <span className="text-foreground block text-sm font-medium">
              {t('settings.project.parties.dialog.code')}
            </span>
            <p className="text-muted-foreground font-mono text-sm">{code}</p>
            <p className="text-muted-foreground text-xs">
              {t('settings.project.parties.dialog.immutable')}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-sm leading-relaxed">
              {branch === 'inbound'
                ? t('settings.project.parties.dialog.inboundHint')
                : t('settings.project.parties.dialog.outboundHint')}
            </p>
            {/* The code stays out of the sentence and inside `dir="ltr"`: a
                hyphenated code reordered by the RTL paragraph direction would
                read as a different code. */}
            <div className="flex items-baseline gap-2">
              <span className="text-foreground text-sm font-medium">
                {t('settings.project.parties.dialog.codePreview')}
              </span>
              <span dir="ltr" className="text-muted-foreground font-mono text-sm">
                {CODE_SHAPE[branch]}
              </span>
            </div>
          </div>
        )}

        <div>
          <label htmlFor={nameId} className="text-foreground text-sm font-medium">
            {t('settings.project.parties.dialog.name')}
          </label>
          <input
            id={nameId}
            ref={nameRef}
            type="text"
            value={name}
            disabled={busy}
            autoComplete="off"
            aria-invalid={error !== null}
            aria-describedby={error !== null ? `${nameId}-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            className={MODAL_FIELD_CLASS}
          />
          {error !== null ? (
            <p id={`${nameId}-error`} role="alert" className="text-destructive mt-1.5 text-xs">
              {t(
                error === 'required'
                  ? 'settings.project.parties.validation.required'
                  : 'settings.project.parties.validation.tooShort',
              )}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
          >
            {t('settings.project.parties.dialog.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className={`${MODAL_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy
              ? t('settings.project.parties.dialog.saving')
              : t('settings.project.parties.dialog.save')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export interface PartyDeleteDialogProps {
  readonly name: string;
  readonly code: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function PartyDeleteDialog({
  name,
  code,
  busy,
  onConfirm,
  onClose,
}: PartyDeleteDialogProps) {
  const { t } = useI18n();
  const titleId = useId();

  useEscapeKey(onClose, !busy);

  return (
    <ModalShell
      titleId={titleId}
      title={t('settings.project.parties.delete.title')}
      closeLabel={t('settings.project.parties.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
        {t('settings.project.parties.delete.body', { name, code })}
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
        >
          {t('settings.project.parties.dialog.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`${MODAL_BUTTON_CLASS} bg-destructive text-destructive-foreground`}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t('settings.project.parties.delete.confirm')}
        </button>
      </div>
    </ModalShell>
  );
}
