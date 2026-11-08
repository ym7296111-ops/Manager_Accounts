import type { Locale } from '@/i18n/I18nContext';

export const APS_RECONCILIATION_PATH = '/workspaces/aps/reconciliation';
export const APS_RECONCILIATION_REQUIREMENT = [
  'aps.reconciliation:manage',
  'aps.reconciliation:close_month',
  'aps.reconciliation:reopen_month',
] as const;
export const APS_RECONCILIATION_SETTINGS_CAPABILITY = 'aps.reconciliation:settings';
export const RECONCILIATION_PAGE_SIZE = 50;

export interface MonthOption {
  id: string;
  label: string;
  is_active: boolean;
  is_fiscal_closed: boolean;
}
export interface ReconciliationOptions {
  months: MonthOption[];
  can_manage: boolean;
  can_close: boolean;
  can_reopen_as_owner: boolean;
}
export interface ReconciliationScope {
  id: string;
  name: string;
  is_active: boolean;
  is_default: boolean;
}
export interface ReconciliationSession {
  id: string;
  status: 'open' | 'closed';
  flow_type: 'screen_v2';
  scope_id: string;
  scope_name_snapshot: string | null;
  source_config_revision_id: string | null;
  config_generation: string;
  settings_revision_id: string;
  needs_review: boolean;
  review_reason: string | null;
  sequence_number: number;
  snapshot_version: string;
}
export interface Movement {
  book_inbound: string | null;
  book_outbound: string | null;
  accountant_inbound: string | null;
  accountant_outbound: string | null;
  book_balance: string | null;
  accountant_balance: string | null;
  inbound_difference: string | null;
  outbound_difference: string | null;
  balance_difference: string | null;
}
export interface ReconciliationLine {
  id: string;
  classification_id: string;
  classification_name: string;
  version: string;
  monthly: Movement;
  ytd: Movement & {
    book_opening: string | null;
    accountant_opening: string | null;
    accountant_opening_source: 'manual' | 'trusted_system' | 'missing';
  };
}
export interface ReconciliationState {
  current_config_revision_id: string | null;
  historical_overlap: boolean;
  fiscal_month: { id: string; is_active: boolean; is_fiscal_closed: boolean };
  selected_session: ReconciliationSession | null;
  selected_lines: ReconciliationLine[];
  month_summary: {
    open_sessions_count: number;
    closed_sessions_count: number;
    missing_system_opening_count: number;
  };
  pagination: { offset: number; limit: number; has_more: boolean };
  flags: {
    can_close_now: boolean;
    close_blocked_reason: string | null;
    settings_changed: boolean | null;
    can_sync_from_settings: boolean;
  };
}
export interface ReconciliationClassification {
  id: string;
  name: string;
  parent_id: string | null;
  is_leaf: boolean;
  is_active: boolean;
}
export interface ReconciliationSettings {
  scope_id: string;
  revision_id: string | null;
  classifications: ReconciliationClassification[];
  selected: string[];
}
export interface RecordAmounts {
  monthlyInbound: string;
  monthlyOutbound: string;
  ytdInbound: string;
  ytdOutbound: string;
  opening: string | null;
}
export interface Draft {
  version: string;
  monthlyInbound: string;
  monthlyOutbound: string;
  ytdInbound: string;
  ytdOutbound: string;
  manual: boolean;
  opening: string;
  submitted?: RecordAmounts;
  conflicted?: boolean;
}
export function makeDraft(line: ReconciliationLine): Draft {
  return {
    version: line.version,
    monthlyInbound: line.monthly.accountant_inbound ?? '',
    monthlyOutbound: line.monthly.accountant_outbound ?? '',
    ytdInbound: line.ytd.accountant_inbound ?? '',
    ytdOutbound: line.ytd.accountant_outbound ?? '',
    manual: line.ytd.accountant_opening_source === 'manual',
    opening:
      line.ytd.accountant_opening_source === 'manual' ? (line.ytd.accountant_opening ?? '') : '',
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
function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : invalid();
}
function str(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v : invalid();
}
function nullableString(v: unknown): string | null {
  return v === null ? null : str(v);
}
function bool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : invalid();
}
function count(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : invalid();
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : invalid();
}
function version(v: unknown): string {
  return typeof v === 'string' && /^\d+$/.test(v) ? v : invalid();
}
function money(v: unknown): string | null {
  return v === null ? null : typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v) ? v : invalid();
}
function movement(v: unknown): Movement {
  const x = obj(v);
  return {
    book_inbound: money(x.book_inbound),
    book_outbound: money(x.book_outbound),
    accountant_inbound: money(x.accountant_inbound),
    accountant_outbound: money(x.accountant_outbound),
    book_balance: money(x.book_balance),
    accountant_balance: money(x.accountant_balance),
    inbound_difference: money(x.inbound_difference),
    outbound_difference: money(x.outbound_difference),
    balance_difference: money(x.balance_difference),
  };
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
  if (new Set(months.map((m) => m.id)).size !== months.length) invalid();
  return {
    months,
    can_manage: bool(o.can_manage),
    can_close: bool(o.can_close),
    can_reopen_as_owner: bool(o.can_reopen_as_owner),
  };
}
export function parseReconciliationScopes(value: unknown): ReconciliationScope[] {
  const scopes = list(value).map((item) => {
    const x = obj(item);
    return {
      id: str(x.id),
      name: str(x.name),
      is_active: bool(x.is_active),
      is_default: bool(x.is_default),
    };
  });
  if (
    new Set(scopes.map((s) => s.id)).size !== scopes.length ||
    scopes.filter((s) => s.is_default).length !== 1
  )
    invalid();
  return scopes;
}
export function parseReconciliationSettings(
  value: unknown,
  scopeId: string,
): ReconciliationSettings {
  const o = obj(value);
  const classifications = list(o.classifications).map((v) => {
    const c = obj(v);
    return {
      id: str(c.id),
      name: str(c.name),
      parent_id: nullableString(c.parent_id),
      is_leaf: bool(c.is_leaf),
      is_active: bool(c.is_active),
    };
  });
  const selected = list(o.selected).map(str);
  if (
    new Set(classifications.map((c) => c.id)).size !== classifications.length ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !classifications.some((c) => c.id === id))
  )
    invalid();
  if (str(o.scope_id) !== scopeId) invalid();
  return {
    scope_id: scopeId,
    revision_id: nullableString(o.revision_id),
    classifications,
    selected,
  };
}
export function parseReconciliationState(
  value: unknown,
  monthId: string,
  offset: number,
  scopeId: string,
): ReconciliationState {
  const r = obj(value),
    month = obj(r.fiscal_month),
    p = obj(r.pagination),
    f = obj(r.flags),
    summary = obj(r.month_summary);
  if (
    str(month.id) !== monthId ||
    count(p.offset) !== offset ||
    count(p.limit) !== RECONCILIATION_PAGE_SIZE
  )
    invalid();
  let session: ReconciliationSession | null = null;
  if (r.selected_session !== null) {
    const s = obj(r.selected_session);
    if ((s.status !== 'open' && s.status !== 'closed') || s.flow_type !== 'screen_v2') invalid();
    if (str(s.scope_id) !== scopeId) invalid();
    session = {
      id: str(s.id),
      scope_id: scopeId,
      scope_name_snapshot: nullableString(s.scope_name_snapshot),
      source_config_revision_id: nullableString(s.source_config_revision_id),
      config_generation: version(s.config_generation),
      status: s.status,
      flow_type: s.flow_type,
      settings_revision_id: str(s.settings_revision_id),
      needs_review: bool(s.needs_review),
      review_reason: nullableString(s.review_reason),
      sequence_number: count(s.sequence_number),
      snapshot_version: version(s.snapshot_version),
    };
  }
  const lines = list(r.selected_lines).map((v): ReconciliationLine => {
    const x = obj(v),
      y = obj(x.ytd),
      source = y.accountant_opening_source;
    if (source !== 'manual' && source !== 'trusted_system' && source !== 'missing') invalid();
    return {
      id: str(x.id),
      classification_id: str(x.classification_id),
      classification_name: str(x.classification_name),
      version: version(x.version),
      monthly: movement(x.monthly),
      ytd: {
        ...movement(y),
        book_opening: money(y.book_opening),
        accountant_opening: money(y.accountant_opening),
        accountant_opening_source: source,
      },
    };
  });
  if (
    lines.length > RECONCILIATION_PAGE_SIZE ||
    new Set(lines.map((l) => l.id)).size !== lines.length ||
    (lines.length > 0 && !session)
  )
    invalid();
  return {
    current_config_revision_id: nullableString(r.current_config_revision_id),
    historical_overlap: bool(r.historical_overlap),
    fiscal_month: {
      id: monthId,
      is_active: bool(month.is_active),
      is_fiscal_closed: bool(month.is_fiscal_closed),
    },
    selected_session: session,
    selected_lines: lines,
    month_summary: {
      open_sessions_count: count(summary.open_sessions_count),
      closed_sessions_count: count(summary.closed_sessions_count),
      missing_system_opening_count: count(summary.missing_system_opening_count),
    },
    pagination: { offset, limit: RECONCILIATION_PAGE_SIZE, has_more: bool(p.has_more) },
    flags: {
      can_close_now: bool(f.can_close_now),
      close_blocked_reason: nullableString(f.close_blocked_reason),
      settings_changed: f.settings_changed === null ? null : bool(f.settings_changed),
      can_sync_from_settings: bool(f.can_sync_from_settings),
    },
  };
}
/** Preserve numeric(18,2) exactly, without ever converting to a JS number. */
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
