import type { Locale } from '@/i18n/I18nContext';

/** Client-side routing/display contracts; PostgreSQL RLS remains authoritative. */
export const APS_LETTERS_PATH = '/workspaces/aps/letters';
export const APS_LETTERS_READ_REQUIREMENT = [
  'aps.letters:read',
  'aps.letters:create',
  'aps.reconciliation:manage',
  'aps.reconciliation:approve',
] as const;

export type LetterType =
  'inbound' | 'outbound' | 'internal_transfer' | 'external_transfer' | 'settlement';
export type LetterStatus = 'draft' | 'approved' | 'cancelled';
export type LetterTypeFilter = '' | 'inbound' | 'outbound' | 'transfer' | 'settlement';
export type LetterStatusFilter = '' | LetterStatus;

export interface LetterFilters {
  readonly type: LetterTypeFilter;
  readonly status: LetterStatusFilter;
  readonly from: string;
  readonly to: string;
}

export interface LetterCursor {
  readonly date: string;
  readonly id: string;
}

export const EMPTY_LETTER_FILTERS: LetterFilters = {
  type: '',
  status: '',
  from: '',
  to: '',
};

const TYPES: readonly string[] = [
  'inbound',
  'outbound',
  'internal_transfer',
  'external_transfer',
  'settlement',
];
const STATUSES: readonly string[] = ['draft', 'approved', 'cancelled'];
const TYPE_FILTERS: readonly string[] = ['', 'inbound', 'outbound', 'transfer', 'settlement'];
const STATUS_FILTERS: readonly string[] = ['', ...STATUSES];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLetterType(value: unknown): value is LetterType {
  return typeof value === 'string' && TYPES.includes(value);
}

export function isLetterStatus(value: unknown): value is LetterStatus {
  return typeof value === 'string' && STATUSES.includes(value);
}

export function isLetterDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isLetterId(value: string): boolean {
  return UUID.test(value);
}

export function parseLetterCursor(value: string | null): LetterCursor | null {
  if (value === null || value === '') return null;
  const match = /^(\d{4}-\d{2}-\d{2})_([0-9a-f-]+)$/i.exec(value);
  const date = match?.[1];
  const id = match?.[2];
  return date !== undefined && id !== undefined && isLetterDate(date) && isLetterId(id)
    ? { date, id }
    : null;
}

export function encodeLetterCursor(cursor: LetterCursor): string {
  return `${cursor.date}_${cursor.id}`;
}

/** Invalid deep links never become unfiltered requests or interpolated SQL. */
export function readLetterSearch(params: URLSearchParams): {
  readonly filters: LetterFilters;
  readonly cursor: LetterCursor | null;
  readonly valid: boolean;
} {
  const type = params.get('type') ?? '';
  const status = params.get('status') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const rawCursor = params.get('cursor');
  const cursor = parseLetterCursor(rawCursor);
  const valid =
    TYPE_FILTERS.includes(type) &&
    STATUS_FILTERS.includes(status) &&
    (from === '' || isLetterDate(from)) &&
    (to === '' || isLetterDate(to)) &&
    (from === '' || to === '' || from <= to) &&
    (rawCursor === null || rawCursor === '' || cursor !== null);

  return {
    filters: {
      type: TYPE_FILTERS.includes(type) ? (type as LetterTypeFilter) : '',
      status: STATUS_FILTERS.includes(status) ? (status as LetterStatusFilter) : '',
      from,
      to,
    },
    cursor,
    valid,
  };
}

/** Preserve unrelated URL parameters, but reset pagination when a filter changes. */
export function writeLetterFilters(
  current: URLSearchParams,
  filters: LetterFilters,
): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of ['type', 'status', 'from', 'to'] as const) {
    const value = filters[key];
    if (value === '') next.delete(key);
    else next.set(key, value);
  }
  next.delete('cursor');
  return next;
}

export function activeLetterFilterCount(filters: LetterFilters): number {
  return (
    Number(filters.type !== '') +
    Number(filters.status !== '') +
    Number(filters.from !== '') +
    Number(filters.to !== '')
  );
}

/**
 * PostgREST projections cast numeric(18,2) to text before JSON serialization.
 * Never accept a JS number here: precision may already have been lost in JSON.
 */
export function parseLetterAmount(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,16})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match?.[1]) return null;
  return `${BigInt(match[1]).toString()}.${(match[2] ?? '').padEnd(2, '0')}`;
}

/** Format arbitrary numeric(18,2) amounts without ever converting them to Number. */
export function formatLetterAmount(amount: string, locale: Locale): string {
  const [whole = '0', cents = '00'] = amount.split('.');
  /* Arabic grouping with Latin digits (`8,900.00`, not `٨٬٩٠٠٫٠٠`): the same
     numbering the dashboard adopted, so every printed total matches the raw
     digits the clerk types into the amount fields. */
  const language = locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US';
  const integer = new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(
    BigInt(whole),
  );
  const digit = new Intl.NumberFormat(language, { useGrouping: false, maximumFractionDigits: 0 });
  const decimal =
    new Intl.NumberFormat(language, { minimumFractionDigits: 1 })
      .formatToParts(1.1)
      .find((part) => part.type === 'decimal')?.value ?? '.';
  return `${integer}${decimal}${[...cents].map((value) => digit.format(BigInt(value))).join('')}`;
}

export function formatLetterDate(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}
