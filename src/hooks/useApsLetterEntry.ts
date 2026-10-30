import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { classifyPostgrestReadError } from '@/hooks/postgrestReadError';
import {
  isEntryOptionId,
  isEntryType,
  newEntryLine,
  normalizeEntryAmount,
  type EntryForm,
  type EntryLine,
  type EntryOption,
  type EntryOptions,
  type EntryParty,
  type EntryYear,
} from '@/lib/apsLetterEntry';
import { isLetterDate, isLetterId, parseLetterAmount } from '@/lib/apsLetters';
import { getSupabase } from '@/lib/supabase';

export type EntryErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'network'
  | 'duplicate'
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
    !Array.isArray(row.warehouses) ||
    !Array.isArray(row.classifications) ||
    !Array.isArray(row.parties) ||
    !Array.isArray(row.sister_companies)
  )
    throw new ApsEntryError('invalid');
  return {
    years: row.fiscal_years.map(parseYear),
    warehouses: row.warehouses.map(parseOption),
    classifications: row.classifications.map(parseOption),
    parties: row.parties.map(parseParty),
    sisters: row.sister_companies.map(parseOption),
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
    warehouseId: row.warehouse_id,
    classificationId: row.classification_id,
    amount,
    pair,
  };
}

export interface LoadedDraft {
  readonly id: string;
  readonly updatedAt: string;
  readonly form: EntryForm;
}
export function parseEntryDraft(
  headerValue: unknown,
  lineValues: unknown,
  actorId: string,
): LoadedDraft {
  const header = record(headerValue);
  const number = text(header?.letter_number_raw) ?? text(header?.letter_number);
  const date = text(header?.letter_date);
  const updatedAt = text(header?.updated_at);
  if (
    !isEntryOptionId(header?.id) ||
    !isEntryOptionId(header?.fiscal_year_id) ||
    header?.created_by !== actorId ||
    header?.status !== 'draft' ||
    !isEntryType(header?.letter_type) ||
    number === null ||
    date === null ||
    !isLetterDate(date) ||
    updatedAt === null ||
    !Array.isArray(lineValues)
  )
    throw new ApsEntryError('notFound');
  const type = header.letter_type;
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
      warehouseId: row.warehouseId,
      classificationId: row.classificationId,
      destinationWarehouseId: '',
      destinationClassificationId: '',
      amount: row.amount,
    }));
  }
  if (lines.length === 0) lines = [newEntryLine()];
  const partyId = nullableId(header.party_id) ?? '';
  const sisterId = nullableId(header.sister_company_id) ?? '';
  if ((type === 'inbound' || type === 'outbound') && partyId === '')
    throw new ApsEntryError('invalid');
  if (type === 'external_transfer' && sisterId === '') throw new ApsEntryError('invalid');
  return {
    id: header.id,
    updatedAt,
    form: {
      type,
      number,
      date,
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
      'id, fiscal_year_id, letter_type, letter_number, letter_number_raw, letter_date, party_id, sister_company_id, reclassification_reason, status, created_by, updated_at',
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
    .select('id, direction, warehouse_id, classification_id, amount::text, paired_line_id')
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
      : { warehouse_id: line.warehouseId, classification_id: line.classificationId, amount };
  });
  const response = await client().rpc('aps_save_letter_draft', {
    p_letter_id: id,
    p_expected_updated_at: updatedAt,
    p_fiscal_year_id: form.yearId,
    p_letter_type: form.type,
    p_letter_number: form.number,
    p_letter_date: form.date,
    p_party_id: form.type === 'inbound' || form.type === 'outbound' ? form.partyId : null,
    p_sister_company_id: form.type === 'external_transfer' ? form.sisterId : null,
    p_direction: form.type === 'external_transfer' ? form.direction : null,
    p_reclassification_reason: form.type === 'internal_transfer' ? form.reason : null,
    p_lines: lines,
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
