import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FiscalSettingsWriteError,
  OPENING_BALANCE_SELECT,
  OPENING_BALANCES_QUERY_KEY,
  openingBalanceReviewReason,
  parseOpeningBalances,
  useDeleteOpeningBalance,
  useOpeningBalances,
  type OpeningBalanceRow,
} from '@/hooks/useFiscalSettings';

const { mock, calls } = vi.hoisted(() => {
  const response: { data: unknown; error: unknown } = { data: [], error: null };
  return {
    mock: {
      client: null as { from: (table: string) => unknown } | null,
      response,
    },
    calls: {
      table: undefined as string | undefined,
      select: undefined as string | undefined,
      deleted: false,
      filters: [] as Array<readonly [string, unknown]>,
      orders: [] as string[],
    },
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
  calls.filters = [];
  calls.orders = [];

  mock.client = {
    from: (table: string) => {
      calls.table = table;
      const resolveWith = () => Promise.resolve(mock.response);
      const terminal = {
        then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void): void => {
          resolveWith().then(resolve, reject);
        },
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
