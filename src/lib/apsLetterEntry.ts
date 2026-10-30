import { matchesSearch } from '@/lib/arabicText';
import { isLetterDate, isLetterId, parseLetterAmount } from '@/lib/apsLetters';

export const APS_LETTER_NEW_PATH = '/workspaces/aps/letters/new';
export const APS_LETTER_CREATE_CAPABILITY = 'aps.letters:create';
export type EntryLetterType = 'inbound' | 'outbound' | 'internal_transfer' | 'external_transfer';
export type EntryDirection = 'in' | 'out';

export interface EntryOption {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}
/**
 * A warehouse choice always carries its station, because the register and the
 * paper form name the pair together (`المخزن - المحطة`). The station is null
 * only for legacy data written before stations were required.
 */
export interface EntryWarehouse extends EntryOption {
  readonly stationName: string | null;
  readonly stationCode: string | null;
}
export type EntryIssuer = EntryOption;
/** One row of the periodic settings: the month that a period is running in. */
export interface EntryMonth {
  readonly id: string;
  readonly yearId: string;
  readonly monthNumber: number;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly period: number;
  readonly closed: boolean;
}
export interface EntryParty extends EntryOption {
  readonly branch: 'inbound' | 'outbound';
}
export interface EntryYear {
  readonly id: string;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly supplementsOpen: boolean;
}
export interface EntryOptions {
  readonly years: readonly EntryYear[];
  readonly months: readonly EntryMonth[];
  readonly warehouses: readonly EntryWarehouse[];
  readonly classifications: readonly EntryOption[];
  readonly parties: readonly EntryParty[];
  readonly sisters: readonly EntryOption[];
  readonly issuers: readonly EntryIssuer[];
}
export interface EntryLine {
  readonly key: string;
  readonly warehouseId: string;
  readonly classificationId: string;
  readonly destinationWarehouseId: string;
  readonly destinationClassificationId: string;
  readonly amount: string;
}
export interface EntryForm {
  readonly type: EntryLetterType;
  /** The EPS number printed on the letter (`letter_number`). */
  readonly number: string;
  /** The issuer's two-letter code, chosen from the controlled list. */
  readonly issuerCode: string;
  /** The issuer's own sequence number, typed by hand. */
  readonly issuerSequence: string;
  readonly date: string;
  readonly yearId: string;
  readonly partyId: string;
  readonly sisterId: string;
  readonly direction: EntryDirection;
  readonly reason: string;
  readonly lines: readonly EntryLine[];
}

export function newEntryLine(): EntryLine {
  return {
    key: crypto.randomUUID(),
    warehouseId: '',
    classificationId: '',
    destinationWarehouseId: '',
    destinationClassificationId: '',
    amount: '',
  };
}

export function newEntryForm(): EntryForm {
  return {
    type: 'inbound',
    number: '',
    issuerCode: '',
    issuerSequence: '',
    date: '',
    yearId: '',
    partyId: '',
    sisterId: '',
    direction: 'in',
    reason: '',
    lines: [newEntryLine()],
  };
}

/** Accept Arabic and Persian digits without ever converting money to Number. */
export function normalizeEntryAmount(value: string): string | null {
  const folded = value
    .trim()
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - '٠'.charCodeAt(0)))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - '۰'.charCodeAt(0)))
    .replace(/٫/g, '.');
  const amount = parseLetterAmount(folded);
  return amount !== null && BigInt(amount.replace('.', '')) > 0n ? amount : null;
}

/** `[warehouse] - [station]`, the label used everywhere a warehouse is shown. */
export function warehouseLabel(item: {
  readonly name: string;
  readonly stationName: string | null;
}): string {
  return item.stationName === null || item.stationName.trim() === ''
    ? item.name
    : `${item.name} - ${item.stationName}`;
}

/** Search the warehouse by its own name, its station and its code. */
export function searchWarehouses<T extends EntryWarehouse>(
  entries: readonly T[],
  query: string,
): readonly T[] {
  return entries.filter((entry) =>
    matchesSearch(query, `${entry.name} ${entry.stationName ?? ''} ${entry.code}`),
  );
}

/** Search the issuer by code or name, so `YM` and `ياسر` both work. */
export function searchIssuers<T extends EntryIssuer>(
  entries: readonly T[],
  query: string,
): readonly T[] {
  return entries.filter((entry) => matchesSearch(query, `${entry.code} ${entry.name}`));
}

export interface EntryPeriod {
  readonly month: EntryMonth;
  readonly year: EntryYear;
}

/**
 * The period the letter date falls in, read from the periodic settings.
 *
 * A date outside every configured month is reported as `null` — the screen then
 * says so instead of inventing a period. The chosen fiscal year wins, so a
 * supplemental date cannot borrow another year's month number.
 */
export function entryPeriod(form: EntryForm, options: EntryOptions): EntryPeriod | null {
  const year = options.years.find((item) => item.id === form.yearId);
  if (year === undefined || !isLetterDate(form.date)) return null;
  const month = options.months.find(
    (item) =>
      item.yearId === form.yearId && form.date >= item.startDate && form.date <= item.endDate,
  );
  return month === undefined ? null : { month, year };
}

export function entryHasReclassification(form: EntryForm): boolean {
  return (
    form.type === 'internal_transfer' &&
    form.lines.some(
      (line) =>
        line.classificationId !== '' &&
        line.destinationClassificationId !== '' &&
        line.classificationId !== line.destinationClassificationId,
    )
  );
}

export type EntryValidationCode =
  | 'number'
  | 'issuer'
  | 'issuerSequence'
  | 'year'
  | 'date'
  | 'party'
  | 'sister'
  | 'lines'
  | 'lineReference'
  | 'amount'
  | 'total'
  | 'reason';
export interface EntryValidationError {
  readonly code: EntryValidationCode;
  readonly line?: number;
}

const MAX_CENTS = 999_999_999_999_999_999n;
export function validateEntry(form: EntryForm, options: EntryOptions): EntryValidationError | null {
  if (
    form.number.trim() === '' ||
    form.number.length > 64 ||
    [...form.number].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return { code: 'number' };
  // Both issuer fields stay optional on a draft, but a value that is present
  // must be one the server would accept: a listed code, and a printable
  // sequence of at most 32 characters.
  if (
    form.issuerCode !== '' &&
    (!/^[A-Za-z]{2}$/.test(form.issuerCode) ||
      !options.issuers.some((item) => item.code === form.issuerCode))
  )
    return { code: 'issuer' };
  if (
    form.issuerSequence !== '' &&
    (form.issuerSequence.length > 32 ||
      [...form.issuerSequence].some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127;
      }))
  )
    return { code: 'issuerSequence' };
  const year = options.years.find((item) => item.id === form.yearId);
  if (year === undefined) return { code: 'year' };
  if (!isLetterDate(form.date) || form.date < year.startDate || form.date > year.endDate)
    return { code: 'date' };
  if (
    (form.type === 'inbound' || form.type === 'outbound') &&
    !options.parties.some((item) => item.id === form.partyId && item.branch === form.type)
  )
    return { code: 'party' };
  if (
    form.type === 'external_transfer' &&
    !options.sisters.some((item) => item.id === form.sisterId)
  )
    return { code: 'sister' };
  if (
    form.lines.length === 0 ||
    form.lines.length > (form.type === 'internal_transfer' ? 250 : 500)
  )
    return { code: 'lines' };
  let total = 0n;
  for (const [index, line] of form.lines.entries()) {
    const hasWarehouse = options.warehouses.some((item) => item.id === line.warehouseId);
    const hasClassification = options.classifications.some(
      (item) => item.id === line.classificationId,
    );
    const hasDestination =
      form.type !== 'internal_transfer' ||
      (options.warehouses.some((item) => item.id === line.destinationWarehouseId) &&
        options.classifications.some((item) => item.id === line.destinationClassificationId));
    if (!hasWarehouse || !hasClassification || !hasDestination) {
      return { code: 'lineReference', line: index + 1 };
    }
    const amount = normalizeEntryAmount(line.amount);
    if (amount === null) return { code: 'amount', line: index + 1 };
    total += BigInt(amount.replace('.', ''));
    if (total > MAX_CENTS) return { code: 'total' };
  }
  if (entryHasReclassification(form) && form.reason.trim().length < 3) return { code: 'reason' };
  return null;
}

export function entryTotal(form: EntryForm): string | null {
  let total = 0n;
  for (const line of form.lines) {
    const amount = normalizeEntryAmount(line.amount);
    if (amount === null) return null;
    total += BigInt(amount.replace('.', ''));
    if (total > MAX_CENTS) return null;
  }
  return `${total / 100n}.${String(total % 100n).padStart(2, '0')}`;
}

export function isEntryType(value: unknown): value is EntryLetterType {
  return (
    value === 'inbound' ||
    value === 'outbound' ||
    value === 'internal_transfer' ||
    value === 'external_transfer'
  );
}

export function isEntryOptionId(value: unknown): value is string {
  return typeof value === 'string' && isLetterId(value);
}
