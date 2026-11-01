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
  type EntryActivePeriod,
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
  /** An internal transfer whose two sides differ; approval refuses it. */
  | 'unbalanced'
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
  // `aps_assert_letter_consistent` refuses an unbalanced transfer with 23514
  // and says so in words; that refusal deserves its own message, not "bad data".
  if (code === '23514' && message.includes('does not balance')) return 'unbalanced';
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

function errorDetail(error: unknown): string {
  const item = record(error);
  return [item?.code, item?.message, item?.details, item?.hint]
    .map((value) => text(value) ?? '')
    .join(' ')
    .toLowerCase();
}

/**
 * The note-column rollout can briefly have this client talking to the
 * pre-migration schema. Only a schema-cache/undefined-column error naming the
 * new column is a compatibility signal; every other failure keeps its normal
 * classification and is never retried.
 */
function isMissingColumnError(error: unknown, column: string): boolean {
  const item = record(error);
  const code = text(item?.code) ?? '';
  const detail = errorDetail(error);
  if (!detail.includes(column.toLowerCase())) return false;
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    detail.includes('does not exist') ||
    detail.includes('could not find') ||
    detail.includes('schema cache')
  );
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
/**
 * The active posting month, read defensively.
 *
 * A malformed or missing period must never blank the entry screen: the period
 * bar is presentation state, and the save function re-resolves the period on
 * every write. So this returns null instead of throwing.
 */
function parseActivePeriod(value: unknown): EntryActivePeriod | null {
  const row = record(value);
  const monthId = row?.fiscal_month_id;
  const yearId = row?.fiscal_year_id;
  const name = text(row?.name);
  const start = text(row?.start_date);
  const end = text(row?.end_date);
  if (
    !isEntryOptionId(monthId) ||
    !isEntryOptionId(yearId) ||
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
    typeof row?.period_number !== 'number' ||
    !Number.isInteger(row.period_number) ||
    row.period_number < 1 ||
    typeof row?.is_closed !== 'boolean'
  )
    return null;
  const projectToday = row.project_today == null ? null : text(row.project_today);
  if (projectToday !== null && !isLetterDate(projectToday)) return null;
  return {
    monthId,
    yearId,
    monthNumber: row.month_number,
    name,
    startDate: start,
    endDate: end,
    period: row.period_number,
    closed: row.is_closed,
    projectToday,
    containsToday: typeof row.contains_today === 'boolean' ? row.contains_today : null,
  };
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
    containsToday: typeof row.contains_today === 'boolean' ? row.contains_today : null,
  };
}
function parseParty(value: unknown): EntryParty {
  const option = parseOption(value);
  const branch = record(value)?.branch;
  if (branch !== 'inbound' && branch !== 'outbound') throw new ApsEntryError('invalid');
  return { ...option, branch };
}
/**
 * A fiscal year row.
 *
 * `is_active` is read when the database sends it. Since A.3 the year block no
 * longer carries it — the active period names the year instead — so a missing
 * flag is inferred from that period rather than treated as a broken payload.
 * (A rejected payload here is what blanked the screen with «تعذر تحميل بيانات
 * الإدخال» right after A.3 was applied.)
 */
function parseYear(value: unknown, activeYearId: string | null): EntryYear {
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
    (row?.is_active !== undefined && typeof row.is_active !== 'boolean') ||
    typeof row?.is_closed !== 'boolean' ||
    typeof row?.supplements_open !== 'boolean'
  )
    throw new ApsEntryError('invalid');
  const active =
    typeof row.is_active === 'boolean'
      ? row.is_active
      : activeYearId === null
        ? false
        : row.id === activeYearId;
  return {
    id: row.id,
    name,
    startDate: start,
    endDate: end,
    active,
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
  const activePeriod = parseActivePeriod(row.active_period);
  return {
    years: row.fiscal_years.map((year) => parseYear(year, activePeriod?.yearId ?? null)),
    months: row.fiscal_months.map(parseMonth),
    warehouses: row.warehouses.map(parseWarehouse),
    classifications: row.classifications.map(parseOption),
    parties: row.parties.map(parseParty),
    sisters: row.sister_companies.map(parseOption),
    issuers: row.issuers.map(parseIssuer),
    activePeriod,
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
  // New rows have no paired_line_id at all; absence and null both mean a
  // free line. A non-null legacy value must still be a real line id.
  const pair = row?.paired_line_id == null ? null : nullableId(row?.paired_line_id);
  if (
    !isEntryOptionId(row?.id) ||
    !isEntryOptionId(row?.warehouse_id) ||
    !isEntryOptionId(row?.classification_id) ||
    (row?.direction !== 'in' && row?.direction !== 'out') ||
    amount === null ||
    amount === '0.00' ||
    (row?.paired_line_id != null && pair === null)
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
    // A transfer is a free list of rows with no pairing — the screen shows the
    // `out` rows in one table and the `in` rows in the other, and every saved
    // row becomes one editable row again. Legacy pair-shaped drafts are read the
    // same way: their two stored rows already carry the right direction.
    // A draft written while the database still had `paired_line_id` carries a
    // pointer from the destination row to its old source. It is not rewritten
    // and never re-zipped: both rows already know their side, and a pointer to
    // a line of another letter proves the payload was not this letter's.
    const lineIds = new Set(rows.map((row) => row.id));
    if (rows.some((row) => row.pair !== null && !lineIds.has(row.pair)))
      throw new ApsEntryError('invalid');
    lines = rows.map((row) => ({
      key: row.id,
      partyId: '',
      warehouseId: row.warehouseId,
      classificationId: row.classificationId,
      direction: row.direction,
      amount: row.amount,
    }));
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
      // The form field keeps its old name for this compatibility patch; the
      // database statement may arrive under either schema's column name.
      reason: text(header.reclassification_note) ?? text(header.reclassification_reason) ?? '',
      lines,
    },
  };
}

export async function fetchEntryDraft(id: string, actorId: string): Promise<LoadedDraft> {
  if (!isLetterId(id)) throw new ApsEntryError('notFound');
  const current = client();
  const readHeader = (statementColumn: 'reclassification_note' | 'reclassification_reason') =>
    current
      .from('letters')
      .select(
        `id, fiscal_year_id, letter_type, letter_number, letter_number_raw, letter_date, issuer_reference, party_id, sister_company_id, ${statementColumn}, status, created_by, updated_at`,
      )
      .eq('id', id)
      .maybeSingle();
  let header = await readHeader('reclassification_note');
  // A newly deployed client may reach the database minutes before its
  // migration. Retry only that one recognised schema-cache failure.
  if (header.error && isMissingColumnError(header.error, 'reclassification_note')) {
    header = await readHeader('reclassification_reason');
  }
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
      // Omitting the retired pairing column is safe under both schemas; the
      // parser still understands it if an older response includes it.
      'id, direction, party_id, warehouse_id, classification_id, amount::text',
    )
    .eq('letter_id', id)
    .order('line_number', { ascending: true })
    .limit(500);
  assertResponse(lines);
  return parseEntryDraft(header.data, lines.data, actorId);
}

/**
 * The entry choices query key.
 *
 * Exported because the posting period lives inside these choices and is changed
 * elsewhere — the periodic settings screen — which has to refresh the entry bar
 * without borrowing the shape of this hook's key.
 */
export const ENTRY_OPTIONS_QUERY_KEY = ['aps', 'entry-options'] as const;

/**
 * How often an open entry screen re-reads its choices.
 *
 * The active month can change while a clerk is filling a form, and a period
 * statement that disagrees with what the save will write is worse than no
 * statement at all. Thirty seconds is a compromise: fast enough to notice a
 * switch, cheap enough for a payload of a few hundred rows.
 */
export const ENTRY_OPTIONS_REFRESH_MS = 30_000;

export function useEntryOptions() {
  const { session } = useAuth();
  const actor = session?.user.id ?? null;
  return useQuery({
    queryKey: [...ENTRY_OPTIONS_QUERY_KEY, actor],
    queryFn: fetchEntryOptions,
    enabled: actor !== null,
    retry: false,
    // A cached period is a stale period as soon as someone activates another
    // month: never treat these choices as fresh, re-read them when the window
    // regains focus, and poll while the screen stays open.
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    refetchOnMount: 'always',
    refetchInterval: ENTRY_OPTIONS_REFRESH_MS,
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
  // One payload for every letter type: an internal transfer row already names
  // its side, so the two tables reach the database as free lines — no pairing,
  // no `paired_line_id`, and no party on a transfer line.
  const lines = form.lines.map((line) => {
    const amount = normalizeEntryAmount(line.amount);
    if (amount === null) throw new ApsEntryError('invalid');
    if (form.type === 'internal_transfer') {
      return {
        direction: line.direction ?? 'out',
        warehouse_id: line.warehouseId,
        classification_id: line.classificationId,
        amount,
      };
    }
    return {
      direction: form.type === 'inbound' ? 'in' : form.type === 'outbound' ? 'out' : form.direction,
      warehouse_id: line.warehouseId,
      classification_id: line.classificationId,
      amount,
      ...(form.type === 'inbound' || form.type === 'outbound' ? { party_id: line.partyId } : {}),
    };
  });
  const statement = form.type === 'internal_transfer' ? form.reason : null;
  const commonArgs = {
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
    p_issuer_reference: form.letterCode === '' ? null : form.letterCode,
  };
  // One signature only. The old one accepted source/destination *pairs*, which
  // cannot express a free-line transfer at all (one source feeding two
  // destinations has no pair to write), so retrying it would send a payload it
  // must reject. A database that has not run the free-line migration fails here
  // with `unavailable` — loudly, and without a half-written letter.
  const response = await client().rpc('aps_save_letter_draft', {
    ...commonArgs,
    p_reclassification_note: statement,
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
