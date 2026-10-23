/**
 * Temporary-password generator shared by the admin user-management Edge
 * Functions (`admin-invite-user`, `admin-set-password`).
 *
 * POLICY (fixed by product decision D4)
 * * 16 characters from [A-Za-z0-9].
 * * Lookalike characters are removed from the alphabet entirely, not merely
 *   avoided after the fact: `0`, `1`, `O`, `o`, `I`, `l`. A password that is
 *   read aloud or re-typed from a screenshot must survive that trip.
 *   Resulting alphabet: 8 digits + 24 upper + 24 lower = 56 symbols,
 *   so 56^16 ≈ 2^93 of entropy — far beyond what GoTrue or a brute-force
 *   attempt cares about, and the truncation is a readability trade, not a
 *   weakening.
 *
 * The value is generated here, written straight to GoTrue, returned once and
 * never stored anywhere — not in a table, not in audit metadata, not in a log.
 */

/** Deliberately excludes the lookalikes 0, 1, O, o, I, l. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';

export const TEMP_PASSWORD_LENGTH = 16;

/**
 * Draw `length` characters from {@link ALPHABET} using a CSPRNG.
 *
 * Rejection sampling rather than `byte % ALPHABET.length` over the full byte
 * range: 256 is not a multiple of 56, so a naive modulo would make the first
 * 32 symbols ~14% more likely than the rest. Bytes in the biased tail are
 * discarded and the buffer refilled.
 */
export function generateTempPassword(length: number = TEMP_PASSWORD_LENGTH): string {
  const usable = 256 - (256 % ALPHABET.length);
  let password = '';
  while (password.length < length) {
    const bytes = new Uint8Array(length * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= usable) {
        continue;
      }
      password += ALPHABET[byte % ALPHABET.length];
      if (password.length === length) {
        break;
      }
    }
  }
  return password;
}
