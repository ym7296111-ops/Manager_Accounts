/**
 * Email shape check shared by the login, forgot-password and profile forms.
 *
 * Deliberately permissive (it only rejects whitespace, a missing `@` or a
 * missing dotted domain): the authoritative verification always happens in
 * Supabase, this exists to fail fast with a translatable message.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when `value` looks like a deliverable address. */
export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}
