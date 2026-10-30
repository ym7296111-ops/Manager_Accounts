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
  readonly warehouses: readonly EntryOption[];
  readonly classifications: readonly EntryOption[];
  readonly parties: readonly EntryParty[];
  readonly sisters: readonly EntryOption[];
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
  readonly number: string;
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
