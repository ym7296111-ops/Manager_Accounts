import type { PartyBranch } from '@/lib/database.types';
import { validateName } from '@/lib/nameValidation';

/**
 * The party-form rules, in one place.
 *
 * A party is a name under one of the tree's two roots — «جهات الوارد»
 * (`inbound`) or «أغراض الصرف» (`outbound`). That is the whole form: the
 * commercial profile the directory used to carry (tax number, commercial
 * register, address, contact person, phone, email, credit limit, payment
 * terms) was retired in 20261109000000, and nothing here may reintroduce it.
 *
 * The dialog uses these rules for inline feedback before anything is submitted;
 * `usePartiesMutations` re-checks each one before a request can leave the
 * client, so a caller that skips the dialog cannot smuggle an invalid row
 * through:
 *
 *   * branch  → one of the two roots (`parties_branch_check`);
 *   * name    → the shared `validateName`, one step stricter than
 *               `parties_name_not_blank`, as on every other project-settings
 *               screen.
 *
 * `code` is never a form field and never leaves the client: the SECURITY
 * DEFINER trigger mints `IN-###` or `OUT-###` from the branch's own sequence.
 */

/** The two roots, in the order the tree renders them. */
export const PARTY_BRANCHES = ['inbound', 'outbound'] as const satisfies readonly PartyBranch[];

export function isPartyBranch(value: unknown): value is PartyBranch {
  return value === 'inbound' || value === 'outbound';
}

/** What the dialog holds while the user is typing. */
export interface PartyFormRaw {
  readonly name: string;
}

export type PartyFormField = 'name';

export type PartyFormErrorCode = 'required' | 'tooShort';

export type PartyFormErrors = Partial<Record<PartyFormField, PartyFormErrorCode>>;

export interface PartyFormValues {
  readonly name: string;
}

export type PartyFormValidation =
  | { readonly ok: true; readonly value: PartyFormValues }
  | { readonly ok: false; readonly errors: PartyFormErrors };

/**
 * Validate and normalize the raw form in one pass. `allowedBranches` lets a
 * caller pin the form to a single root (the tree's "add" button passes the
 * root it was opened from), so a tampered form cannot mint a code from the
 * other branch's sequence.
 */
export function validatePartyForm(
  raw: PartyFormRaw,
  branch: PartyBranch,
  allowedBranches: readonly PartyBranch[] = PARTY_BRANCHES,
): PartyFormValidation {
  const errors: PartyFormErrors = {};

  if (!isPartyBranch(branch) || !allowedBranches.includes(branch)) {
    /* The branch is never user-editable, so this is a programming error rather
       than something to show inline. Fail closed: no request, no code. */
    throw new Error('partyValidation: branch outside the allowed set');
  }

  const nameResult = validateName(raw.name);
  if (!nameResult.ok) {
    errors.name = nameResult.code;
  }

  if (!nameResult.ok) {
    return { ok: false, errors };
  }

  return { ok: true, value: { name: nameResult.value } };
}
