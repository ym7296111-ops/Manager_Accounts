import { useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useAuth } from '@/context/AuthContext';
import { classifyPostgrestReadError } from '@/hooks/postgrestReadError';
import {
  encodeLetterCursor,
  isLetterDate,
  isLetterId,
  isLetterStatus,
  isLetterType,
  parseLetterAmount,
  readLetterSearch,
  type LetterCursor,
  type LetterFilters,
  type LetterStatus,
  type LetterType,
} from '@/lib/apsLetters';
import { getSupabase } from '@/lib/supabase';

/**
 * Only the current authenticated Supabase client is used; no elevated key or
 * client-side draft filtering can replace the letters / letter_lines RLS rules.
 * The counterparty is a historical snapshot on the letter, not a live join.
 * Cast money to text in PostgREST so JSON cannot round numeric(18,2).
 */
export const APS_LETTER_SELECT =
  'id, letter_type, letter_number, letter_number_raw, letter_date, status, counterparty_code, counterparty_name, source_total::text, destination_total::text, cancel_reason, settlement_reason';

/** Names are server-maintained line snapshots; no reference-table embed or extra read. */
export const APS_LETTER_LINE_SELECT =
  'id, line_number, direction, warehouse_id, classification_id, warehouse_name, classification_name, amount::text';

export const APS_LETTERS_PAGE_SIZE = 25;

export interface ApsLetter {
  readonly id: string;
  readonly number: string;
  readonly date: string;
  readonly type: LetterType;
  readonly status: LetterStatus;
  readonly counterpartyCode: string | null;
  readonly counterpartyName: string | null;
  /** `destination_total` = sum of inbound lines. */
  readonly totalIn: string;
  /** `source_total` = sum of outbound lines. */
  readonly totalOut: string;
  readonly cancellationReason: string | null;
  readonly settlementReason: string | null;
}

export interface ApsLetterLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly direction: 'in' | 'out';
  readonly warehouseId: string;
  readonly classificationId: string;
  readonly warehouseName: string;
  readonly classificationName: string;
  readonly amount: string;
}

export interface ApsLetterDetail {
  readonly letter: ApsLetter;
  readonly lines: readonly ApsLetterLine[];
}

export interface ApsLettersPage {
  readonly letters: readonly ApsLetter[];
  readonly nextCursor: LetterCursor | null;
}

export type ApsLettersErrorCode = 'unavailable' | 'forbidden' | 'network' | 'invalid' | 'unknown';

export class ApsLettersError extends Error {
  readonly code: ApsLettersErrorCode;

  constructor(code: ApsLettersErrorCode) {
    super(code);
    this.name = 'ApsLettersError';
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Fail visibly rather than silently dropping a financial record or rounding it. */
export function parseApsLetter(value: unknown): ApsLetter {
  const row = record(value);
  const id = nonempty(row?.id);
  const number = nonempty(row?.letter_number_raw) ?? nonempty(row?.letter_number);
  const date = nonempty(row?.letter_date);
  const totalIn = parseLetterAmount(row?.destination_total);
  const totalOut = parseLetterAmount(row?.source_total);
  if (
    row === null ||
    id === null ||
    !isLetterId(id) ||
    number === null ||
    date === null ||
    !isLetterDate(date) ||
    !isLetterType(row.letter_type) ||
    !isLetterStatus(row.status) ||
    totalIn === null ||
    totalOut === null
  ) {
    throw new ApsLettersError('invalid');
  }
  return {
    id,
    number,
    date,
    type: row.letter_type,
    status: row.status,
    counterpartyCode: nonempty(row.counterparty_code),
    counterpartyName: nonempty(row.counterparty_name),
    totalIn,
    totalOut,
    cancellationReason: nonempty(row.cancel_reason),
    settlementReason: nonempty(row.settlement_reason),
  };
}

export function parseApsLetterLine(value: unknown): ApsLetterLine {
  const row = record(value);
  const id = nonempty(row?.id);
  const warehouseId = nonempty(row?.warehouse_id);
  const classificationId = nonempty(row?.classification_id);
  const warehouseName = nonempty(row?.warehouse_name);
  const classificationName = nonempty(row?.classification_name);
  const amount = parseLetterAmount(row?.amount);
  if (
    row === null ||
    id === null ||
    !isLetterId(id) ||
    warehouseId === null ||
    !isLetterId(warehouseId) ||
    classificationId === null ||
    !isLetterId(classificationId) ||
    warehouseName === null ||
    classificationName === null ||
    !Number.isInteger(row.line_number) ||
    typeof row.line_number !== 'number' ||
    row.line_number < 1 ||
    row.line_number > 500 ||
    (row.direction !== 'in' && row.direction !== 'out') ||
    amount === null
  ) {
    throw new ApsLettersError('invalid');
  }
  return {
    id,
    lineNumber: row.line_number,
    direction: row.direction,
    warehouseId,
    classificationId,
    warehouseName,
    classificationName,
    amount,
  };
}

export function classifyApsLettersError(error: unknown, status?: number): ApsLettersErrorCode {
  if (error instanceof ApsLettersError) return error.code;
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 0 || error instanceof TypeError) return 'network';
  return classifyPostgrestReadError(error);
}

function ensureResponse(response: { readonly error: unknown; readonly status: number }): void {
  if (response.error !== null && response.error !== undefined) {
    throw new ApsLettersError(classifyApsLettersError(response.error, response.status));
  }
}

/**
 * RLS intentionally returns zero rows, not 403, when the caller has no access.
 * These existing read-only predicates distinguish that case from a genuinely
 * empty register. Creators may read their own drafts; reconciliation managers
 * and approvers may read the rows their existing policies allow. They do not
 * authorize anything by themselves: every subsequent SELECT still uses RLS.
 */
async function assertLetterAccess(client: SupabaseClient): Promise<void> {
  const [read, create] = await Promise.all([
    client.rpc('aps_can_read_letters'),
    client.rpc('aps_can_create_letters'),
  ]);
  ensureResponse(read);
  ensureResponse(create);
  if (read.data !== true && create.data !== true) throw new ApsLettersError('forbidden');
}

function requireClient(): SupabaseClient {
  const client = getSupabase();
  if (client === null) throw new ApsLettersError('unavailable');
  return client;
}

function assertValidFilters(filters: LetterFilters, cursor: LetterCursor | null): void {
  const params = new URLSearchParams();
  for (const key of ['type', 'status', 'from', 'to'] as const) {
    if (filters[key] !== '') params.set(key, filters[key]);
  }
  if (cursor !== null) params.set('cursor', encodeLetterCursor(cursor));
  if (!readLetterSearch(params).valid) throw new ApsLettersError('invalid');
}

export async function fetchApsLettersPage(
  filters: LetterFilters,
  cursor: LetterCursor | null,
  signal?: AbortSignal,
): Promise<ApsLettersPage> {
  assertValidFilters(filters, cursor);
  const client = requireClient();
  await assertLetterAccess(client);

  let query = client.from('letters').select(APS_LETTER_SELECT);
  if (filters.type === 'transfer') {
    query = query.in('letter_type', ['internal_transfer', 'external_transfer']);
  } else if (filters.type !== '') {
    query = query.eq('letter_type', filters.type);
  }
  if (filters.status !== '') query = query.eq('status', filters.status);
  if (filters.from !== '') query = query.gte('letter_date', filters.from);
  if (filters.to !== '') query = query.lte('letter_date', filters.to);
  if (cursor !== null) {
    // Both components were validated before interpolation into PostgREST's OR.
    query = query.or(
      `letter_date.lt.${cursor.date},and(letter_date.eq.${cursor.date},id.lt.${cursor.id})`,
    );
  }
  query = query
    .order('letter_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(APS_LETTERS_PAGE_SIZE + 1);
  if (signal !== undefined) query = query.abortSignal(signal);
  const response = await query;
  ensureResponse(response);
  if (!Array.isArray(response.data)) throw new ApsLettersError('invalid');
  const parsed = response.data.map(parseApsLetter);
  const letters = parsed.slice(0, APS_LETTERS_PAGE_SIZE);
  const last = letters.at(-1);
  return {
    letters,
    nextCursor:
      parsed.length > APS_LETTERS_PAGE_SIZE && last !== undefined
        ? { date: last.date, id: last.id }
        : null,
  };
}

export async function fetchApsLetterDetail(
  id: string,
  signal?: AbortSignal,
): Promise<ApsLetterDetail | null> {
  if (!isLetterId(id)) throw new ApsLettersError('invalid');
  const client = requireClient();
  await assertLetterAccess(client);

  let headerQuery = client.from('letters').select(APS_LETTER_SELECT).eq('id', id);
  if (signal !== undefined) headerQuery = headerQuery.abortSignal(signal);
  const header = await headerQuery.maybeSingle();
  ensureResponse(header);
  // An absent and an RLS-hidden letter must be indistinguishable.
  if (header.data === null) return null;
  const letter = parseApsLetter(header.data);

  let lineQuery = client
    .from('letter_lines')
    .select(APS_LETTER_LINE_SELECT)
    .eq('letter_id', id)
    .order('line_number', { ascending: true })
    // The schema bounds line_number to 1..500 and makes it unique per letter.
    .limit(500);
  if (signal !== undefined) lineQuery = lineQuery.abortSignal(signal);
  const lines = await lineQuery;
  ensureResponse(lines);
  if (!Array.isArray(lines.data)) throw new ApsLettersError('invalid');
  return { letter, lines: lines.data.map(parseApsLetterLine) };
}

export function apsLettersQueryKey(
  actorId: string | null,
  filters: LetterFilters,
  cursor: LetterCursor | null,
) {
  return [
    'aps',
    'letters',
    actorId,
    filters,
    cursor === null ? null : encodeLetterCursor(cursor),
  ] as const;
}

export function useApsLetters(
  filters: LetterFilters,
  initialCursor: LetterCursor | null,
  valid: boolean,
) {
  const { session } = useAuth();
  const actorId = session?.user.id ?? null;
  return useInfiniteQuery<
    ApsLettersPage,
    Error,
    InfiniteData<ApsLettersPage, LetterCursor | null>,
    ReturnType<typeof apsLettersQueryKey>,
    LetterCursor | null
  >({
    queryKey: apsLettersQueryKey(actorId, filters, initialCursor),
    initialPageParam: initialCursor,
    enabled: actorId !== null && valid,
    retry: false,
    staleTime: 5_000,
    queryFn: ({ pageParam, signal }) => fetchApsLettersPage(filters, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useApsLetterDetail(id: string) {
  const { session } = useAuth();
  const actorId = session?.user.id ?? null;
  return useQuery({
    queryKey: ['aps', 'letter-detail', actorId, id],
    enabled: actorId !== null && isLetterId(id),
    retry: false,
    queryFn: ({ signal }) => fetchApsLetterDetail(id, signal),
  });
}
