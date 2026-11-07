import type { Locale } from '@/i18n/I18nContext';

export const APS_RECONCILIATION_PATH = '/workspaces/aps/reconciliation';
export const APS_RECONCILIATION_REQUIREMENT = [
  'aps.reconciliation:manage',
  'aps.reconciliation:close_month',
  'aps.reconciliation:reopen_month',
] as const;
export const RECONCILIATION_PAGE_SIZE = 50;

export interface MonthOption {
  id: string;
  label: string;
  is_active: boolean;
  is_fiscal_closed: boolean;
}
export interface StationOption {
  id: string;
  label: string;
}
export interface ReconciliationOptions {
  months: MonthOption[];
  stations: StationOption[];
  can_manage: boolean;
  can_close: boolean;
  can_reopen_as_owner: boolean;
}
export interface ReconciliationSession {
  id: string;
  status: 'open' | 'closed' | 'approved' | 'cancelled';
  flow_type: 'screen' | 'legacy';
  has_legacy_items: boolean;
  sequence_number: number;
}
export interface ReconciliationLine {
  id: string;
  classification_id: string;
  classification_name: string;
  book_amount: string;
  accountant_amount: string;
  difference: string;
}
export interface MonthSummary {
  open_sessions_count: number;
  eligible_open_screen_sessions: number;
  eligible_open_stations_count: number;
  eligible_closed_screen_sessions: number;
  total_stations_with_sessions: number;
  stations_with_nonzero_difference: {
    station_id: string;
    station_name: string;
    total_difference: string;
  }[];
  total_month_difference: string;
}
export interface ReconciliationState {
  fiscal_month: { id: string; is_active: boolean; is_fiscal_closed: boolean };
  selected_session: ReconciliationSession | null;
  selected_lines: ReconciliationLine[];
  month_summary: MonthSummary;
  pagination: { offset: number; limit: number; has_more: boolean };
  flags: {
    can_close_now: boolean;
    close_blocked_reason: 'no_eligible_open_sessions' | 'nonzero_differences' | null;
  };
}

export class ReconciliationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function invalid(): never {
  throw new ReconciliationError('invalidResponse');
}
function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}
function str(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : invalid();
}
function bool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid();
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid();
}
function money(value: unknown): string {
  return typeof value === 'string' && /^-?\d+\.\d{2}$/.test(value) ? value : invalid();
}

export function parseReconciliationOptions(value: unknown): ReconciliationOptions {
  const o = obj(value);
  const months = list(o.months).map((v) => {
    const m = obj(v);
    return {
      id: str(m.id),
      label: str(m.label),
      is_active: bool(m.is_active),
      is_fiscal_closed: bool(m.is_fiscal_closed),
    };
  });
  const stations = list(o.stations).map((v) => {
    const s = obj(v);
    return { id: str(s.id), label: str(s.label) };
  });
  if (
    new Set(months.map((m) => m.id)).size !== months.length ||
    new Set(stations.map((s) => s.id)).size !== stations.length
  )
    invalid();
  return {
    months,
    stations,
    can_manage: bool(o.can_manage),
    can_close: bool(o.can_close),
    can_reopen_as_owner: bool(o.can_reopen_as_owner),
  };
}
export function parseReconciliationState(
  value: unknown,
  monthId: string,
  offset: number,
): ReconciliationState {
  const r = obj(value);
  const month = obj(r.fiscal_month);
  const p = obj(r.pagination);
  const f = obj(r.flags);
  const s = obj(r.month_summary);
  if (
    str(month.id) !== monthId ||
    count(p.offset) !== offset ||
    count(p.limit) !== RECONCILIATION_PAGE_SIZE
  )
    invalid();
  let session: ReconciliationSession | null = null;
  if (r.selected_session !== null) {
    const x = obj(r.selected_session);
    if (
      x.status !== 'open' &&
      x.status !== 'closed' &&
      x.status !== 'approved' &&
      x.status !== 'cancelled'
    )
      invalid();
    if (x.flow_type !== 'screen' && x.flow_type !== 'legacy') invalid();
    session = {
      id: str(x.id),
      status: x.status,
      flow_type: x.flow_type,
      has_legacy_items: bool(x.has_legacy_items),
      sequence_number: count(x.sequence_number),
    };
  }
  const lines = list(r.selected_lines).map((v): ReconciliationLine => {
    const x = obj(v);
    return {
      id: str(x.id),
      classification_id: str(x.classification_id),
      classification_name: str(x.classification_name),
      book_amount: money(x.book_amount),
      accountant_amount: money(x.accountant_amount),
      difference: money(x.difference),
    };
  });
  if (
    lines.length > RECONCILIATION_PAGE_SIZE ||
    new Set(lines.map((x) => x.id)).size !== lines.length ||
    (lines.length && (!session || session.flow_type !== 'screen' || session.has_legacy_items))
  )
    invalid();
  const stations = list(s.stations_with_nonzero_difference).map((v) => {
    const x = obj(v);
    return {
      station_id: str(x.station_id),
      station_name: str(x.station_name),
      total_difference: money(x.total_difference),
    };
  });
  const reason = f.close_blocked_reason;
  if (reason !== null && reason !== 'no_eligible_open_sessions' && reason !== 'nonzero_differences')
    invalid();
  return {
    fiscal_month: {
      id: monthId,
      is_active: bool(month.is_active),
      is_fiscal_closed: bool(month.is_fiscal_closed),
    },
    selected_session: session,
    selected_lines: lines,
    month_summary: {
      open_sessions_count: count(s.open_sessions_count),
      eligible_open_screen_sessions: count(s.eligible_open_screen_sessions),
      eligible_open_stations_count: count(s.eligible_open_stations_count),
      eligible_closed_screen_sessions: count(s.eligible_closed_screen_sessions),
      total_stations_with_sessions: count(s.total_stations_with_sessions),
      stations_with_nonzero_difference: stations,
      total_month_difference: money(s.total_month_difference),
    },
    pagination: { offset, limit: RECONCILIATION_PAGE_SIZE, has_more: bool(p.has_more) },
    flags: { can_close_now: bool(f.can_close_now), close_blocked_reason: reason },
  };
}

/** numeric(18,2): transmit the exact decimal as a JSON string, never a JS float. */
export function normalizeReconciliationAmount(value: string): string | null {
  const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match?.[1]) return null;
  return `${BigInt(match[1])}.${(match[2] ?? '').padEnd(2, '0')}`;
}
export function formatReconciliationAmount(value: string, locale: Locale): string {
  const negative = value.startsWith('-');
  const [whole = '0', cents = '00'] = (negative ? value.slice(1) : value).split('.');
  const formatted = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', {
    maximumFractionDigits: 0,
  }).format(BigInt(whole));
  return `${negative ? '-' : ''}${formatted}.${cents}`;
}
