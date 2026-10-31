import { matchesSearch } from '@/lib/arabicText';
import { isLetterId, parseLetterAmount } from '@/lib/apsLetters';

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
  /**
   * The party this line belongs to (inbound supplier / outbound purpose). The
   * tree groups lines by it; transfers never carry one and leave it empty.
   */
  readonly partyId: string;
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
  /** The manual letter code printed on the paper, `YM:63` (`issuer_reference`). */
  readonly letterCode: string;
  readonly yearId: string;
  readonly partyId: string;
  readonly sisterId: string;
  readonly direction: EntryDirection;
  readonly reason: string;
  readonly lines: readonly EntryLine[];
}

export function newEntryLine(partyId = '', warehouseId = ''): EntryLine {
  return {
    key: crypto.randomUUID(),
    partyId,
    warehouseId,
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
    letterCode: '',
    yearId: '',
    partyId: '',
    sisterId: '',
    direction: 'in',
    reason: '',
    lines: [newEntryLine()],
  };
}

/** Arabic-Indic and Persian digits become ASCII, so every parser sees one shape. */
function foldDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - '٠'.charCodeAt(0)))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - '۰'.charCodeAt(0)));
}

/** Accept Arabic and Persian digits without ever converting money to Number. */
export function normalizeEntryAmount(value: string): string | null {
  const folded = foldDigits(value.trim()).replace(/٫/g, '.');
  const amount = parseLetterAmount(folded);
  return amount !== null && BigInt(amount.replace('.', '')) > 0n ? amount : null;
}

/**
 * The letter code the field should hold while typing: at most two Latin
 * letters, upper-cased, then the colon the clerk never types, then ASCII
 * digits. Arabic letters and every other character are dropped, so a phone
 * keyboard left on Arabic produces nothing rather than a silent bad value.
 */
export const LETTER_CODE_PATTERN = /^[A-Z]{2}:[0-9]+$/;
export const LETTER_CODE_MAX_LENGTH = 32;

export function normalizeLetterCode(value: string): string {
  const folded = foldDigits(value);
  let letters = '';
  let digits = '';
  for (const char of folded) {
    if (letters.length < 2) {
      if (/[A-Za-z]/.test(char)) letters += char.toUpperCase();
    } else if (/[0-9]/.test(char)) {
      digits += char;
    }
  }
  if (letters.length < 2) return letters;
  return digits === '' ? letters : `${letters}:${digits}`;
}

export function isLetterCode(value: string): boolean {
  return value.length <= LETTER_CODE_MAX_LENGTH && LETTER_CODE_PATTERN.test(value);
}

/**
 * Whether the field is worth an error line: an empty code is a valid unfinished
 * draft, but a half-typed one must say what shape it is waiting for.
 */
export function letterCodeIncomplete(value: string): boolean {
  return value !== '' && !isLetterCode(value);
}

/**
 * The screen's two controls and the stored value.
 *
 * `issuer_reference` is one column (`YM:63`), but it is answered by two inputs:
 * a dropdown of the registered issuers and a digits-only number field with the
 * colon printed between them. These two helpers are the only place that
 * conversion happens, so the composed value the hooks save is exactly the shape
 * the database CHECK accepts.
 */
export function splitLetterCode(value: string): {
  readonly code: string;
  readonly number: string;
} {
  const normalized = normalizeLetterCode(value);
  const separator = normalized.indexOf(':');
  return separator === -1
    ? { code: normalized, number: '' }
    : { code: normalized.slice(0, 2), number: normalized.slice(separator + 1) };
}

/**
 * Without an issuer there is no code at all — the number cannot stand alone, so
 * clearing the dropdown clears the pair rather than leaving an orphan number.
 */
export function joinLetterCode(code: string, number: string): string {
  if (code === '') return '';
  return number === '' ? code : `${code}:${number}`;
}

/**
 * Today in the browser's own calendar, `YYYY-MM-DD`. The period bar is about
 * the day the letter is being written, not about a date the clerk types.
 */
export function localToday(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
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

export interface EntryPeriod {
  readonly month: EntryMonth;
  readonly year: EntryYear;
}

/** `2026-2027` → `2026/2027`, the way the fiscal year is written on paper. */
export function fiscalYearLabel(name: string): string {
  const label = name.trim();
  const match = /^(\d{4})-(\d{4})$/.exec(label);
  return match ? `${match[1]}/${match[2]}` : label;
}

/**
 * The period that is running today, read from the periodic settings.
 *
 * The active fiscal year wins, so a stale inactive year cannot answer for the
 * month the clerk is working in. `null` means the settings do not cover today:
 * the screen says so instead of inventing a period.
 */
export function runningEntryPeriod(
  options: EntryOptions,
  today = localToday(),
): EntryPeriod | null {
  const years = [...options.years].sort((a, b) => Number(b.active) - Number(a.active));
  for (const year of years) {
    const month = options.months.find(
      (item) => item.yearId === year.id && today >= item.startDate && today <= item.endDate,
    );
    if (month !== undefined) return { month, year };
  }
  return null;
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
  | 'letterCode'
  | 'issuerCode'
  | 'period'
  | 'sister'
  | 'lines'
  | 'lineReference'
  | 'lineParty'
  | 'duplicateLine'
  | 'amount'
  | 'total'
  | 'reason';
export interface EntryValidationError {
  readonly code: EntryValidationCode;
  readonly line?: number;
}

const MAX_CENTS = 999_999_999_999_999_999n;
export function validateEntry(form: EntryForm, options: EntryOptions): EntryValidationError | null {
  // The EPS number is typed on a numeric field: digits only, exactly as printed.
  if (form.number.trim() === '' || !/^[0-9]{1,64}$/.test(form.number.trim()))
    return { code: 'number' };
  // The letter code stays optional on a draft, but a value that is present must
  // be the shape the database CHECK accepts.
  if (form.letterCode !== '' && !isLetterCode(form.letterCode)) return { code: 'letterCode' };
  // The prefix is what identifies the issuer: the database refuses a code whose
  // two letters are not in the register, so the screen says it first.
  if (
    form.letterCode !== '' &&
    !options.issuers.some((item) => item.code === form.letterCode.slice(0, 2))
  )
    return { code: 'issuerCode' };
  // The fiscal year is not a question any more: it comes from the periodic
  // settings through the running period, so a missing period blocks the save.
  if (form.yearId === '' || !options.years.some((item) => item.id === form.yearId))
    return { code: 'period' };
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
  const counterparty = form.type === 'inbound' || form.type === 'outbound';
  const seenTriples = new Set<string>();
  let total = 0n;
  for (const [index, line] of form.lines.entries()) {
    // The party lives on the line now: every counterparty line must name an
    // active party of the letter's own branch, and the (party, warehouse,
    // classification) triple may appear once — the database refuses a repeat,
    // so the screen says it first and names the line.
    if (counterparty) {
      if (!options.parties.some((item) => item.id === line.partyId && item.branch === form.type))
        return { code: 'lineParty', line: index + 1 };
      const triple = `${line.partyId}:${line.warehouseId}:${line.classificationId}`;
      if (line.warehouseId !== '' && line.classificationId !== '') {
        if (seenTriples.has(triple)) return { code: 'duplicateLine', line: index + 1 };
        seenTriples.add(triple);
      }
    }
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

/* ------------------------------------------------------------------ tree
 * The counterparty letter is edited as a tree — root (the letter type), then
 * parties, then warehouses, then one classification row per line — but the
 * stored model stays the flat line list. These helpers are the only place the
 * grouping is derived, in first-appearance order so nothing jumps while the
 * clerk types.
 */
export interface EntryWarehouseGroup {
  readonly warehouseId: string;
  readonly lines: readonly EntryLine[];
}
export interface EntryPartyGroup {
  readonly partyId: string;
  readonly warehouses: readonly EntryWarehouseGroup[];
  readonly lines: readonly EntryLine[];
}

export function groupEntryLines(lines: readonly EntryLine[]): readonly EntryPartyGroup[] {
  const partyOrder: string[] = [];
  const byParty = new Map<string, EntryLine[]>();
  for (const line of lines) {
    const bucket = byParty.get(line.partyId);
    if (bucket === undefined) {
      byParty.set(line.partyId, [line]);
      partyOrder.push(line.partyId);
    } else {
      bucket.push(line);
    }
  }
  return partyOrder.map((partyId) => {
    const partyLines = byParty.get(partyId) ?? [];
    const warehouseOrder: string[] = [];
    const byWarehouse = new Map<string, EntryLine[]>();
    for (const line of partyLines) {
      const bucket = byWarehouse.get(line.warehouseId);
      if (bucket === undefined) {
        byWarehouse.set(line.warehouseId, [line]);
        warehouseOrder.push(line.warehouseId);
      } else {
        bucket.push(line);
      }
    }
    return {
      partyId,
      lines: partyLines,
      warehouses: warehouseOrder.map((warehouseId) => ({
        warehouseId,
        lines: byWarehouse.get(warehouseId) ?? [],
      })),
    };
  });
}

/**
 * The number inside a party code (`OUT-007` → 7), compared as an integer —
 * never lexicographically, because `OUT-1000` sorts before `OUT-999` as text.
 * `null` for a code with no digits after the last dash.
 */
export function partyCodeNumber(code: string): bigint | null {
  const match = /-(\d+)$/.exec(code.trim());
  return match ? BigInt(match[1] ?? '0') : null;
}

/** The party with the smallest numeric code (`OUT-001` before `OUT-002`). */
export function smallestCodeParty<T extends EntryOption>(parties: readonly T[]): T | undefined {
  let best: T | undefined;
  let bestNumber: bigint | null = null;
  for (const party of parties) {
    const number = partyCodeNumber(party.code);
    if (
      best === undefined ||
      (number !== null && (bestNumber === null || number < bestNumber)) ||
      (number === bestNumber && party.code < best.code)
    ) {
      best = party;
      bestNumber = number;
    }
  }
  return best;
}

/** Signed money for balances: `-3980.00` → cents, without ever using Number. */
export function signedAmountToCents(value: string): bigint | null {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const amount = parseLetterAmount(negative ? trimmed.slice(1) : trimmed);
  if (amount === null) return null;
  const cents = BigInt(amount.replace('.', ''));
  return negative ? -cents : cents;
}

export function centsToSignedAmount(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

/** Sum of a line subset (a party or warehouse subtotal), null while incomplete. */
export function sumEntryAmounts(lines: readonly EntryLine[]): string | null {
  let total = 0n;
  for (const line of lines) {
    const amount = normalizeEntryAmount(line.amount);
    if (amount === null) return null;
    total += BigInt(amount.replace('.', ''));
    if (total > MAX_CENTS) return null;
  }
  return centsToSignedAmount(total);
}
