import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY, validatePassword } from '@/lib/validatePassword';

/**
 * The password policy is deliberately length-only: these tests pin both the
 * "too short" rejection and the user's freedom to choose any characters.
 */
describe('validatePassword (Phase 1 policy)', () => {
  it('publishes an 8 character minimum', () => {
    expect(PASSWORD_POLICY.minLength).toBe(8);
  });

  it('reports an empty password as missing, not as too short', () => {
    expect(validatePassword('')).toEqual({
      valid: false,
      errors: ['password.error.required'],
    });
  });

  it.each([1, 4, 7])('rejects a %i character password', (length) => {
    const result = validatePassword('a'.repeat(length));

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['password.error.tooShort']);
  });

  it('accepts a password of exactly the minimum length', () => {
    expect(validatePassword('12345678')).toEqual({ valid: true, errors: [] });
  });

  it('accepts a long password without complaining', () => {
    const result = validatePassword('a'.repeat(200));

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  /* The policy imposes no character class: only the length matters. */
  it.each([
    'lowercase',
    'ALLUPPER',
    '12345678',
    '!!!!!!!!',
    '  spaces  ',
    'كلمة-عربية-٨',
    'MiXeD-123-@#$%^&*()',
    '\t\t\t\t\t\t\t\t',
  ])('leaves the character choice of "%s" entirely to the user', (password) => {
    expect(validatePassword(password)).toEqual({ valid: true, errors: [] });
  });

  it('does not trim the password before measuring it', () => {
    expect(validatePassword('   a    ').valid).toBe(true);
    expect(validatePassword(' a b c ').valid).toBe(false);
  });

  it('reports a mismatch when the confirmation differs', () => {
    const result = validatePassword('supersecret', { confirm: 'supersecret2' });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['password.error.mismatch']);
  });

  it('reports length and mismatch together', () => {
    const result = validatePassword('short', { confirm: 'longer-one' });

    expect(result.errors).toEqual(['password.error.tooShort', 'password.error.mismatch']);
  });

  it('accepts a matching confirmation', () => {
    expect(validatePassword('supersecret', { confirm: 'supersecret' })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('ignores the confirmation when none is provided', () => {
    expect(validatePassword('supersecret').valid).toBe(true);
  });
});
