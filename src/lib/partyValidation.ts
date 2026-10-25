import type { PartyPaymentTerms, PartyType } from '@/lib/database.types';
import { validateName } from '@/lib/nameValidation';

/**
 * The party-form rules, in one place.
 *
 * The dialog uses them for field-level feedback before anything is submitted;
 * the mutation layer (`usePartiesMutations`) re-checks every one of them
 * before a request can leave the client, so a future caller that skips the
 * dialog cannot smuggle an invalid row through. Each rule mirrors a database
 * constraint exactly (name CHECK aside, which the shared `validateName` keeps
 * one step stricter than `parties_name_not_blank`, as on every other
 * project-settings screen):
 *
 *   * email            → `parties_email_check` (the very same pattern);
 *   * credit_limit     → `parties_credit_limit_non_negative`, `numeric(18,2)`;
 *   * payment_terms    → one of 0 / 15 / 30 / 60 / 90 (`parties_payment_terms_check`);
 *   * credit fields on an internal party → refused by
 *     `parties_internal_no_credit_terms`; this module strips them for sister
 *     companies too, which is a UI rule the database deliberately leaves open.
 *
 * Mirroring rather than approximating matters: the inline error and the
 * database must never disagree about what is acceptable.
 */

export const PARTY_TYPES = [
  'supplier',
  'customer',
  'sister_company',
  'internal',
] as const satisfies readonly PartyType[];

export function isPartyType(value: unknown): value is PartyType {
  return (
    value === 'supplier' ||
    value === 'customer' ||
    value === 'sister_company' ||
    value === 'internal'
  );
}

/**
 * Only the two external commercial types carry credit terms: a supplier
 * extends us a purchasing limit, a customer receives a sales limit from us.
 * Sister companies and internal departments show no credit fields, and the
 * payload builders strip both values for them regardless of what a caller (or
 * leftover form state after a type switch) carries.
 */
export function supportsCreditTerms(type: PartyType): boolean {
  return type === 'supplier' || type === 'customer';
}

/** The `parties_payment_terms_check` set. `0` means "immediate"; absence is `null`. */
export const PAYMENT_TERMS_OPTIONS = [
  0, 15, 30, 60, 90,
] as const satisfies readonly PartyPaymentTerms[];

export function isPartyPaymentTerms(value: number): value is PartyPaymentTerms {
  return (PAYMENT_TERMS_OPTIONS as readonly number[]).includes(value);
}

/** The same accepted set as `parties_email_check`. */
export const PARTY_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/i;

export function isValidPartyEmail(email: string): boolean {
  return PARTY_EMAIL_PATTERN.test(email);
}

/**
 * `credit_limit` is `numeric(18, 2)`: the database rounds anything finer than
 * two decimals when it stores it. Round the same way here so the value the
 * user sees accepted is the value that actually lands in the column.
 */
export function roundCreditLimit(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** What the dialog holds while the user is typing: strings, `''` for "not set". */
export interface PartyFormRaw {
  /** `''` until the create dialog's one-time, irreversible choice is made. */
  readonly type: PartyType | '';
  readonly name: string;
  readonly taxNumber: string;
  readonly commercialRegister: string;
  readonly address: string;
  readonly contactPerson: string;
  readonly phone: string;
  readonly email: string;
  /** `''` (no limit recorded) or a non-negative decimal, as typed. */
  readonly creditLimit: string;
  /** `''` (unspecified) or one of `'0' | '15' | '30' | '60' | '90'`. */
  readonly paymentTerms: string;
}

/** Normalized form values: trimmed, with absent optionals collapsed to `null`. */
export interface PartyFormValues {
  readonly type: PartyType;
  readonly name: string;
  readonly taxNumber: string | null;
  readonly commercialRegister: string | null;
  readonly address: string | null;
  readonly contactPerson: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly creditLimit: number | null;
  readonly paymentTerms: PartyPaymentTerms | null;
}

export type PartyFormField = 'type' | 'name' | 'email' | 'creditLimit' | 'paymentTerms';

export type PartyFormErrorCode =
  'required' | 'tooShort' | 'invalidEmail' | 'invalidCreditLimit' | 'invalidPaymentTerms';

export type PartyFormErrors = Partial<Record<PartyFormField, PartyFormErrorCode>>;

export type PartyFormValidation =
  | { readonly ok: true; readonly value: PartyFormValues }
  | { readonly ok: false; readonly errors: PartyFormErrors };

function optionalText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate and normalize the raw form in one pass.
 *
 * The credit fields are read only when the chosen type carries them. For a
 * sister company or an internal party the raw strings are ignored entirely —
 * the fields are not rendered, and whatever is left in the form state after a
 * type switch in the create dialog must not leak into the payload (nor block
 * the submit with an error on a field the user can no longer see).
 */
export function validatePartyForm(raw: PartyFormRaw): PartyFormValidation {
  const errors: PartyFormErrors = {};

  const type = isPartyType(raw.type) ? raw.type : null;
  if (type === null) {
    errors.type = 'required';
  }

  const nameResult = validateName(raw.name);
  if (!nameResult.ok) {
    errors.name = nameResult.code;
  }

  let email = optionalText(raw.email);
  if (email !== null && !isValidPartyEmail(email)) {
    errors.email = 'invalidEmail';
    email = null;
  }

  let creditLimit: number | null = null;
  let paymentTerms: PartyPaymentTerms | null = null;
  if (type !== null && supportsCreditTerms(type)) {
    const creditRaw = raw.creditLimit.trim();
    if (creditRaw !== '') {
      const parsed = Number(creditRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        errors.creditLimit = 'invalidCreditLimit';
      } else {
        creditLimit = roundCreditLimit(parsed);
      }
    }

    const termsRaw = raw.paymentTerms.trim();
    if (termsRaw !== '') {
      const parsed = Number(termsRaw);
      if (!isPartyPaymentTerms(parsed)) {
        errors.paymentTerms = 'invalidPaymentTerms';
      } else {
        paymentTerms = parsed;
      }
    }
  }

  if (type === null || !nameResult.ok || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      type,
      name: nameResult.value,
      taxNumber: optionalText(raw.taxNumber),
      commercialRegister: optionalText(raw.commercialRegister),
      address: optionalText(raw.address),
      contactPerson: optionalText(raw.contactPerson),
      phone: optionalText(raw.phone),
      email,
      creditLimit,
      paymentTerms,
    },
  };
}
