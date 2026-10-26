import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

const FISCAL_YEAR_SELECT =
  'id, name, start_date, end_date, is_active, is_closed, supplements_open, created_at, updated_at';
const FISCAL_MONTH_SELECT =
  'id, fiscal_year_id, month_number, name, start_date, end_date, current_period, is_closed, created_at, updated_at';
const OPENING_BALANCE_SELECT =
  'id, fiscal_year_id, warehouse_id, classification_id, amount, created_at, updated_at';

export type FiscalSettingsReadErrorCode = 'unavailable' | 'forbidden' | 'network' | 'unknown';

export type FiscalSettingsWriteErrorCode =
  'unavailable' | 'forbidden' | 'network' | 'validation' | 'duplicate' | 'notFound' | 'unknown';

export type FiscalSettingsWriteOperation =
  'createYear' | 'activateYear' | 'updatePeriod' | 'saveOpeningBalances';

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
  return {
    invalidateYears: () => {
      void queryClient.invalidateQueries({ queryKey: FISCAL_YEARS_QUERY_KEY });
    },
    invalidateMonths: (fiscalYearId?: string) => {
      void queryClient.invalidateQueries({
        queryKey:
          fiscalYearId === undefined
            ? FISCAL_MONTHS_QUERY_KEY
            : [...FISCAL_MONTHS_QUERY_KEY, fiscalYearId],
      });
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
    queryFn: async (): Promise<readonly OpeningBalance[]> => {
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
      return data ?? [];
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
    mutationFn: async (input: SaveOpeningBalancesInput): Promise<readonly OpeningBalance[]> => {
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
      return data ?? [];
    },
    onSuccess: (savedRows, input) => {
      const queryKey = [...OPENING_BALANCES_QUERY_KEY, input.fiscalYearId] as const;
      queryClient.setQueryData<readonly OpeningBalance[]>(queryKey, (current) => {
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
