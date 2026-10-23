import type { TranslationKey } from '@/i18n/locales/ar';

/**
 * The single password policy of the product (Phase 1).
 *
 * * **Length only**: 8 characters or more. Every other aspect of the password
 *   (uppercase, digits, symbols, script, spaces) is left entirely to the user —
 *   the policy never rejects a character class on its own.
 * * One implementation, three consumers (change password, forgot password,
 *   reset password) so a rule can never drift between screens.
 * * Errors are **translation keys**, never prose: the caller renders them with
 *   `t(key)` and the dictionary stays the only place holding user-facing text.
 */

/** The policy itself — the single tunable of this module. */
export const PASSWORD_POLICY = Object.freeze({
  minLength: 8,
});

/** Every violation this module can report, as a translation key. */
export type PasswordErrorKey =
  'password.error.required' | 'password.error.tooShort' | 'password.error.mismatch';

/**
 * Compile-time guarantee that the reported keys really exist in the Arabic
 * dictionary (the source of truth for `TranslationKey`).
 */
const REPORTED_KEYS = [
  'password.error.required',
  'password.error.tooShort',
  'password.error.mismatch',
] as const satisfies readonly TranslationKey[];

/** Exposed for exhaustive iteration (e.g. rendering a policy checklist). */
export const PASSWORD_ERROR_KEYS: readonly PasswordErrorKey[] = REPORTED_KEYS;

/** Result shape shared by every password form: the verdict plus its reasons. */
export interface PasswordValidationResult {
  /** True when the password satisfies the policy and matches its confirmation. */
  valid: boolean;
  /** Translation keys of every violated rule, in reporting order. */
  errors: PasswordErrorKey[];
}

export interface ValidatePasswordOptions {
  /**
   * Confirmation field value. When provided it must equal the password;
   * omit it (or leave `undefined`) for single-field forms.
   */
  confirm?: string;
}

/**
 * Validate a password (and optionally its confirmation) against the policy.
 *
 * Empty input reports `password.error.required` rather than a length error,
 * so the form can distinguish "you forgot to type" from "too short".
 */
export function validatePassword(
  password: string,
  options: ValidatePasswordOptions = {},
): PasswordValidationResult {
  const errors: PasswordErrorKey[] = [];

  if (password.length === 0) {
    errors.push('password.error.required');
  } else if (password.length < PASSWORD_POLICY.minLength) {
    errors.push('password.error.tooShort');
  }

  const { confirm } = options;
  if (confirm !== undefined && confirm !== password) {
    errors.push('password.error.mismatch');
  }

  return { valid: errors.length === 0, errors };
}
