import { describe, expect, it } from 'vitest';
import {
  amountToCents,
  formatAmount,
  formatCents,
  normalizeAmountText,
} from './fiscalSettingsUtils';

/**
 * Money plumbing for the fiscal screens.
 *
 * The invariant that matters is that nothing is ever parsed through `Number`:
 * a `numeric(18,2)` column can hold more precision than a double, and rounding
 * a balance silently is worse than rejecting it.
 */
describe('normalizeAmountText', () => {
  it('accepts up to 16 integer digits and 2 decimals', () => {
    expect(normalizeAmountText('0')).toBe('0.00');
    expect(normalizeAmountText('7.')).toBe('7.00');
    expect(normalizeAmountText('7.5')).toBe('7.50');
    expect(normalizeAmountText(' 125.50 ')).toBe('125.50');
    expect(normalizeAmountText('9999999999999999.99')).toBe('9999999999999999.99');
  });

  it('rejects negatives, three decimals, exponents and empty input', () => {
    expect(normalizeAmountText('-1')).toBeNull();
    expect(normalizeAmountText('1.234')).toBeNull();
    expect(normalizeAmountText('1e3')).toBeNull();
    expect(normalizeAmountText('')).toBeNull();
    expect(normalizeAmountText('١٢٣')).toBeNull();
    expect(normalizeAmountText('.5')).toBeNull();
    expect(normalizeAmountText('10000000000000000')).toBeNull();
  });
});

describe('amountToCents', () => {
  it('converts without floating point drift', () => {
    expect(amountToCents('0.1')).toBe(10n);
    expect(amountToCents('125.50')).toBe(12550n);
    expect(amountToCents(125.5)).toBe(12550n);
    expect(amountToCents(1.005)).toBeNull();
  });

  it('returns null for anything the form cannot send', () => {
    expect(amountToCents('')).toBeNull();
    expect(amountToCents('abc')).toBeNull();
    expect(amountToCents(-5)).toBeNull();
  });
});

describe('formatCents', () => {
  it('groups thousands and keeps two decimals', () => {
    expect(formatCents(0n, 'en')).toBe('0.00');
    expect(formatCents(12550n, 'en')).toBe('125.50');
    expect(formatCents(32500050n, 'en')).toBe('325,000.50');
  });

  it('uses Latin digits in Arabic too, so fields and totals agree', () => {
    /* The amount field is a `type="number"` input; switching numeral systems
       between the field and the total above it would read as a bug. */
    expect(formatCents(32500050n, 'ar')).toBe('325,000.50');
    expect(formatCents(12550n, 'ar')).toBe('125.50');
  });

  it('keeps the sign out of the way — balances are never negative', () => {
    expect(formatCents(1n, 'en')).toBe('0.01');
  });
});

describe('formatAmount', () => {
  it('formats a stored numeric or falls back to zero', () => {
    expect(formatAmount('125.5', 'en')).toBe('125.50');
    expect(formatAmount(52500, 'en')).toBe('52,500.00');
    expect(formatAmount('broken', 'en')).toBe('0.00');
  });
});
