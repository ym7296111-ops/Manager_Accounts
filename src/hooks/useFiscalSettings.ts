import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ENTRY_OPTIONS_QUERY_KEY } from '@/hooks/useApsLetterEntry';
import { classifyPostgrestReadError } from '@/hooks/postgrestReadError';
import type { Database } from '@/lib/database.types';
import { getSupabase } from '@/lib/supabase';

export type FiscalYear = Database['public']['Tables']['fiscal_years']['Row'];
export type FiscalMonth = Database['public']['Tables']['fiscal_months']['Row'];
export type OpeningBalance = Database['public']['Tables']['opening_balances']['Row'];

export const FISCAL_YEARS_QUERY_KEY = ['project-settings', 'fiscal-years'] as const;
export const FISCAL_MONTHS_QUERY_KEY = ['project-settings', 'fiscal-months'] as const;
export const OPENING_BALANCES_QUERY_KEY = ['project-settings', 'opening-balances'] as const;
export const OPENING_BALANCES_CONFLICT_TARGET =
  'fiscal_year_id,warehouse_id,classification_id' as const;

/* One literal, never a concatenation: the Supabase client infers the response
   type by parsing this string, and `a + b` degrades every result to
   `GenericStringError`. Prettier leaves long strings alone, which is why this
   line is wider than the print width. */
const FISCAL_YEAR_SELECT =
  'id, name, start_date, end_date, is_active, is_closed, supplements_open, opening_balances_locked, created_at, updated_at';
const FISCAL_MONTH_SELECT =
  'id, fiscal_year_id, month_number, name, start_date, end_date, current_period, is_closed, created_at, updated_at';

/**
 * The classification columns an opening-balance row needs to render.
 *
 * `is_leaf` and `is_active` are derived by the classifications triggers. They
 * are read next to the balance — in the same response — so the editor cannot
 * observe a row and its classification from two different instants. That is
 * what makes the "needs review" state (a saved balance whose classification
 * stopped being an active leaf) exact rather than a guess.
 */
export const OPENING_BALANCE_CLASSIFICATION_SELECT = 'id, code, name, is_leaf, is_active';

/**
 * Balances plus their classification, in one request.
 *
 * `!classification_id` pins the embed to the balance's own foreign key, the
 * same disambiguation rule the users/support embeds follow (see
 * `src/hooks/postgrest-embeds.test.ts`): an unqualified `classifications(...)`
 * succeeds today but breaks the moment a second relationship to that table is
 * added, and it fails as an empty response rather than an error. The hint must
 * not be aliased — the response key stays `classifications`.
 */
export const OPENING_BALANCE_SELECT =
  `id, fiscal_year_id, warehouse_id, classification_id, amount, created_at, updated_at, ` +
  `classifications!classification_id(${OPENING_BALANCE_CLASSIFICATION_SELECT})`;

export type FiscalSettingsReadErrorCode = 'unavailable' | 'forbidden' | 'network' | 'unknown';

export type FiscalSettingsWriteErrorCode =
  'unavailable' | 'forbidden' | 'network' | 'validation' | 'duplicate' | 'notFound' | 'unknown';

export type FiscalSettingsWriteOperation =
  | 'createYear'
  | 'activateYear'
  | 'updatePeriod'
  | 'saveOpeningBalances'
  | 'deleteOpeningBalance'
  | 'setOpeningBalancesLock';

/** The classification embedded in an opening-balance response. */
export interface OpeningBalanceClassification {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isLeaf: boolean;
  readonly isActive: boolean;
}

/**
 * A balance row as read from the database, with its classification.
 *
 * `classification` is `null` only when the embedded row is missing or
 * malformed: the foreign key is `ON DELETE RESTRICT`, so a real balance always
 * points at a real classification. Callers must still render the money — a
 * balance is never dropped because its label could not be read.
 */
export interface OpeningBalanceRow extends OpeningBalance {
  readonly classification: OpeningBalanceClassification | null;
}

/**
 * Why a saved balance is not editable in the classification list of its
 * warehouse. `null` means it is a normal, editable row.
 *
 * - `not_leaf`: a child classification was added underneath it, so the editor's
 *   leaf list no longer contains it.
 * - `inactive`: the classification was deactivated.
 * - `unavailable`: the embedded classification could not be read; the amount is
 *   still real and must still be shown (and counted).
 */
export type OpeningBalanceReviewReason = 'not_leaf' | 'inactive' | 'unavailable';

export function openingBalanceReviewReason(
  row: OpeningBalanceRow,
): OpeningBalanceReviewReason | null {
  if (row.classification === null) {
    return 'unavailable';
  }
  if (!row.classification.isLeaf) {
    return 'not_leaf';
  }
  if (!row.classification.isActive) {
    return 'inactive';
  }
  return null;
}

/**
 * The bounds of the write-path validator (`isValidOpeningAmount`): up to 16
 * integer digits and at most two decimals, never negative. A read that falls
 * outside them is malformed, not merely surprising.
 */
const BALANCE_AMOUNT_PATTERN = /^\d{1,16}(?:\.\d{1,2})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * PostgREST sends `numeric` as a JSON number. A string is accepted defensively
 * (a proxy or a future `casts` change can do that) as long as it is a plain
 * non-negative decimal that fits the column.
 */
function readAmount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && BALANCE_AMOUNT_PATTERN.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseClassification(value: unknown): OpeningBalanceClassification | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const id = readNonEmptyString(value.id);
  const code = readNonEmptyString(value.code);
  const name = readNonEmptyString(value.name);
  if (id === null || code === null || name === null) {
    return null;
  }
  return {
    id,
    code,
    name,
    isLeaf: value.is_leaf === true,
    isActive: value.is_active === true,
  };
}

/**
 * Normalize an opening-balance response.
 *
 * Malformed rows are dropped rather than throwing, exactly like
 * `parseClassifications` and `parseStationsDirectory`: one bad row must not
 * blank the screen. A row is only malformed when an identifier or the amount
 * cannot be read; a missing classification is not — those rows are kept and
 * surface as `unavailable` so the amount stays visible.
 *
 * The order is the server's (`warehouse_id`, then `classification_id`); display
 * ordering by classification code is applied by the editor, where the code is
 * known.
 */
export function parseOpeningBalances(raw: unknown): readonly OpeningBalanceRow[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const byId = new Map<string, OpeningBalanceRow>();
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = readNonEmptyString(entry.id);
    const fiscalYearId = readNonEmptyString(entry.fiscal_year_id);
    const warehouseId = readNonEmptyString(entry.warehouse_id);
    const classificationId = readNonEmptyString(entry.classification_id);
    const amount = readAmount(entry.amount);
    if (
      id === null ||
      fiscalYearId === null ||
      warehouseId === null ||
      classificationId === null ||
      amount === null ||
      byId.has(id)
    ) {
      continue;
    }

    byId.set(id, {
      id,
      fiscal_year_id: fiscalYearId,
      warehouse_id: warehouseId,
      classification_id: classificationId,
      amount,
      created_at: typeof entry.created_at === 'string' ? entry.created_at : '',
      updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : '',
      classification: parseClassification(entry.classifications),
    });
  }

  return [...byId.values()];
}

export class FiscalSettingsError extends Error {
  readonly code: FiscalSettingsReadErrorCode;

  constructor(code: FiscalSettingsReadErrorCode) {
    super(code);
    this.name = 'FiscalSettingsError';
    this.code = code;
  }
}

export class FiscalSettingsWriteError extends Error {
  readonly code: FiscalSettingsWriteErrorCode;

  constructor(code: FiscalSettingsWriteErrorCode) {
    super(code);
    this.name = 'FiscalSettingsWriteError';
    this.code = code;
  }
}

export interface CreateFiscalYearInput {
  readonly start_date: string;
  readonly end_date: string;
}

export interface UpdateFiscalPeriodInput {
  readonly fiscalYearId: string;
  readonly monthId: string;
  readonly currentPeriod: number;
}

/** `numeric(18,2)` travels as a decimal string so the browser cannot round cents. */
export interface OpeningBalanceWrite {
  readonly fiscal_year_id: string;
  readonly warehouse_id: string;
  readonly classification_id: string;
  readonly amount: string;
}

export interface SaveOpeningBalancesInput {
  readonly fiscalYearId: string;
  readonly rows: readonly OpeningBalanceWrite[];
}

export interface DeleteOpeningBalanceInput {
  readonly fiscalYearId: string;
  readonly balanceId: string;
}

/**
 * The freeze switch. `locked: true` closes the year's opening balances to every
 * write (RLS on `opening_balances`), `false` reopens them; the transition is
 * audited by the database, not by the client.
 */
export interface SetOpeningBalancesLockInput {
  readonly fiscalYearId: string;
  readonly locked: boolean;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function isValidFiscalYearRange(startDate: string, endDate: string): boolean {
  return isIsoDate(startDate) && isIsoDate(endDate) && startDate < endDate;
}

function isValidOpeningAmount(value: string): boolean {
  if (!/^\d{1,16}(?:\.\d{0,2})?$/.test(value)) {
    return false;
  }
  const integerPart = value.split('.', 1)[0] ?? '';
  return integerPart !== '' && BigInt(integerPart) <= 9_999_999_999_999_999n;
}

export function classifyFiscalSettingsReadError(error: unknown): FiscalSettingsReadErrorCode {
  if (error instanceof FiscalSettingsError) {
    return error.code;
  }
  return classifyPostgrestReadError(error);
}

export function classifyFiscalSettingsWriteError(
  error: unknown,
  _operation: FiscalSettingsWriteOperation,
): FiscalSettingsWriteErrorCode {
  if (error instanceof FiscalSettingsWriteError) {
    return error.code;
  }

  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';

  if (
    code === '42501' ||
    code === 'PGRST301' ||
    message.includes('permission denied') ||
    message.includes('permission_denied') ||
    message.includes('jwt')
  ) {
    return 'forbidden';
  }
  if (code === '23505') {
    return 'duplicate';
  }
  if (code === '23514' || code === '22P02' || code === '22007' || code === '22008') {
    return 'validation';
  }
  if (code === 'PGRST116' || code === 'P0002') {
    return 'notFound';
  }
  if (
    code === 'PGRST503' ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('timeout')
  ) {
    return 'network';
  }
  return 'unknown';
}

function requireSupabase() {
  const supabase = getSupabase();
  if (supabase === null) {
    throw new FiscalSettingsWriteError('unavailable');
  }
  return supabase;
}

function unwrapWrite<T>(
  data: T | null,
  error: { code?: string; message?: string } | null | undefined,
  operation: FiscalSettingsWriteOperation,
): T {
  if (error !== null && error !== undefined) {
    throw new FiscalSettingsWriteError(classifyFiscalSettingsWriteError(error, operation));
  }
  if (data === null) {
    throw new FiscalSettingsWriteError('notFound');
  }
  return data;
}

function useInvalidateFiscalSettings() {
  const queryClient = useQueryClient();
  /* The entry screen states the active period from its own choices payload, so
     every settings write that can move the period refreshes that payload too —
     otherwise the bar keeps naming the month the clerk just replaced. */
  const invalidateEntryOptions = () => {
    void queryClient.invalidateQueries({ queryKey: ENTRY_OPTIONS_QUERY_KEY });
  };
  return {
    invalidateEntryOptions,
    invalidateYears: () => {
      void queryClient.invalidateQueries({ queryKey: FISCAL_YEARS_QUERY_KEY });
      invalidateEntryOptions();
    },
    invalidateMonths: (fiscalYearId?: string) => {
      void queryClient.invalidateQueries({
        queryKey:
          fiscalYearId === undefined
            ? FISCAL_MONTHS_QUERY_KEY
            : [...FISCAL_MONTHS_QUERY_KEY, fiscalYearId],
      });
      invalidateEntryOptions();
    },
    invalidateBalances: (fiscalYearId?: string) => {
      void queryClient.invalidateQueries({
        queryKey:
          fiscalYearId === undefined
            ? OPENING_BALANCES_QUERY_KEY
            : [...OPENING_BALANCES_QUERY_KEY, fiscalYearId],
      });
    },
  };
}

export function useFiscalYears() {
  return useQuery({
    queryKey: FISCAL_YEARS_QUERY_KEY,
    queryFn: async (): Promise<readonly FiscalYear[]> => {
      const supabase = getSupabase();
      if (supabase === null) {
        throw new FiscalSettingsError('unavailable');
      }

      const { data, error } = await supabase
        .from('fiscal_years')
        .select(FISCAL_YEAR_SELECT)
        .order('start_date', { ascending: false });

      if (error !== null && error !== undefined) {
        throw new FiscalSettingsError(classifyFiscalSettingsReadError(error));
      }
      return data ?? [];
    },
  });
}

export function useFiscalMonths(fiscalYearId: string | null) {
  return useQuery({
    queryKey: [...FISCAL_MONTHS_QUERY_KEY, fiscalYearId],
    enabled: fiscalYearId !== null,
    queryFn: async (): Promise<readonly FiscalMonth[]> => {
      if (fiscalYearId === null) {
        return [];
      }
      const supabase = getSupabase();
      if (supabase === null) {
        throw new FiscalSettingsError('unavailable');
      }

      const { data, error } = await supabase
        .from('fiscal_months')
        .select(FISCAL_MONTH_SELECT)
        .eq('fiscal_year_id', fiscalYearId)
        .order('month_number', { ascending: true });

      if (error !== null && error !== undefined) {
        throw new FiscalSettingsError(classifyFiscalSettingsReadError(error));
      }
      return data ?? [];
    },
  });
}

export function useOpeningBalances(fiscalYearId: string | null) {
  return useQuery({
    queryKey: [...OPENING_BALANCES_QUERY_KEY, fiscalYearId],
    enabled: fiscalYearId !== null,
    queryFn: async (): Promise<readonly OpeningBalanceRow[]> => {
      if (fiscalYearId === null) {
        return [];
      }
      const supabase = getSupabase();
      if (supabase === null) {
        throw new FiscalSettingsError('unavailable');
      }

      const { data, error } = await supabase
        .from('opening_balances')
        .select(OPENING_BALANCE_SELECT)
        .eq('fiscal_year_id', fiscalYearId)
        .order('warehouse_id', { ascending: true })
        .order('classification_id', { ascending: true });

      if (error !== null && error !== undefined) {
        throw new FiscalSettingsError(classifyFiscalSettingsReadError(error));
      }
      return parseOpeningBalances(data);
    },
  });
}

export function useCreateFiscalYear() {
  const queryClient = useQueryClient();
  const invalidation = useInvalidateFiscalSettings();

  return useMutation({
    mutationFn: async (input: CreateFiscalYearInput): Promise<FiscalYear> => {
      if (!isValidFiscalYearRange(input.start_date, input.end_date)) {
        throw new FiscalSettingsWriteError('validation');
      }
      const supabase = requireSupabase();
      const payload = { start_date: input.start_date, end_date: input.end_date };
      const { data, error } = await supabase
        .from('fiscal_years')
        .insert(payload)
        .select(FISCAL_YEAR_SELECT)
        .single();
      return unwrapWrite(data, error, 'createYear');
    },
    onSuccess: (year) => {
      queryClient.setQueryData<readonly FiscalYear[]>(FISCAL_YEARS_QUERY_KEY, (current) =>
        current === undefined
          ? [year]
          : [year, ...current.filter((candidate) => candidate.id !== year.id)].sort((a, b) =>
              b.start_date.localeCompare(a.start_date),
            ),
      );
      invalidation.invalidateYears();
      invalidation.invalidateMonths();
    },
  });
}

export function useActivateFiscalYear() {
  const queryClient = useQueryClient();
  const invalidation = useInvalidateFiscalSettings();

  return useMutation({
    mutationFn: async (fiscalYearId: string): Promise<FiscalYear> => {
      if (fiscalYearId.trim() === '') {
        throw new FiscalSettingsWriteError('validation');
      }
      const supabase = requireSupabase();
      const { data, error } = await supabase
        .from('fiscal_years')
        .update({ is_active: true })
        .eq('id', fiscalYearId)
        .select(FISCAL_YEAR_SELECT)
        .single();
      return unwrapWrite(data, error, 'activateYear');
    },
    onSuccess: (activeYear) => {
      queryClient.setQueryData<readonly FiscalYear[]>(FISCAL_YEARS_QUERY_KEY, (current) =>
        current?.map((year) => ({ ...year, is_active: year.id === activeYear.id })),
      );
      invalidation.invalidateYears();
    },
  });
}

export function useUpdateFiscalPeriod() {
  const queryClient = useQueryClient();
  const invalidation = useInvalidateFiscalSettings();

  return useMutation({
    mutationFn: async (input: UpdateFiscalPeriodInput): Promise<FiscalMonth> => {
      if (
        input.monthId.trim() === '' ||
        input.fiscalYearId.trim() === '' ||
        !Number.isSafeInteger(input.currentPeriod) ||
        input.currentPeriod < 1
      ) {
        throw new FiscalSettingsWriteError('validation');
      }
      const supabase = requireSupabase();
      // The only client-controlled column is current_period. Row-level security
      // remains the database's authority, even though the route is capability-gated.
      const { data, error } = await supabase
        .from('fiscal_months')
        .update({ current_period: input.currentPeriod })
        .eq('id', input.monthId)
        .select(FISCAL_MONTH_SELECT)
        .single();
      return unwrapWrite(data, error, 'updatePeriod');
    },
    onSuccess: (month, input) => {
      const queryKey = [...FISCAL_MONTHS_QUERY_KEY, input.fiscalYearId] as const;
      queryClient.setQueryData<readonly FiscalMonth[]>(queryKey, (current) =>
        current?.map((candidate) => (candidate.id === month.id ? month : candidate)),
      );
      invalidation.invalidateMonths(input.fiscalYearId);
    },
  });
}

export function useSaveOpeningBalances() {
  const queryClient = useQueryClient();
  const invalidation = useInvalidateFiscalSettings();

  return useMutation({
    mutationFn: async (input: SaveOpeningBalancesInput): Promise<readonly OpeningBalanceRow[]> => {
      if (input.fiscalYearId.trim() === '' || input.rows.length === 0) {
        throw new FiscalSettingsWriteError('validation');
      }

      const seenKeys = new Set<string>();
      for (const row of input.rows) {
        const key = `${row.fiscal_year_id}:${row.warehouse_id}:${row.classification_id}`;
        if (
          row.fiscal_year_id !== input.fiscalYearId ||
          row.warehouse_id.trim() === '' ||
          row.classification_id.trim() === '' ||
          seenKeys.has(key) ||
          !isValidOpeningAmount(row.amount)
        ) {
          throw new FiscalSettingsWriteError('validation');
        }
        seenKeys.add(key);
      }

      const supabase = requireSupabase();
      // Preserve exact decimal cents in the JSON request. Supabase's generated
      // numeric type is `number`; Postgres numeric accepts this decimal string.
      const payload = input.rows.map((row) => ({
        fiscal_year_id: row.fiscal_year_id,
        warehouse_id: row.warehouse_id,
        classification_id: row.classification_id,
        amount: row.amount,
      }));
      const { data, error } = await supabase
        .from('opening_balances')
        .upsert(
          payload as unknown as Database['public']['Tables']['opening_balances']['Insert'][],
          { onConflict: OPENING_BALANCES_CONFLICT_TARGET },
        )
        .select(OPENING_BALANCE_SELECT);

      if (error !== null && error !== undefined) {
        throw new FiscalSettingsWriteError(
          classifyFiscalSettingsWriteError(error, 'saveOpeningBalances'),
        );
      }
      return parseOpeningBalances(data);
    },
    onSuccess: (savedRows, input) => {
      const queryKey = [...OPENING_BALANCES_QUERY_KEY, input.fiscalYearId] as const;
      queryClient.setQueryData<readonly OpeningBalanceRow[]>(queryKey, (current) => {
        const merged = new Map(
          (current ?? []).map((row) => [
            `${row.fiscal_year_id}:${row.warehouse_id}:${row.classification_id}`,
            row,
          ]),
        );
        for (const row of savedRows) {
          merged.set(`${row.fiscal_year_id}:${row.warehouse_id}:${row.classification_id}`, row);
        }
        return [...merged.values()];
      });
      invalidation.invalidateBalances(input.fiscalYearId);
    },
  });
}

/**
 * Remove one saved opening balance.
 *
 * Deleting is deliberately a separate request from `useSaveOpeningBalances`: a
 * warehouse save stays a single upsert, so a failure can never leave a batch
 * half saved and half deleted. The database records the removal itself — the
 * audit trigger on `public.opening_balances` writes `opening_balance.deleted`
 * with the old amount (`20261111000000_opening_balances_delete_audit.sql`) —
 * so the client only has to identify the row.
 *
 * Both filters are sent. `id` alone is enough for the primary key, but scoping
 * by `fiscal_year_id` keeps a stale row from a previous year from being
 * deleted by a double click after the year switched.
 *
 * Zero affected rows is reported as `notFound`, never as success. That case
 * covers two indistinguishable situations: the row was already deleted in
 * another session, or row-level security filtered it out because the caller
 * lost `project.settings:manage`. The editor treats it as "refresh and look
 * again" rather than claiming a deletion that may not have happened.
 */
export function useDeleteOpeningBalance() {
  const queryClient = useQueryClient();
  const invalidation = useInvalidateFiscalSettings();

  return useMutation({
    mutationFn: async (input: DeleteOpeningBalanceInput): Promise<string> => {
      if (input.fiscalYearId.trim() === '' || input.balanceId.trim() === '') {
        throw new FiscalSettingsWriteError('validation');
      }

      const supabase = requireSupabase();
      const { data, error } = await supabase
        .from('opening_balances')
        .delete()
        .eq('id', input.balanceId)
        .eq('fiscal_year_id', input.fiscalYearId)
        .select('id');

      if (error !== null && error !== undefined) {
        throw new FiscalSettingsWriteError(
          classifyFiscalSettingsWriteError(error, 'deleteOpeningBalance'),
        );
      }

      const deleted = Array.isArray(data) ? data.length : 0;
      if (deleted === 0) {
        throw new FiscalSettingsWriteError('notFound');
      }

      return input.balanceId;
    },
    onSuccess: (balanceId, input) => {
      queryClient.setQueryData<readonly OpeningBalanceRow[]>(
        [...OPENING_BALANCES_QUERY_KEY, input.fiscalYearId],
        (current) => current?.filter((row) => row.id !== balanceId),
      );
      invalidation.invalidateBalances(input.fiscalYearId);
    },
  });
}

/**
 * Switch «قفل أرصدة أول المدة» for one fiscal year.
 *
 * Only `opening_balances_locked` is sent. `fiscal_years` has a BEFORE trigger
 * that derives `name` and rotates `is_active`, so a client that also sent those
 * columns would fight the trigger; the column-scoped payload keeps the write
 * exactly as wide as the intent.
 *
 * The database enforces the consequence — the RLS policies on
 * `opening_balances` compare the target year against this same column — and it
 * audits the transition (`fiscal_year.opening_balances_locked` /
 * `..._unlocked`) inside the same statement. The client's job is only to flip
 * the switch and refresh what it caches.
 *
 * Zero rows is `notFound`, never success: `.single()` turns that into
 * PGRST116, which is what an operator who lost `project.settings:manage`
 * mid-session (or a year that was deleted elsewhere) sees.
 */
export function useSetOpeningBalancesLock() {
  const queryClient = useQueryClient();
  const invalidation = useInvalidateFiscalSettings();

  return useMutation({
    mutationFn: async (input: SetOpeningBalancesLockInput): Promise<FiscalYear> => {
      if (input.fiscalYearId.trim() === '' || typeof input.locked !== 'boolean') {
        throw new FiscalSettingsWriteError('validation');
      }

      const supabase = requireSupabase();
      const { data, error } = await supabase
        .from('fiscal_years')
        .update({ opening_balances_locked: input.locked })
        .eq('id', input.fiscalYearId)
        .select(FISCAL_YEAR_SELECT)
        .single();

      return unwrapWrite(data, error, 'setOpeningBalancesLock');
    },
    onSuccess: (year) => {
      queryClient.setQueryData<readonly FiscalYear[]>(FISCAL_YEARS_QUERY_KEY, (current) =>
        current?.map((candidate) => (candidate.id === year.id ? year : candidate)),
      );
      invalidation.invalidateYears();
      /* The editor derives every disabled state from the year row, but a lock
         also changes what the balance queries may do; invalidating them keeps
         a second tab from saving into a year that just closed. */
      invalidation.invalidateBalances(year.id);
    },
  });
}
