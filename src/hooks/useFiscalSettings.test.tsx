import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENTRY_OPTIONS_QUERY_KEY } from '@/hooks/useApsLetterEntry';
import {
  FiscalSettingsWriteError,
  OPENING_BALANCE_SELECT,
  OPENING_BALANCES_QUERY_KEY,
  openingBalanceReviewReason,
  parseOpeningBalances,
  FISCAL_YEARS_QUERY_KEY,
  FISCAL_MONTHS_QUERY_KEY,
  useActivateFiscalMonth,
  useDeleteOpeningBalance,
  useFiscalMonths,
  useOpeningBalances,
  useSetOpeningBalancesLock,
  useUpdateFiscalPeriod,
  type OpeningBalanceRow,
} from '@/hooks/useFiscalSettings';

interface RecordedCalls {
  table: string | undefined;
  select: string | undefined;
  deleted: boolean;
  updated: unknown;
  filters: Array<readonly [string, unknown]>;
  orders: string[];
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
}

const { mock, calls } = vi.hoisted(() => {
  const response: { data: unknown; error: unknown } = { data: [], error: null };
  const recorded: RecordedCalls = {
    table: undefined,
    select: undefined,
    deleted: false,
    updated: undefined,
    filters: [],
    orders: [],
    rpcs: [],
  };
  const rpcResponse: { data: unknown; error: unknown } = { data: null, error: null };
  return {
    mock: {
      client: null as {
        from: (table: string) => unknown;
        rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      } | null,
      response,
      rpcResponse,
    },
    calls: recorded,
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mock.client }));

/**
 * Thenable PostgREST stub covering the two shapes this module uses:
 * `select(...).eq(...).order(...).order(...)` and
 * `delete().eq(...).eq(...).select('id')`.
 *
 * Everything is recorded so a test can assert the exact projection and filters
 * that reached the wire — the read joins `classifications` through its foreign
 * key, and a lost hint is invisible in a mocked response.
 */
function configureClient() {
  calls.table = undefined;
  calls.select = undefined;
  calls.deleted = false;
  calls.updated = undefined;
  calls.filters = [];
  calls.orders = [];
  calls.rpcs = [];
  mock.rpcResponse = { data: null, error: null };

  mock.client = {
    rpc: (name, args) => {
      calls.rpcs.push({ name, args });
      return Promise.resolve(mock.rpcResponse);
    },
    from: (table: string) => {
      calls.table = table;
      const resolveWith = () => Promise.resolve(mock.response);
      const terminal = {
        then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void): void => {
          resolveWith().then(resolve, reject);
        },
        single: resolveWith,
      };
      const ordering = {
        order: (column: string) => {
          calls.orders.push(column);
          return ordering;
        },
        then: terminal.then,
      };
      const filtered = {
        eq: (column: string, value: unknown) => {
          calls.filters.push([column, value]);
          return filtered;
        },
        order: ordering.order,
        select: (projection: string) => {
          calls.select = projection;
          return terminal;
        },
        then: terminal.then,
      };
      return {
        select: (projection: string) => {
          calls.select = projection;
          return filtered;
        },
        delete: () => {
          calls.deleted = true;
          return filtered;
        },
        update: (payload: unknown) => {
          calls.updated = payload;
          return filtered;
        },
      };
    },
  };
}

function respondWith(data: unknown, error: unknown = null) {
  mock.response = { data, error };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
}

function mountQuery<T>(hook: () => T, queryClient = createQueryClient()) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(hook, { wrapper: Wrapper }), queryClient };
}

function balanceWireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'balance-1',
    fiscal_year_id: 'year-1',
    warehouse_id: 'warehouse-1',
    classification_id: 'classification-1',
    amount: 125.5,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    classifications: {
      id: 'classification-1',
      code: 'CLS-001',
      name: 'حديد وصلب',
      is_leaf: true,
      is_active: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  respondWith([]);
  configureClient();
});

describe('OPENING_BALANCE_SELECT', () => {
  it('pins the classifications embed to the balance foreign key', () => {
    expect(OPENING_BALANCE_SELECT).toContain('classifications!classification_id(');
  });

  it('never uses a bare, ambiguous classifications embed', () => {
    expect(OPENING_BALANCE_SELECT).not.toMatch(/(^|[^!])classifications\(/);
  });

  it('keeps the response key `classifications` (no aliasing)', () => {
    /* `alias:classifications!classification_id(...)` would rename the embedded
       key and break parseOpeningBalances, which reads `entry.classifications`. */
    expect(OPENING_BALANCE_SELECT).not.toMatch(/:\s*classifications!/);
  });
});

describe('parseOpeningBalances', () => {
  it('reads a row with its embedded classification', () => {
    const parsed = parseOpeningBalances([balanceWireRow()]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: 'balance-1',
      fiscal_year_id: 'year-1',
      warehouse_id: 'warehouse-1',
      classification_id: 'classification-1',
      amount: 125.5,
      classification: {
        id: 'classification-1',
        code: 'CLS-001',
        name: 'حديد وصلب',
        isLeaf: true,
        isActive: true,
      },
    });
  });

  it('accepts a decimal string amount from a numeric column', () => {
    const parsed = parseOpeningBalances([balanceWireRow({ amount: '125.50' })]);

    expect(parsed[0]?.amount).toBe(125.5);
  });

  it('keeps a row whose classification could not be read, so the money stays visible', () => {
    const parsed = parseOpeningBalances([
      balanceWireRow({ classifications: null }),
      balanceWireRow({ id: 'balance-2', classifications: { id: 'classification-1' } }),
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed.every((row) => row.classification === null)).toBe(true);
  });

  it('drops malformed rows instead of blanking the screen', () => {
    const parsed = parseOpeningBalances([
      balanceWireRow({ id: '' }),
      balanceWireRow({ id: 'balance-2', amount: -0.01 }),
      balanceWireRow({ id: 'balance-3', amount: 'not-a-number' }),
      balanceWireRow({ id: 'balance-4', warehouse_id: null }),
      balanceWireRow({ id: 'balance-5', classification_id: undefined }),
      'not-a-row',
      null,
      /* A duplicate primary key cannot exist in the table; first one wins. */
      balanceWireRow(),
    ]);

    expect(parsed.map((row) => row.id)).toEqual(['balance-1']);
  });

  it('returns an empty list for a non-array payload', () => {
    expect(parseOpeningBalances(null)).toEqual([]);
    expect(parseOpeningBalances({ data: [] })).toEqual([]);
  });
});

describe('openingBalanceReviewReason', () => {
  const row = (classification: OpeningBalanceRow['classification']): OpeningBalanceRow => ({
    id: 'balance-1',
    fiscal_year_id: 'year-1',
    warehouse_id: 'warehouse-1',
    classification_id: 'classification-1',
    amount: 10,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    classification,
  });

  it('returns null for an active leaf', () => {
    expect(
      openingBalanceReviewReason(
        row({ id: 'c', code: 'CLS-001', name: 'ورقة', isLeaf: true, isActive: true }),
      ),
    ).toBeNull();
  });

  it('flags a classification that gained children', () => {
    expect(
      openingBalanceReviewReason(
        row({ id: 'c', code: 'CLS-001', name: 'صار أباً', isLeaf: false, isActive: true }),
      ),
    ).toBe('not_leaf');
  });

  it('flags a deactivated classification', () => {
    expect(
      openingBalanceReviewReason(
        row({ id: 'c', code: 'CLS-001', name: 'معطّل', isLeaf: true, isActive: false }),
      ),
    ).toBe('inactive');
  });

  it('flags an unreadable classification rather than hiding the balance', () => {
    expect(openingBalanceReviewReason(row(null))).toBe('unavailable');
  });
});

describe('useOpeningBalances', () => {
  it('reads the joined projection for one fiscal year and parses the rows', async () => {
    respondWith([balanceWireRow()]);
    const { result } = mountQuery(() => useOpeningBalances('year-1'));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls.table).toBe('opening_balances');
    expect(calls.select).toBe(OPENING_BALANCE_SELECT);
    expect(calls.filters).toEqual([['fiscal_year_id', 'year-1']]);
    expect(calls.orders).toEqual(['warehouse_id', 'classification_id']);
    expect(result.current.data?.[0]?.classification?.code).toBe('CLS-001');
  });

  it('does not query without an active fiscal year', () => {
    mountQuery(() => useOpeningBalances(null));

    expect(calls.table).toBeUndefined();
  });
});

describe('useDeleteOpeningBalance', () => {
  function seedCache(queryClient: QueryClient): readonly OpeningBalanceRow[] {
    const seeded = parseOpeningBalances([
      balanceWireRow(),
      balanceWireRow({ id: 'balance-2', classification_id: 'classification-2' }),
    ]);
    queryClient.setQueryData([...OPENING_BALANCES_QUERY_KEY, 'year-1'], seeded);
    return seeded;
  }

  it('deletes by id scoped to the fiscal year', async () => {
    respondWith([{ id: 'balance-1' }]);
    const queryClient = createQueryClient();
    seedCache(queryClient);
    const { result } = mountQuery(() => useDeleteOpeningBalance(), queryClient);

    await expect(
      result.current.mutateAsync({ fiscalYearId: 'year-1', balanceId: 'balance-1' }),
    ).resolves.toBe('balance-1');

    expect(calls.table).toBe('opening_balances');
    expect(calls.deleted).toBe(true);
    expect(calls.filters).toEqual([
      ['id', 'balance-1'],
      ['fiscal_year_id', 'year-1'],
    ]);
    expect(calls.select).toBe('id');

    const cached = queryClient.getQueryData<readonly OpeningBalanceRow[]>([
      ...OPENING_BALANCES_QUERY_KEY,
      'year-1',
    ]);
    expect(cached?.map((row) => row.id)).toEqual(['balance-2']);
  });

  it('reports zero affected rows as notFound, never as success', async () => {
    respondWith([]);
    const queryClient = createQueryClient();
    seedCache(queryClient);
    const { result } = mountQuery(() => useDeleteOpeningBalance(), queryClient);

    await expect(
      result.current.mutateAsync({ fiscalYearId: 'year-1', balanceId: 'balance-1' }),
    ).rejects.toMatchObject({ code: 'notFound' });

    /* Nothing is removed from the cache on an unknown outcome. */
    const cached = queryClient.getQueryData<readonly OpeningBalanceRow[]>([
      ...OPENING_BALANCES_QUERY_KEY,
      'year-1',
    ]);
    expect(cached).toHaveLength(2);
  });

  it('classifies an RLS refusal as forbidden', async () => {
    respondWith(null, { code: '42501', message: 'permission denied for table opening_balances' });
    const { result } = mountQuery(() => useDeleteOpeningBalance());

    await expect(
      result.current.mutateAsync({ fiscalYearId: 'year-1', balanceId: 'balance-1' }),
    ).rejects.toBeInstanceOf(FiscalSettingsWriteError);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as FiscalSettingsWriteError).code).toBe('forbidden');
  });

  it('refuses an empty identifier before touching the network', async () => {
    const { result } = mountQuery(() => useDeleteOpeningBalance());

    await expect(
      result.current.mutateAsync({ fiscalYearId: 'year-1', balanceId: '  ' }),
    ).rejects.toMatchObject({ code: 'validation' });

    expect(calls.table).toBeUndefined();
  });
});

describe('useFiscalMonths', () => {
  it('reads the active-month flag used by the periodic-settings badge', async () => {
    const { result } = mountQuery(() => useFiscalMonths('year-1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls.table).toBe('fiscal_months');
    expect(calls.select).toContain('is_active');
    expect(calls.select).toContain('current_period');
  });
});

describe('useActivateFiscalMonth', () => {
  const input = { fiscalYearId: 'year-1', monthId: 'month-1' };
  const response = {
    fiscal_month_id: 'month-1',
    fiscal_year_id: 'year-1',
    changed: true,
    was_closed: false,
    reason: null,
  };
  const cachedMonth = (id: string, active: boolean) => ({
    id,
    fiscal_year_id: 'year-1',
    month_number: 1,
    name: 'يوليو',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    current_period: 3,
    is_active: active,
    is_closed: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  });

  it('uses the RPC, never a direct is_active update, and rotates the cached badge', async () => {
    mock.rpcResponse = { data: response, error: null };
    const queryClient = createQueryClient();
    const monthKey = [...FISCAL_MONTHS_QUERY_KEY, 'year-1'];
    queryClient.setQueryData(monthKey, [
      cachedMonth('month-0', true),
      cachedMonth('month-1', false),
    ]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = mountQuery(() => useActivateFiscalMonth(), queryClient);

    await expect(result.current.mutateAsync(input)).resolves.toEqual(response);

    expect(calls.rpcs).toEqual([
      { name: 'aps_activate_fiscal_month', args: { p_fiscal_month_id: 'month-1', p_reason: null } },
    ]);
    expect(calls.table).toBeUndefined();
    expect(calls.updated).toBeUndefined();
    expect(
      queryClient
        .getQueryData<ReturnType<typeof cachedMonth>[]>(monthKey)
        ?.map((month) => [month.id, month.is_active, month.current_period]),
    ).toEqual([
      ['month-0', false, 3],
      ['month-1', true, 3],
    ]);
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(FISCAL_MONTHS_QUERY_KEY));
    expect(keys).toContain(JSON.stringify(ENTRY_OPTIONS_QUERY_KEY));
  });

  it('trims and forwards the closed-period reason to the database', async () => {
    mock.rpcResponse = {
      data: { ...response, was_closed: true, reason: 'اعتماد متأخر بموافقة المالك' },
      error: null,
    };
    const { result } = mountQuery(() => useActivateFiscalMonth());
    await result.current.mutateAsync({ ...input, reason: '  اعتماد متأخر بموافقة المالك  ' });
    expect(calls.rpcs[0]?.args.p_reason).toBe('اعتماد متأخر بموافقة المالك');
  });

  it('accepts an idempotent activation result', async () => {
    mock.rpcResponse = { data: { ...response, changed: false }, error: null };
    const { result } = mountQuery(() => useActivateFiscalMonth());
    await expect(result.current.mutateAsync(input)).resolves.toMatchObject({ changed: false });
  });

  it.each([
    ['42501', 'forbidden'],
    ['22023', 'validation'],
    ['P0002', 'notFound'],
  ])('maps database refusal %s to %s without changing the cache', async (code, expected) => {
    mock.rpcResponse = { data: null, error: { code, message: 'activation refused' } };
    const queryClient = createQueryClient();
    const monthKey = [...FISCAL_MONTHS_QUERY_KEY, 'year-1'];
    const original = [cachedMonth('month-0', true), cachedMonth('month-1', false)];
    queryClient.setQueryData(monthKey, original);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = mountQuery(() => useActivateFiscalMonth(), queryClient);
    await expect(result.current.mutateAsync(input)).rejects.toMatchObject({ code: expected });
    expect(queryClient.getQueryData(monthKey)).toEqual(original);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...response, fiscal_year_id: 'another-year' }])(
    'does not report success for a malformed RPC result',
    async (data) => {
      mock.rpcResponse = { data, error: null };
      const { result } = mountQuery(() => useActivateFiscalMonth());
      await expect(result.current.mutateAsync(input)).rejects.toMatchObject({
        code: data === null ? 'notFound' : 'validation',
      });
    },
  );

  it('rejects empty identifiers before calling the RPC', async () => {
    const { result } = mountQuery(() => useActivateFiscalMonth());
    await expect(result.current.mutateAsync({ ...input, monthId: ' ' })).rejects.toMatchObject({
      code: 'validation',
    });
    expect(calls.rpcs).toEqual([]);
  });

  it('reports an unconfigured client as unavailable', async () => {
    mock.client = null;
    const { result } = mountQuery(() => useActivateFiscalMonth());
    await expect(result.current.mutateAsync(input)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('useUpdateFiscalPeriod', () => {
  const monthWire = (period: number) => ({
    id: 'month-1',
    fiscal_year_id: 'year-1',
    month_number: 7,
    name: 'يوليو 2026',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    current_period: period,
    is_active: false,
    is_closed: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  });

  it('refreshes the entry choices so the period bar follows the settings', async () => {
    // The entry screen states the period from its own choices payload: changing
    // the sub-period here must invalidate that payload, or the bar keeps naming
    // the number the clerk just replaced.
    respondWith(monthWire(3));
    const queryClient = createQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = mountQuery(() => useUpdateFiscalPeriod(), queryClient);

    await result.current.mutateAsync({
      monthId: 'month-1',
      fiscalYearId: 'year-1',
      currentPeriod: 3,
    });

    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(ENTRY_OPTIONS_QUERY_KEY));
  });
});

describe('useSetOpeningBalancesLock', () => {
  const yearWire = (locked: boolean) => ({
    id: 'year-1',
    name: '2025-2026',
    start_date: '2025-07-01',
    end_date: '2026-06-30',
    is_active: true,
    is_closed: false,
    supplements_open: false,
    opening_balances_locked: locked,
    created_at: '2025-07-01T00:00:00.000Z',
    updated_at: '2025-07-01T00:00:00.000Z',
  });

  it('sends only the freeze column and patches the cached year', async () => {
    respondWith(yearWire(true));
    const queryClient = createQueryClient();
    queryClient.setQueryData(FISCAL_YEARS_QUERY_KEY, [yearWire(false)]);
    const { result } = mountQuery(() => useSetOpeningBalancesLock(), queryClient);

    await expect(
      result.current.mutateAsync({ fiscalYearId: 'year-1', locked: true }),
    ).resolves.toMatchObject({ id: 'year-1', opening_balances_locked: true });

    expect(calls.table).toBe('fiscal_years');
    expect(calls.updated).toEqual({ opening_balances_locked: true });
    expect(calls.filters).toEqual([['id', 'year-1']]);
    expect(calls.select).toContain('opening_balances_locked');

    const cached =
      queryClient.getQueryData<readonly { opening_balances_locked: boolean }[]>(
        FISCAL_YEARS_QUERY_KEY,
      );
    expect(cached?.[0]?.opening_balances_locked).toBe(true);
  });

  it('reports a row filtered by RLS as notFound, never as a successful lock', async () => {
    respondWith(null, { code: 'PGRST116', message: '0 rows returned' });
    const { result } = mountQuery(() => useSetOpeningBalancesLock());

    await expect(
      result.current.mutateAsync({ fiscalYearId: 'year-1', locked: true }),
    ).rejects.toMatchObject({ code: 'notFound' });
  });

  it('classifies an RLS refusal as forbidden', async () => {
    respondWith(null, { code: '42501', message: 'permission denied for table fiscal_years' });
    const { result } = mountQuery(() => useSetOpeningBalancesLock());

    await expect(
      result.current.mutateAsync({ fiscalYearId: 'year-1', locked: false }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses an empty identifier before touching the network', async () => {
    const { result } = mountQuery(() => useSetOpeningBalancesLock());

    await expect(
      result.current.mutateAsync({ fiscalYearId: '  ', locked: true }),
    ).rejects.toMatchObject({ code: 'validation' });

    expect(calls.table).toBeUndefined();
  });
});
