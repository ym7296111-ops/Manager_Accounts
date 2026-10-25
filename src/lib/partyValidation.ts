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
 *   * email          → `parties_email_check` (the very same pattern);
 *   * credit_limit   → `parties_credit_limit_non_negative`, `numeric(18,2)`;
 *   * payment_terms  → one of 0 / 15 / 30 / 60 / 90 (`parties_payment_terms_check`).
 *
 * Mirroring rather than approximating matters: the inline error and the
 * database must never disagree about what is acceptable.
 *
 * Since 20261108000000 the type set is exactly the two supplier kinds plus
 * `customer`: `internal` is retired, and sister companies are their own tree
 * (`sister_companies`), not a party type. Credit terms are therefore available
 * on every type the form can produce.
 */

export const PARTY_TYPES = [
  'local_supplier',
  'foreign_supplier',
  'customer',
] as const satisfies readonly PartyType[];

/** What the inbound sub-tab offers: local and foreign suppliers. */
export const INBOUND_PARTY_TYPES = [
  'local_supplier',
  'foreign_supplier',
] as const satisfies readonly PartyType[];

/** What the outbound sub-tab offers: customers only, with no local/foreign split. */
export const OUTBOUND_PARTY_TYPES = ['customer'] as const satisfies readonly PartyType[];

/** The two halves the directory screen is split into. */
export type PartyScope = 'inbound' | 'outbound';

/** The types a scope may create, in the order its select offers them. */
export function partyTypesForScope(scope: PartyScope): readonly PartyType[] {
  return scope === 'inbound' ? INBOUND_PARTY_TYPES : OUTBOUND_PARTY_TYPES;
}

export function isPartyType(value: unknown): value is PartyType {
  return value === 'local_supplier' || value === 'foreign_supplier' || value === 'customer';
}

/** True for the types the inbound sub-tab lists (both supplier kinds). */
export function isInboundPartyType(type: PartyType): boolean {
  return type === 'local_supplier' || type === 'foreign_supplier';
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
 * A type outside `allowedTypes` (when the caller passes the current sub-tab's
 * set) is treated exactly like an unchosen one: the create dialog must not be
 * able to mint a code from the other tab's sequence, even if its select was
 * tampered with.
 */
export function validatePartyForm(
  raw: PartyFormRaw,
  allowedTypes: readonly PartyType[] = PARTY_TYPES,
): PartyFormValidation {
  const errors: PartyFormErrors = {};

  const type = isPartyType(raw.type) && allowedTypes.includes(raw.type) ? raw.type : null;
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
  const creditRaw = raw.creditLimit.trim();
  if (creditRaw !== '') {
    const parsed = Number(creditRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.creditLimit = 'invalidCreditLimit';
    } else {
      creditLimit = roundCreditLimit(parsed);
    }
  }

  let paymentTerms: PartyPaymentTerms | null = null;
  const termsRaw = raw.paymentTerms.trim();
  if (termsRaw !== '') {
    const parsed = Number(termsRaw);
    if (!isPartyPaymentTerms(parsed)) {
      errors.paymentTerms = 'invalidPaymentTerms';
    } else {
      paymentTerms = parsed;
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
