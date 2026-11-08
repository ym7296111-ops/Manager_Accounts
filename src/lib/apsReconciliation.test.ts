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
    expect(() => parseReconciliationState({}, 'month', 0, 'scope')).toThrow();
  });
});

describe('v2 read contract', () => {
  const m = () => ({
    book_inbound: '0.00',
    book_outbound: '0.00',
    accountant_inbound: null,
    accountant_outbound: null,
    book_balance: '0.00',
    accountant_balance: null,
    inbound_difference: null,
    outbound_difference: null,
    balance_difference: null,
  });
  const payload = () => ({
    current_config_revision_id: 'revision',
    historical_overlap: false,
    fiscal_month: { id: 'month', is_active: true, is_fiscal_closed: false },
    selected_session: {
      id: 'session',
      scope_id: 'scope',
      scope_name_snapshot: 'Scope',
      source_config_revision_id: 'revision',
      config_generation: '1',
      status: 'open',
      flow_type: 'screen_v2',
      settings_revision_id: 'revision',
      needs_review: false,
      review_reason: null,
      sequence_number: 1,
      snapshot_version: '1234567890123456789',
    },
    selected_lines: [
      {
        id: 'line',
        classification_id: 'class',
        classification_name: 'class',
        version: '1234567890123456789',
        monthly: m(),
        ytd: {
          ...m(),
          book_opening: null,
          accountant_opening: null,
          accountant_opening_source: 'missing',
        },
      },
    ],
    month_summary: {
      open_sessions_count: 1,
      closed_sessions_count: 0,
      missing_system_opening_count: 1,
    },
    pagination: { offset: 0, limit: 50, has_more: false },
    flags: {
      can_close_now: false,
      close_blocked_reason: 'missing_system_opening',
      settings_changed: null,
      can_sync_from_settings: false,
    },
  });
  it('retains decimal text, null, and bigint versions as strings', () => {
    const result = parseReconciliationState(payload(), 'month', 0, 'scope');
    expect(result.selected_lines[0]?.ytd.book_opening).toBeNull();
    expect(result.selected_lines[0]?.monthly.book_inbound).toBe('0.00');
    expect(result.selected_lines[0]?.version).toBe('1234567890123456789');
  });
  it('rejects JSON numeric financial values instead of rounding them', () => {
    const value = payload();
    const line = value.selected_lines[0]!;
    (line.monthly as { book_inbound: unknown }).book_inbound = 1;
    expect(() => parseReconciliationState(value, 'month', 0, 'scope')).toThrow('invalidResponse');
  });
});
