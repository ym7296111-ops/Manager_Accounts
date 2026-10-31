import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { classifyPostgrestReadError } from '@/hooks/postgrestReadError';
import {
  centsToSignedAmount,
  isEntryOptionId,
  isEntryType,
  isLetterCode,
  newEntryLine,
  normalizeEntryAmount,
  signedAmountToCents,
  type EntryForm,
  type EntryIssuer,
  type EntryLine,
  type EntryMonth,
  type EntryOption,
  type EntryOptions,
  type EntryParty,
  type EntryWarehouse,
  type EntryYear,
} from '@/lib/apsLetterEntry';
import { isLetterDate, isLetterId, parseLetterAmount } from '@/lib/apsLetters';
import { getSupabase } from '@/lib/supabase';

export type EntryErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'network'
  | 'duplicate'
  | 'duplicateLetterCode'
  | 'duplicatePartyLine'
  | 'existing'
  | 'stale'
  | 'invalid'
  | 'notFound'
  | 'unknown';

export class ApsEntryError extends Error {
  readonly code: EntryErrorCode;
  constructor(code: EntryErrorCode) {
    super(code);
    this.name = 'ApsEntryError';
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
function nullableId(value: unknown): string | null {
  return value === null ? null : isEntryOptionId(value) ? value : null;
}

export function classifyEntryError(error: unknown, status?: number): EntryErrorCode {
  if (error instanceof ApsEntryError) return error.code;
  const item = record(error);
  const code = text(item?.code) ?? '';
  const message = text(item?.message) ?? '';
  if (code === '23505') return 'duplicate';
  if (code === 'P0001' && message.includes('aps_entry_duplicate_letter_code'))
    return 'duplicateLetterCode';
  if (code === 'P0001' && message.includes('aps_entry_duplicate_party_line'))
    return 'duplicatePartyLine';
  if (code === 'P0001' && message.includes('aps_entry_id_exists')) return 'existing';
  if (code === 'P0001' && message.includes('aps_entry_stale_draft')) return 'stale';
  if (
    code === '22023' ||
    code === '23514' ||
    code === '23503' ||
    code === '22003' ||
    code === '22P02'
  )
    return 'invalid';
  // A gateway/server failure may arrive after the transaction committed.
  if (status === 0 || (status !== undefined && status >= 500) || error instanceof TypeError)
    return 'network';
  if (status === 401 || status === 403) return 'forbidden';
  return classifyPostgrestReadError(error);
}

function assertResponse(response: { readonly error: unknown; readonly status: number }) {
  if (response.error !== null && response.error !== undefined) {
    throw new ApsEntryError(classifyEntryError(response.error, response.status));
  }
}
function client() {
  const current = getSupabase();
  if (current === null) throw new ApsEntryError('unavailable');
  return current;
}

function parseOption(value: unknown): EntryOption {
  const row = record(value);
  const name = text(row?.name);
  const code = text(row?.code);
  if (!isEntryOptionId(row?.id) || name === null || code === null)
    throw new ApsEntryError('invalid');
  return { id: row.id, name, code };
}
function parseWarehouse(value: unknown): EntryWarehouse {
  const option = parseOption(value);
  const stationName = record(value)?.station_name;
  const stationCode = record(value)?.station_code;
  if (stationName !== null && stationName !== undefined && typeof stationName !== 'string')
    throw new ApsEntryError('invalid');
  if (stationCode !== null && stationCode !== undefined && typeof stationCode !== 'string')
    throw new ApsEntryError('invalid');
  return {
    ...option,
    stationName: typeof stationName === 'string' && stationName.trim() !== '' ? stationName : null,
    stationCode: typeof stationCode === 'string' && stationCode.trim() !== '' ? stationCode : null,
  };
}
function parseIssuer(value: unknown): EntryIssuer {
  const option = parseOption(value);
  if (!/^[A-Za-z]{2}$/.test(option.code)) throw new ApsEntryError('invalid');
  return option;
}
function parseMonth(value: unknown): EntryMonth {
  const row = record(value);
  const name = text(row?.name);
  const start = text(row?.start_date);
  const end = text(row?.end_date);
  if (
    !isEntryOptionId(row?.id) ||
    !isEntryOptionId(row?.fiscal_year_id) ||
    name === null ||
    start === null ||
    end === null ||
    !isLetterDate(start) ||
    !isLetterDate(end) ||
    start > end ||
    typeof row?.month_number !== 'number' ||
    !Number.isInteger(row.month_number) ||
    row.month_number < 1 ||
    row.month_number > 12 ||
    typeof row?.current_period !== 'number' ||
    !Number.isInteger(row.current_period) ||
    row.current_period < 1 ||
    typeof row?.is_closed !== 'boolean'
  )
    throw new ApsEntryError('invalid');
  return {
    id: row.id,
    yearId: row.fiscal_year_id,
    monthNumber: row.month_number,
    name,
    startDate: start,
    endDate: end,
    period: row.current_period,
    closed: row.is_closed,
  };
}
function parseParty(value: unknown): EntryParty {
  const option = parseOption(value);
  const branch = record(value)?.branch;
  if (branch !== 'inbound' && branch !== 'outbound') throw new ApsEntryError('invalid');
  return { ...option, branch };
}
function parseYear(value: unknown): EntryYear {
  const row = record(value);
  const name = text(row?.name);
  const start = text(row?.start_date);
  const end = text(row?.end_date);
  if (
    !isEntryOptionId(row?.id) ||
    name === null ||
    start === null ||
    end === null ||
    !isLetterDate(start) ||
    !isLetterDate(end) ||
    start > end ||
    typeof row?.is_active !== 'boolean' ||
    typeof row?.is_closed !== 'boolean' ||
    typeof row?.supplements_open !== 'boolean'
  )
    throw new ApsEntryError('invalid');
  return {
    id: row.id,
    name,
    startDate: start,
    endDate: end,
    active: row.is_active,
    closed: row.is_closed,
    supplementsOpen: row.supplements_open,
  };
}
export function parseEntryOptions(value: unknown): EntryOptions {
  const row = record(value);
  if (
    !row ||
    !Array.isArray(row.fiscal_years) ||
    !Array.isArray(row.fiscal_months) ||
    !Array.isArray(row.warehouses) ||
    !Array.isArray(row.classifications) ||
    !Array.isArray(row.parties) ||
    !Array.isArray(row.sister_companies) ||
    !Array.isArray(row.issuers)
  )
    throw new ApsEntryError('invalid');
  return {
    years: row.fiscal_years.map(parseYear),
    months: row.fiscal_months.map(parseMonth),
    warehouses: row.warehouses.map(parseWarehouse),
    classifications: row.classifications.map(parseOption),
    parties: row.parties.map(parseParty),
    sisters: row.sister_companies.map(parseOption),
    issuers: row.issuers.map(parseIssuer),
  };
}

export async function fetchEntryOptions(): Promise<EntryOptions> {
  const response = await client().rpc('aps_letter_entry_options');
  assertResponse(response);
  return parseEntryOptions(response.data);
}

interface RawDraftLine {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly partyId: string | null;
  readonly warehouseId: string;
  readonly classificationId: string;
  readonly amount: string;
  readonly pair: string | null;
}
function parseDraftLine(value: unknown): RawDraftLine {
  const row = record(value);
  const amount = parseLetterAmount(row?.amount);
  const pair = row?.paired_line_id === null ? null : nullableId(row?.paired_line_id);
  if (
    !isEntryOptionId(row?.id) ||
    !isEntryOptionId(row?.warehouse_id) ||
    !isEntryOptionId(row?.classification_id) ||
    (row?.direction !== 'in' && row?.direction !== 'out') ||
    amount === null ||
    amount === '0.00' ||
    (row?.paired_line_id !== null && pair === null)
  )
    throw new ApsEntryError('invalid');
  return {
    id: row.id,
    direction: row.direction,
    partyId: nullableId(row.party_id ?? null),
    warehouseId: row.warehouse_id,
    classificationId: row.classification_id,
    amount,
    pair,
  };
}

export interface LoadedDraft {
  readonly id: string;
  readonly updatedAt: string;
  /** The accounting date the draft was written with; null when unreadable. */
  readonly letterDate: string | null;
  readonly form: EntryForm;
}
export function parseEntryDraft(
  headerValue: unknown,
  lineValues: unknown,
  actorId: string,
): LoadedDraft {
  const header = record(headerValue);
  const number = text(header?.letter_number_raw) ?? text(header?.letter_number);
  const letterCode = header?.issuer_reference == null ? '' : text(header?.issuer_reference);
  const updatedAt = text(header?.updated_at);
  if (
    !isEntryOptionId(header?.id) ||
    !isEntryOptionId(header?.fiscal_year_id) ||
    header?.created_by !== actorId ||
    header?.status !== 'draft' ||
    !isEntryType(header?.letter_type) ||
    number === null ||
    letterCode === null ||
    (letterCode !== '' && !isLetterCode(letterCode)) ||
    updatedAt === null ||
    !Array.isArray(lineValues)
  )
    throw new ApsEntryError('notFound');
  const type = header.letter_type;
  const partyId = nullableId(header.party_id) ?? '';
  const sisterId = nullableId(header.sister_company_id) ?? '';
  const rows = lineValues.map(parseDraftLine);
  let lines: EntryLine[];
  if (type === 'internal_transfer') {
    const sources = rows.filter((row) => row.direction === 'out');
    const destinations = rows.filter((row) => row.direction === 'in');
    if (sources.length !== destinations.length || sources.some((row) => row.pair !== null))
      throw new ApsEntryError('invalid');
    const claimed = new Set<string>();
    lines = sources.map((source) => {
      const matches = destinations.filter((destination) => destination.pair === source.id);
      const destination = matches[0];
      if (
        matches.length !== 1 ||
        !destination ||
        destination.amount !== source.amount ||
        claimed.has(destination.id)
      )
        throw new ApsEntryError('invalid');
      claimed.add(destination.id);
      return {
        key: source.id,
        partyId: '',
        warehouseId: source.warehouseId,
        classificationId: source.classificationId,
        destinationWarehouseId: destination.warehouseId,
        destinationClassificationId: destination.classificationId,
        amount: source.amount,
      };
    });
  } else {
    const expected = type === 'inbound' ? 'in' : type === 'outbound' ? 'out' : rows[0]?.direction;
    if (rows.some((row) => row.pair !== null || row.direction !== expected))
      throw new ApsEntryError('invalid');
    lines = rows.map((row) => ({
      key: row.id,
      // A line written before the party moved onto it keeps the header party:
      // that is who the whole letter belonged to, line by line.
      partyId: row.partyId ?? partyId,
      warehouseId: row.warehouseId,
      classificationId: row.classificationId,
      destinationWarehouseId: '',
      destinationClassificationId: '',
      amount: row.amount,
    }));
  }
  if (lines.length === 0) lines = [newEntryLine()];
  if ((type === 'inbound' || type === 'outbound') && partyId === '')
    throw new ApsEntryError('invalid');
  if (type === 'external_transfer' && sisterId === '') throw new ApsEntryError('invalid');
  const rawDate = text(header.letter_date);
  return {
    id: header.id,
    updatedAt,
    letterDate: rawDate !== null && isLetterDate(rawDate) ? rawDate : null,
    form: {
      type,
      number,
      letterCode,
      yearId: header.fiscal_year_id,
      partyId,
      sisterId,
      direction: type === 'external_transfer' && rows[0]?.direction === 'out' ? 'out' : 'in',
      reason: text(header.reclassification_reason) ?? '',
      lines,
    },
  };
}

export async function fetchEntryDraft(id: string, actorId: string): Promise<LoadedDraft> {
  if (!isLetterId(id)) throw new ApsEntryError('notFound');
  const current = client();
  const header = await current
    .from('letters')
    .select(
      'id, fiscal_year_id, letter_type, letter_number, letter_number_raw, letter_date, issuer_reference, party_id, sister_company_id, reclassification_reason, status, created_by, updated_at',
    )
    .eq('id', id)
    .maybeSingle();
  assertResponse(header);
  if (header.data === null) throw new ApsEntryError('notFound');
  const headerRow = record(header.data);
  if (
    headerRow?.status !== 'draft' ||
    headerRow.created_by !== actorId ||
    !isEntryType(headerRow.letter_type)
  )
    throw new ApsEntryError('notFound');
  const lines = await current
    .from('letter_lines')
    .select(
      'id, direction, party_id, warehouse_id, classification_id, amount::text, paired_line_id',
    )
    .eq('letter_id', id)
    .order('line_number', { ascending: true })
    .limit(500);
  assertResponse(lines);
  return parseEntryDraft(header.data, lines.data, actorId);
}

export function useEntryOptions() {
  const { session } = useAuth();
  const actor = session?.user.id ?? null;
  return useQuery({
    queryKey: ['aps', 'entry-options', actor],
    queryFn: fetchEntryOptions,
    enabled: actor !== null,
    retry: false,
  });
}
export function useEntryDraft(id: string | null) {
  const { session } = useAuth();
  const actor = session?.user.id ?? null;
  return useQuery({
    queryKey: ['aps', 'entry-draft', actor, id],
    queryFn: () => fetchEntryDraft(id ?? '', actor ?? ''),
    enabled: actor !== null && id !== null,
    retry: false,
  });
}

export async function saveEntryDraft(
  id: string,
  updatedAt: string | null,
  form: EntryForm,
): Promise<{ id: string; updatedAt: string }> {
  const lines = form.lines.map((line) => {
    const amount = normalizeEntryAmount(line.amount);
    if (amount === null) throw new ApsEntryError('invalid');
    return form.type === 'internal_transfer'
      ? {
          source_warehouse_id: line.warehouseId,
          source_classification_id: line.classificationId,
          destination_warehouse_id: line.destinationWarehouseId,
          destination_classification_id: line.destinationClassificationId,
          amount,
        }
      : {
          warehouse_id: line.warehouseId,
          classification_id: line.classificationId,
          amount,
          ...(form.type === 'inbound' || form.type === 'outbound'
            ? { party_id: line.partyId }
            : {}),
        };
  });
  const response = await client().rpc('aps_save_letter_draft', {
    p_letter_id: id,
    p_expected_updated_at: updatedAt,
    p_fiscal_year_id: form.yearId,
    p_letter_type: form.type,
    p_letter_number: form.number,
    // The header keeps the primary party: the first line's. The database
    // re-derives the same value from the lines, so the two cannot drift.
    p_party_id:
      form.type === 'inbound' || form.type === 'outbound'
        ? form.lines[0]?.partyId || form.partyId || null
        : null,
    p_sister_company_id: form.type === 'external_transfer' ? form.sisterId : null,
    p_direction: form.type === 'external_transfer' ? form.direction : null,
    p_reclassification_reason: form.type === 'internal_transfer' ? form.reason : null,
    p_lines: lines,
    p_issuer_reference: form.letterCode === '' ? null : form.letterCode,
  });
  assertResponse(response);
  const result = record(response.data);
  const version = text(result?.updated_at);
  // A malformed success response does not prove the transaction failed.
  if (result?.id !== id || version === null) throw new ApsEntryError('network');
  return { id, updatedAt: version };
}

/** The existing database transition is the only approval path. */
export async function approveEntryLetter(id: string): Promise<void> {
  const response = await client().rpc('aps_approve_letter', { p_letter_id: id });
  assertResponse(response);
}

/**
 * Physical balances for the tree badges, keyed `warehouseId:classificationId`.
 * A missing key means the pair has never moved: its balance is zero. The map
 * is a display aid only — a read failure hides the badges, never the letter.
 */
export async function fetchLetterBalances(
  yearId: string,
  asOfDate: string,
): Promise<ReadonlyMap<string, string>> {
  const response = await client().rpc('aps_letter_balances', {
    p_fiscal_year_id: yearId,
    p_as_of_date: asOfDate,
  });
  assertResponse(response);
  if (!Array.isArray(response.data)) throw new ApsEntryError('invalid');
  const balances = new Map<string, string>();
  for (const value of response.data) {
    const row = record(value);
    const cents = typeof row?.balance === 'string' ? signedAmountToCents(row.balance) : null;
    if (
      !isEntryOptionId(row?.warehouse_id) ||
      !isEntryOptionId(row?.classification_id) ||
      cents === null
    )
      throw new ApsEntryError('invalid');
    balances.set(`${row.warehouse_id}:${row.classification_id}`, centsToSignedAmount(cents));
  }
  return balances;
}

export function useLetterBalances(yearId: string, asOfDate: string | null) {
  const { session } = useAuth();
  const actor = session?.user.id ?? null;
  return useQuery({
    queryKey: ['aps', 'letter-balances', actor, yearId, asOfDate],
    queryFn: () => fetchLetterBalances(yearId, asOfDate ?? ''),
    enabled: actor !== null && yearId !== '' && asOfDate !== null,
    retry: false,
  });
}
