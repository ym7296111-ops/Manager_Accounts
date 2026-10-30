import { describe, expect, it } from 'vitest';
import {
  ISSUER_NAME_MAX_LENGTH,
  isIssuerCode,
  issuerLabel,
  normalizeIssuerCode,
  validateIssuerName,
} from '@/lib/issuers';

describe('issuer code', () => {
  it('keeps two Latin letters, up-cased, and drops everything else', () => {
    expect(normalizeIssuerCode('ym')).toBe('YM');
    expect(normalizeIssuerCode(' Y M ')).toBe('YM');
    expect(normalizeIssuerCode('yml')).toBe('YM');
    // Arabic letters and digits never reach the field.
    expect(normalizeIssuerCode('يم')).toBe('');
    expect(normalizeIssuerCode('Y1M')).toBe('YM');
    expect(normalizeIssuerCode('63')).toBe('');
  });

  it('accepts exactly two upper-case Latin letters, which is the database CHECK', () => {
    expect(isIssuerCode('YM')).toBe(true);
    expect(isIssuerCode('AA')).toBe(true);
    expect(isIssuerCode('Y')).toBe(false);
    expect(isIssuerCode('YMM')).toBe(false);
    expect(isIssuerCode('YM:')).toBe(false);
    expect(isIssuerCode('يم')).toBe(false);
  });
});

describe('issuer name', () => {
  it('is optional: a blank name falls back to the code the not-null column needs', () => {
    expect(validateIssuerName('', 'YM')).toEqual({ ok: true, value: 'YM' });
    expect(validateIssuerName('   ', 'YM')).toEqual({ ok: true, value: 'YM' });
    expect(validateIssuerName('  ياسر  ', 'YM')).toEqual({ ok: true, value: 'ياسر' });
  });

  it('refuses a name longer than the 120 characters the column allows', () => {
    const long = 'ي'.repeat(ISSUER_NAME_MAX_LENGTH + 1);
    expect(validateIssuerName(long, 'YM')).toEqual({ ok: false, code: 'tooLong' });
    expect(validateIssuerName('ي'.repeat(ISSUER_NAME_MAX_LENGTH), 'YM').ok).toBe(true);
  });
});

describe('issuerLabel', () => {
  it('prints `code — name`, and the code alone when there is no separate name', () => {
    expect(issuerLabel({ code: 'YM', name: 'ياسر' })).toBe('YM — ياسر');
    expect(issuerLabel({ code: 'ym', name: 'ياسر' })).toBe('YM — ياسر');
    expect(issuerLabel({ code: 'AB', name: 'AB' })).toBe('AB');
    expect(issuerLabel({ code: 'AB', name: '  ' })).toBe('AB');
  });
});
