import { Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, MODAL_FIELD_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import { useI18n } from '@/i18n/I18nContext';
import { validateName } from '@/lib/nameValidation';

/**
 * Dialogs for the sister-companies tree.
 *
 * A company's identity is the server's:
 *
 * * `code` never appears as a field. `sister_companies_before_write` mints
 *   `SIS-###` for a parent and `SIS-###-##` for a branch; on edit it renders
 *   as plain text.
 * * `parent_id` is chosen exactly once, by *which* "add" button opened the
 *   dialog — a new company is a parent, a branch is created inside a specific
 *   company. There is no parent control to get wrong, and no path that could
 *   send it on an update (the trigger refuses a change with 22023).
 *
 * Only the name is editable, so the form is one field plus the context that
 * tells the user where the row will land.
 */

export type SisterCompanyFormKind = 'parent' | 'branch';

export interface SisterCompanyFormDialogProps {
  readonly mode: 'create' | 'edit';
  readonly kind: SisterCompanyFormKind;
  /** Branch create: the company the branch will be created under. */
  readonly parentName?: string;
  /** Branch create: that company's code, so the hint shows its real prefix. */
  readonly parentCode?: string;
  /** Edit: the stored name, prefilled. */
  readonly initialName?: string;
  /** Edit: the stored code, rendered read-only. */
  readonly code?: string;
  readonly busy: boolean;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}

export function SisterCompanyFormDialog({
  mode,
  kind,
  parentName,
  parentCode,
  initialName,
  code,
  busy,
  onSubmit,
  onClose,
}: SisterCompanyFormDialogProps) {
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
      ? kind === 'parent'
        ? 'settings.project.sisterCompanies.dialog.addParent'
        : 'settings.project.sisterCompanies.dialog.addBranch'
      : 'settings.project.sisterCompanies.dialog.edit';

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
      closeLabel={t('settings.project.sisterCompanies.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      {/* noValidate: the localized inline error mirrors the shared name rule,
          which is one step stricter than the database's blank-name CHECK. */}
      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
        {mode === 'edit' && code !== undefined ? (
          <div className="space-y-1.5">
            <span className="text-foreground block text-sm font-medium">
              {t('settings.project.sisterCompanies.dialog.code')}
            </span>
            <p className="text-muted-foreground font-mono text-sm">{code}</p>
            <p className="text-muted-foreground text-xs">
              {t('settings.project.sisterCompanies.dialog.immutable')}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-sm leading-relaxed">
              {kind === 'branch' && parentName !== undefined
                ? t('settings.project.sisterCompanies.dialog.underParent', { parent: parentName })
                : t('settings.project.sisterCompanies.dialog.rootHint')}
            </p>
            {/* The code stays out of the sentence and inside `dir="ltr"`: a
                hyphenated code reordered by the RTL paragraph direction would
                read as a different code. */}
            <div className="flex items-baseline gap-2">
              <span className="text-foreground text-sm font-medium">
                {t('settings.project.sisterCompanies.dialog.codePreview')}
              </span>
              <span dir="ltr" className="text-muted-foreground font-mono text-sm">
                {kind === 'branch' && parentCode !== undefined ? `${parentCode}-##` : 'SIS-###'}
              </span>
            </div>
          </div>
        )}

        <div>
          <label htmlFor={nameId} className="text-foreground text-sm font-medium">
            {t('settings.project.sisterCompanies.dialog.name')}
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
                  ? 'settings.project.sisterCompanies.validation.required'
                  : 'settings.project.sisterCompanies.validation.tooShort',
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
            {t('settings.project.sisterCompanies.dialog.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className={`${MODAL_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy
              ? t('settings.project.sisterCompanies.dialog.saving')
              : t('settings.project.sisterCompanies.dialog.save')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export interface SisterCompanyDeleteDialogProps {
  readonly name: string;
  readonly code: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function SisterCompanyDeleteDialog({
  name,
  code,
  busy,
  onConfirm,
  onClose,
}: SisterCompanyDeleteDialogProps) {
  const { t } = useI18n();
  const titleId = useId();

  useEscapeKey(onClose, !busy);

  return (
    <ModalShell
      titleId={titleId}
      title={t('settings.project.sisterCompanies.delete.title')}
      closeLabel={t('settings.project.sisterCompanies.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
        {t('settings.project.sisterCompanies.delete.body', { name, code })}
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
        >
          {t('settings.project.sisterCompanies.dialog.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`${MODAL_BUTTON_CLASS} bg-destructive text-destructive-foreground`}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t('settings.project.sisterCompanies.delete.confirm')}
        </button>
      </div>
    </ModalShell>
  );
}
