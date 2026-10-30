import { Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, MODAL_FIELD_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import { useI18n } from '@/i18n/I18nContext';
import { ISSUER_NAME_MAX_LENGTH, isIssuerCode, normalizeIssuerCode } from '@/lib/issuers';

/**
 * Dialogs for the issuer register.
 *
 * The two letters are the identity of the row: they are typed once, on create,
 * and shown as plain text afterwards. The name is the only editable field, and
 * it is optional — the database column is `not null`, so a blank name is stored
 * as the code itself (see `validateIssuerName`), which the label renders as the
 * code alone rather than `YM — YM`.
 *
 * Both rules are checked here with the same helpers the mutation uses, so an
 * invalid value never reaches the network — and `issuers_code_format` /
 * `issuers_name_not_blank` remain the real guard.
 */

export type IssuerFormMode = 'create' | 'edit';

export interface IssuerFormDialogProps {
  readonly mode: IssuerFormMode;
  /** Edit: the stored code, rendered read-only. */
  readonly code?: string;
  /** Edit: the stored name, prefilled. */
  readonly initialName?: string;
  readonly busy: boolean;
  readonly onSubmit: (values: { readonly code: string; readonly name: string }) => void;
  readonly onClose: () => void;
}

type CodeError = 'required' | 'shape' | null;
type NameError = 'tooLong' | null;

export function IssuerFormDialog({
  mode,
  code,
  initialName,
  busy,
  onSubmit,
  onClose,
}: IssuerFormDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const codeId = useId();
  const nameId = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const [draftCode, setDraftCode] = useState('');
  const [name, setName] = useState(initialName ?? '');
  const [codeError, setCodeError] = useState<CodeError>(null);
  const [nameError, setNameError] = useState<NameError>(null);

  useEscapeKey(onClose, !busy);

  useEffect(() => {
    if (mode === 'create') {
      codeRef.current?.focus();
    } else {
      nameRef.current?.focus();
    }
  }, [mode]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const nextCode = mode === 'create' ? normalizeIssuerCode(draftCode) : (code ?? '');
    if (!isIssuerCode(nextCode)) {
      setCodeError(nextCode === '' ? 'required' : 'shape');
      return;
    }
    setCodeError(null);
    if ([...name.trim()].length > ISSUER_NAME_MAX_LENGTH) {
      setNameError('tooLong');
      return;
    }
    setNameError(null);
    onSubmit({ code: nextCode, name: name.trim() });
  }

  return (
    <ModalShell
      titleId={titleId}
      title={t(
        mode === 'create'
          ? 'settings.project.issuers.dialog.add'
          : 'settings.project.issuers.dialog.edit',
      )}
      closeLabel={t('settings.project.issuers.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      {/* noValidate: the localized inline errors mirror the database CHECKs
          (two Latin letters, 1..120 characters) without the browser's own
          message in the wrong language. */}
      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
        {mode === 'create' ? (
          <div className="space-y-1.5">
            <label htmlFor={codeId} className="text-foreground text-sm font-medium">
              {t('settings.project.issuers.dialog.code')}
            </label>
            <input
              id={codeId}
              ref={codeRef}
              type="text"
              dir="ltr"
              lang="en"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={2}
              placeholder="YM"
              value={draftCode}
              disabled={busy}
              aria-invalid={codeError !== null}
              aria-describedby={`${codeId}-help`}
              onChange={(event) => {
                setDraftCode(normalizeIssuerCode(event.target.value));
                setCodeError(null);
              }}
              className={`${MODAL_FIELD_CLASS} font-mono text-base font-semibold tracking-widest uppercase`}
            />
            <p
              id={`${codeId}-help`}
              role={codeError !== null ? 'alert' : undefined}
              className={
                codeError !== null
                  ? 'text-destructive text-xs'
                  : 'text-muted-foreground text-xs leading-relaxed'
              }
            >
              {codeError !== null
                ? t(
                    codeError === 'required'
                      ? 'settings.project.issuers.validation.codeRequired'
                      : 'settings.project.issuers.validation.codeShape',
                  )
                : t('settings.project.issuers.dialog.codeHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <span className="text-foreground block text-sm font-medium">
              {t('settings.project.issuers.dialog.codeFixed')}
            </span>
            <p dir="ltr" className="text-muted-foreground font-mono text-base font-semibold">
              {code}
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {t('settings.project.issuers.dialog.immutable')}
            </p>
          </div>
        )}

        <div>
          <label htmlFor={nameId} className="text-foreground text-sm font-medium">
            {t('settings.project.issuers.dialog.name')}
          </label>
          <input
            id={nameId}
            ref={nameRef}
            type="text"
            value={name}
            disabled={busy}
            autoComplete="off"
            maxLength={ISSUER_NAME_MAX_LENGTH}
            aria-invalid={nameError !== null}
            aria-describedby={`${nameId}-help`}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
            className={MODAL_FIELD_CLASS}
          />
          <p
            id={`${nameId}-help`}
            role={nameError !== null ? 'alert' : undefined}
            className={
              nameError !== null
                ? 'text-destructive mt-1.5 text-xs'
                : 'text-muted-foreground mt-1.5 text-xs leading-relaxed'
            }
          >
            {nameError !== null
              ? t('settings.project.issuers.validation.nameTooLong')
              : t('settings.project.issuers.dialog.nameHint')}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
          >
            {t('settings.project.issuers.dialog.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className={`${MODAL_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy
              ? t('settings.project.issuers.dialog.saving')
              : t('settings.project.issuers.dialog.save')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
