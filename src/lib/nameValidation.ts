/**
 * The one name rule for project-settings master data.
 *
 * Stations, warehouses and the three classification levels all validate a
 * display name identically: trim first, then require content, then require a
 * minimum length. It lives here rather than in a hook so the rule can be shared
 * without importing a mutation module (and its Supabase dependency) into the
 * other directory's code.
 *
 * The outcome is a value-free failure code, never a message: the caller
 * translates it, and an invalid name must not reach the database at all.
 */

/** Mirrors the Arabic/English copy requirement: a name is at least 2 characters. */
export const MIN_NAME_LENGTH = 2;

export type NameValidationFailure = 'required' | 'tooShort';

export type NameValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: NameValidationFailure };

/** Trim first, then require content, then require the minimum length. */
export function validateName(raw: string): NameValidation {
  const value = raw.trim();
  if (value === '') {
    return { ok: false, code: 'required' };
  }
  /* Count code points, not UTF-16 units: an emoji or an Arabic ligature is one
     character to the person typing it. */
  if ([...value].length < MIN_NAME_LENGTH) {
    return { ok: false, code: 'tooShort' };
  }
  return { ok: true, value };
}
