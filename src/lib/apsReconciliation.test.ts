import { describe, expect, it } from 'vitest';
import {
  formatReconciliationAmount,
  normalizeReconciliationAmount,
  parseReconciliationState,
} from './apsReconciliation';

describe('reconciliation financial values', () => {
  it('normalizes decimal text without floating point rounding', () => {
    expect(normalizeReconciliationAmount('9999999999999999.99')).toBe('9999999999999999.99');
    expect(normalizeReconciliationAmount('0001.2')).toBe('1.20');
    for (const value of ['-1', '1.234', 'NaN', '1e3', '10000000000000000', ''])
      expect(normalizeReconciliationAmount(value)).toBeNull();
  });
  it('formats signed values without precision loss', () => {
    expect(formatReconciliationAmount('-9999999999999999.99', 'en')).toBe(
      '-9,999,999,999,999,999.99',
    );
  });
  it('rejects malformed server data rather than treating it as empty', () => {
    expect(() => parseReconciliationState({}, 'month', 0)).toThrow();
  });
});
