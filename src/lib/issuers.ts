/**
 * The issuer code: the two Latin letters printed before the letter number on a
 * paper letter (`YM` = ياسر).
 *
 * The register is a controlled list (`public.issuers`), not a free-text field —
 * the entry screen offers these codes in a dropdown and the database refuses a
 * letter code whose prefix is not an active row. So the rules live here, once,
 * for both screens: normalisation for the settings form, shape checking for the
 * entry field, and the label both screens render.
 *
 * Failures are value-free codes, never messages: the caller translates them.
 */

/** The database CHECK: exactly two ASCII letters. */
export const ISSUER_CODE_PATTERN = /^[A-Z]{2}$/;
export const ISSUER_CODE_LENGTH = 2;
/** `issuers_name_not_blank check (char_length(btrim(name)) between 1 and 120)`. */
export const ISSUER_NAME_MAX_LENGTH = 120;

/**
 * What the code field should hold while typing: at most two Latin letters, up
 * cased. Arabic letters and every other character are dropped, so a keyboard
 * left on Arabic produces nothing rather than a silently wrong code.
 */
export function normalizeIssuerCode(raw: string): string {
  let letters = '';
  for (const char of raw) {
    if (letters.length < ISSUER_CODE_LENGTH && /[A-Za-z]/.test(char)) {
      letters += char.toUpperCase();
    }
  }
  return letters;
}

export function isIssuerCode(value: string): boolean {
  return ISSUER_CODE_PATTERN.test(value);
}

export type IssuerNameFailure = 'tooLong';

export type IssuerNameValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: IssuerNameFailure };

/**
 * The name is optional in the UI but `issuers.name` is `not null` with a
 * 1..120 character check, so a blank name falls back to the code itself —
 * `YM — YM` would read badly, which is why `issuerLabel` prints the code alone
 * in that case. No migration, no nullable column, no invented placeholder.
 */
export function validateIssuerName(raw: string, code: string): IssuerNameValidation {
  const value = raw.trim();
  if ([...value].length > ISSUER_NAME_MAX_LENGTH) {
    return { ok: false, code: 'tooLong' };
  }
  return { ok: true, value: value === '' ? code : value };
}

/**
 * How an issuer reads in a list or a dropdown: `YM — ياسر`. When the name is
 * empty or is just the code (the optional-name fallback), the code is printed
 * once rather than twice.
 */
export function issuerLabel(issuer: { readonly code: string; readonly name: string }): string {
  const code = issuer.code.toUpperCase();
  const name = issuer.name.trim();
  if (name === '' || name.toUpperCase() === code) {
    return code;
  }
  return `${code} — ${name}`;
}
