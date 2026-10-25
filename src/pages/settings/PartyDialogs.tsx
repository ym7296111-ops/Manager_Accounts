import { Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, MODAL_FIELD_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import type { Party } from '@/hooks/useParties';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import type { PartyType } from '@/lib/database.types';
import {
  PARTY_TYPES,
  PAYMENT_TERMS_OPTIONS,
  isPartyType,
  supportsCreditTerms,
  validatePartyForm,
  type PartyFormErrorCode,
  type PartyFormErrors,
  type PartyFormField,
  type PartyFormRaw,
  type PartyFormValues,
} from '@/lib/partyValidation';

/**
 * Dialogs for the parties write path.
 *
 * The two identity columns are handled with the same discipline as the codes
 * on the stations and classifications screens, plus one step further:
 *
 * * `code` never appears as a field. It is minted server-side from a per-type
 *   sequence, so on create there is nothing to type, and on edit it renders as
 *   plain text.
 * * `type` is chosen exactly once. On create it is a required select that
 *   starts unchosen — defaulting it would risk minting a code from the wrong
 *   sequence, and the type can never be corrected afterwards. On edit it
 *   renders as plain text next to the code; the submit path
 *   (`usePartiesMutations`) has no branch that could send either column.
 *
 * The credit fields render only for suppliers and customers. Switching the
 * type in the create dialog hides them again, and `validatePartyForm` ignores
 * whatever they still hold, so leftover values cannot ride into a sister
 * company or an internal party.
 */

const TYPE_LABEL_KEY: Record<PartyType, TranslationKey> = {
  supplier: 'settings.project.parties.type.supplier',
  customer: 'settings.project.parties.type.customer',
  sister_company: 'settings.project.parties.type.sisterCompany',
  internal: 'settings.project.parties.type.internal',
};

/** One message per (field, code): a missing type and a missing name differ. */
function errorKeyFor(field: PartyFormField, code: PartyFormErrorCode): TranslationKey {
  if (field === 'type') {
    return 'settings.project.parties.validation.typeRequired';
  }
  if (field === 'name') {
    return code === 'required'
      ? 'settings.project.parties.validation.required'
      : 'settings.project.parties.validation.tooShort';
  }
  if (field === 'email') {
    return 'settings.project.parties.validation.invalidEmail';
  }
  if (field === 'creditLimit') {
    return 'settings.project.parties.validation.invalidCreditLimit';
  }
  return 'settings.project.parties.validation.invalidPaymentTerms';
}

const EMPTY_FORM: PartyFormRaw = {
  type: '',
  name: '',
  taxNumber: '',
  commercialRegister: '',
  address: '',
  contactPerson: '',
  phone: '',
  email: '',
  creditLimit: '',
  paymentTerms: '',
};

/** The edit dialog's starting point: the stored row, stringified for inputs. */
function partyToRaw(party: Party): PartyFormRaw {
  return {
    type: party.type,
    name: party.name,
    taxNumber: party.taxNumber ?? '',
    commercialRegister: party.commercialRegister ?? '',
    address: party.address ?? '',
    contactPerson: party.contactPerson ?? '',
    phone: party.phone ?? '',
    email: party.email ?? '',
    creditLimit: party.creditLimit === null ? '' : String(party.creditLimit),
    paymentTerms: party.paymentTerms === null ? '' : String(party.paymentTerms),
  };
}

/**
 * One labelled text input with its inline error. These are a counterparty's
 * details, not the signed-in user's, so every field opts out of autofill.
 */
function TextField({
  id,
  label,
  value,
  onChange,
  disabled,
  error,
  inputType = 'text',
  inputMode,
  dir,
  inputRef,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly error?: string;
  readonly inputType?: string;
  readonly inputMode?: 'decimal' | 'email' | 'tel';
  readonly dir?: 'ltr';
  readonly inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-foreground text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        type={inputType}
        inputMode={inputMode}
        dir={dir}
        value={value}
        disabled={disabled}
        autoComplete="off"
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={MODAL_FIELD_CLASS}
      />
      {error !== undefined ? (
        <p id={`${id}-error`} role="alert" className="text-destructive mt-1.5 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface PartyFormDialogProps {
  readonly mode: 'create' | 'edit';
  /** Edit only: the row being edited. Its type and code render read-only. */
  readonly initialParty?: Party;
  readonly busy: boolean;
  readonly onSubmit: (values: PartyFormValues) => void;
  readonly onClose: () => void;
}

export function PartyFormDialog({
  mode,
  initialParty,
  busy,
  onSubmit,
  onClose,
}: PartyFormDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const typeId = useId();
  const nameId = useId();
  const taxNumberId = useId();
  const commercialRegisterId = useId();
  const addressId = useId();
  const contactPersonId = useId();
  const phoneId = useId();
  const emailId = useId();
  const creditLimitId = useId();
  const paymentTermsId = useId();
  const typeRef = useRef<HTMLSelectElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const [raw, setRaw] = useState<PartyFormRaw>(() =>
    mode === 'edit' && initialParty !== undefined ? partyToRaw(initialParty) : EMPTY_FORM,
  );
  const [errors, setErrors] = useState<PartyFormErrors>({});

  useEscapeKey(onClose, !busy);

  useEffect(() => {
    if (mode === 'create') {
      typeRef.current?.focus();
    } else {
      nameRef.current?.focus();
    }
  }, [mode]);

  const effectiveType: PartyType | null =
    mode === 'edit' && initialParty !== undefined
      ? initialParty.type
      : isPartyType(raw.type)
        ? raw.type
        : null;
  const showCreditTerms = effectiveType !== null && supportsCreditTerms(effectiveType);

  function errorText(field: PartyFormField): string | undefined {
    const code = errors[field];
    return code === undefined ? undefined : t(errorKeyFor(field, code));
  }

  function handleTypeChange(value: string) {
    const nextType: PartyType | '' = isPartyType(value) ? value : '';
    setRaw((current) => ({ ...current, type: nextType }));
    setErrors((current) => {
      const next: PartyFormErrors = { ...current };
      delete next.type;
      /* A type without credit terms unmounts both fields; an error left
         behind for an invisible field would reappear if the user switched
         back, long after the value that caused it. */
      if (nextType === '' || !supportsCreditTerms(nextType)) {
        delete next.creditLimit;
        delete next.paymentTerms;
      }
      return next;
    });
  }

  function handleFieldChange(field: Exclude<keyof PartyFormRaw, 'type'>, value: string) {
    setRaw((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!(field in current)) {
        return current;
      }
      const next: PartyFormErrors = { ...current };
      delete next[field as PartyFormField];
      return next;
    });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validatePartyForm(raw);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSubmit(result.value);
  }

  const typeError = errorText('type');

  return (
    <ModalShell
      titleId={titleId}
      title={t(
        mode === 'create'
          ? 'settings.project.parties.dialog.add'
          : 'settings.project.parties.dialog.edit',
      )}
      closeLabel={t('settings.project.parties.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      {/* noValidate: the localized, field-level errors below mirror the
          database's own rules (the email CHECK is not the browser's grammar),
          and native bubbles would pre-empt them before submit ever fires. */}
      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
        {mode === 'create' ? (
          <div>
            <label htmlFor={typeId} className="text-foreground text-sm font-medium">
              {t('settings.project.parties.dialog.type')}
            </label>
            <select
              id={typeId}
              ref={typeRef}
              value={raw.type}
              disabled={busy}
              aria-invalid={typeError !== undefined}
              aria-describedby={typeError !== undefined ? `${typeId}-error` : `${typeId}-hint`}
              onChange={(event) => handleTypeChange(event.target.value)}
              className={MODAL_FIELD_CLASS}
            >
              <option value="">{t('settings.project.parties.dialog.typePlaceholder')}</option>
              {PARTY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(TYPE_LABEL_KEY[type])}
                </option>
              ))}
            </select>
            {typeError !== undefined ? (
              <p id={`${typeId}-error`} role="alert" className="text-destructive mt-1.5 text-xs">
                {typeError}
              </p>
            ) : (
              <p id={`${typeId}-hint`} className="text-muted-foreground mt-1.5 text-xs">
                {t('settings.project.parties.dialog.typeHint')}
              </p>
            )}
          </div>
        ) : initialParty !== undefined ? (
          /* Edit: the identity is information, not input. Neither value is a
             form control, so nothing here can be submitted back. */
          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-foreground block text-sm font-medium">
                  {t('settings.project.parties.dialog.type')}
                </span>
                <p className="text-muted-foreground mt-1 text-sm">
                  {t(TYPE_LABEL_KEY[initialParty.type])}
                </p>
              </div>
              <div>
                <span className="text-foreground block text-sm font-medium">
                  {t('settings.project.parties.dialog.code')}
                </span>
                <p className="text-muted-foreground mt-1 font-mono text-sm">{initialParty.code}</p>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              {t('settings.project.parties.dialog.immutable')}
            </p>
          </div>
        ) : null}

        <TextField
          id={nameId}
          label={t('settings.project.parties.dialog.name')}
          value={raw.name}
          onChange={(value) => handleFieldChange('name', value)}
          disabled={busy}
          error={errorText('name')}
          inputRef={nameRef}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id={taxNumberId}
            label={t('settings.project.parties.dialog.taxNumber')}
            value={raw.taxNumber}
            onChange={(value) => handleFieldChange('taxNumber', value)}
            disabled={busy}
            dir="ltr"
          />
          <TextField
            id={commercialRegisterId}
            label={t('settings.project.parties.dialog.commercialRegister')}
            value={raw.commercialRegister}
            onChange={(value) => handleFieldChange('commercialRegister', value)}
            disabled={busy}
            dir="ltr"
          />
        </div>

        <div>
          <label htmlFor={addressId} className="text-foreground text-sm font-medium">
            {t('settings.project.parties.dialog.address')}
          </label>
          <textarea
            id={addressId}
            rows={2}
            value={raw.address}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => handleFieldChange('address', event.target.value)}
            className={MODAL_FIELD_CLASS}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id={contactPersonId}
            label={t('settings.project.parties.dialog.contactPerson')}
            value={raw.contactPerson}
            onChange={(value) => handleFieldChange('contactPerson', value)}
            disabled={busy}
          />
          <TextField
            id={phoneId}
            label={t('settings.project.parties.dialog.phone')}
            value={raw.phone}
            onChange={(value) => handleFieldChange('phone', value)}
            disabled={busy}
            inputType="tel"
            inputMode="tel"
            dir="ltr"
          />
        </div>

        <TextField
          id={emailId}
          label={t('settings.project.parties.dialog.email')}
          value={raw.email}
          onChange={(value) => handleFieldChange('email', value)}
          disabled={busy}
          error={errorText('email')}
          inputType="email"
          inputMode="email"
          dir="ltr"
        />

        {/* Credit terms exist only across a legal-entity boundary: a supplier
            grants us a purchasing limit, a customer receives one from us.
            Sister companies and internal parties render neither field, and
            the mutation strips both values for them again at the wire. */}
        {showCreditTerms && effectiveType !== null ? (
          <div className="space-y-1.5">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={creditLimitId}
                label={t('settings.project.parties.dialog.creditLimit')}
                value={raw.creditLimit}
                onChange={(value) => handleFieldChange('creditLimit', value)}
                disabled={busy}
                error={errorText('creditLimit')}
                inputType="number"
                inputMode="decimal"
                dir="ltr"
              />
              <div>
                <label htmlFor={paymentTermsId} className="text-foreground text-sm font-medium">
                  {t('settings.project.parties.dialog.paymentTerms')}
                </label>
                <select
                  id={paymentTermsId}
                  value={raw.paymentTerms}
                  disabled={busy}
                  aria-invalid={errorText('paymentTerms') !== undefined}
                  aria-describedby={
                    errorText('paymentTerms') !== undefined ? `${paymentTermsId}-error` : undefined
                  }
                  onChange={(event) => handleFieldChange('paymentTerms', event.target.value)}
                  className={MODAL_FIELD_CLASS}
                >
                  <option value="">{t('settings.project.parties.paymentTerms.none')}</option>
                  {/* 0 is a real term ("on receipt"), not the empty choice. */}
                  <option value="0">{t('settings.project.parties.paymentTerms.immediate')}</option>
                  {PAYMENT_TERMS_OPTIONS.filter((days) => days !== 0).map((days) => (
                    <option key={days} value={String(days)}>
                      {t('settings.project.parties.paymentTerms.days', { days })}
                    </option>
                  ))}
                </select>
                {errorText('paymentTerms') !== undefined ? (
                  <p
                    id={`${paymentTermsId}-error`}
                    role="alert"
                    className="text-destructive mt-1.5 text-xs"
                  >
                    {errorText('paymentTerms')}
                  </p>
                ) : null}
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              {t(
                effectiveType === 'supplier'
                  ? 'settings.project.parties.dialog.creditSupplierHint'
                  : 'settings.project.parties.dialog.creditCustomerHint',
              )}
            </p>
          </div>
        ) : null}

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
