import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PARTIES_QUERY_KEY,
  PARTIES_SELECT,
  PartiesError,
  classifyPartiesError,
  parseParties,
  useParties,
} from '@/hooks/useParties';

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
      orders: [] as string[],
    },
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mock.client }));

/** Minimal thenable PostgREST builder: `.select(...).order(...)`. */
function configureClient() {
  calls.table = undefined;
  calls.select = undefined;
  calls.orders = [];

  mock.client = {
    from: (table: string) => {
      calls.table = table;
      return {
        select: (projection: string) => {
          calls.select = projection;
          const builder = {
            order: (column: string) => {
              calls.orders.push(column);
              return builder;
            },
            then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void): void => {
              Promise.resolve(mock.response).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
  };
}

function respondWith(data: unknown, error: unknown = null) {
  mock.response = { data, error };
}

function mountHook() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useParties(), { wrapper: Wrapper });
}

beforeEach(() => {
  respondWith([]);
  configureClient();
});

const row = (patch: Record<string, unknown> = {}) => ({
  id: 'p1',
  branch: 'inbound',
  code: 'IN-001',
  name: 'شركة النيل',
  is_active: true,
  ...patch,
});

describe('parseParties', () => {
  it('returns an empty list for a non-array payload', () => {
    expect(parseParties(null)).toEqual([]);
    expect(parseParties(undefined)).toEqual([]);
    expect(parseParties({})).toEqual([]);
  });

  it('orders by branch (inbound, then outbound), then numeric code', () => {
    const parsed = parseParties([
      row({ id: 'o1', branch: 'outbound', code: 'OUT-001', name: 'صرف' }),
      row({ id: 'i10', branch: 'inbound', code: 'IN-010', name: 'عاشر' }),
      row({ id: 'i2', branch: 'inbound', code: 'IN-002', name: 'ثانٍ' }),
    ]);

    expect(parsed.map((party) => party.code)).toEqual(['IN-002', 'IN-010', 'OUT-001']);
  });

  it('maps the wire row onto the render model — identity only', () => {
    const [party] = parseParties([row({ is_active: false })]);

    expect(party).toEqual({
      id: 'p1',
      branch: 'inbound',
      code: 'IN-001',
      name: 'شركة النيل',
      isActive: false,
    });
    /* No other column survives: the commercial profile was retired. */
    expect(Object.keys(party ?? {}).sort()).toEqual(['branch', 'code', 'id', 'isActive', 'name']);
  });

  it('drops malformed rows instead of blanking the tree', () => {
    const parsed = parseParties([
      row(),
      row({ id: 'p2', code: 'IN-002', name: '' }),
      row({ id: 'p3', code: 'IN-003', branch: 'vendor', name: 'فرع مجهول' }),
      /* The retired vocabulary is a dropped row, not a rendered one. */
      row({ id: 'p4', code: 'LOC-001', branch: 'local_supplier', name: 'قديم' }),
      row({ id: 'p5', code: 'SIS-001', branch: 'sister_company', name: 'شقيقة' }),
      row({ id: 'p1', code: 'IN-099', name: 'مكررة' }),
      'not a row',
      null,
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.code).toBe('IN-001');
  });
});

describe('classifyPartiesError', () => {
  it('maps RLS and JWT rejections to forbidden', () => {
    expect(classifyPartiesError({ code: '42501' })).toBe('forbidden');
    expect(classifyPartiesError({ code: 'PGRST301' })).toBe('forbidden');
    expect(classifyPartiesError({ message: 'permission denied for table parties' })).toBe(
      'forbidden',
    );
  });

  it('maps transport failures to network and everything else to unknown', () => {
    expect(classifyPartiesError({ code: 'PGRST503' })).toBe('network');
    expect(classifyPartiesError({ message: 'Failed to fetch' })).toBe('network');
    expect(classifyPartiesError({ code: 'PGRST200' })).toBe('unknown');
    expect(classifyPartiesError(null)).toBe('unknown');
  });

  it('passes through an already-classified error', () => {
    expect(classifyPartiesError(new PartiesError('unavailable'))).toBe('unavailable');
  });
});

describe('useParties', () => {
  it('reads the whole tree in one request, ordered by code', async () => {
    respondWith([row()]);
    const { result } = mountHook();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls.table).toBe('parties');
    expect(calls.select).toBe(PARTIES_SELECT);
    expect(calls.orders).toEqual(['code']);
    expect(result.current.data).toHaveLength(1);
    expect(PARTIES_QUERY_KEY).toEqual(['project-settings', 'parties']);
  });

  it('fails closed with "unavailable" when the client is not configured', async () => {
    mock.client = null;
    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(PartiesError);
    expect((result.current.error as PartiesError).code).toBe('unavailable');
  });

  it('surfaces a denied grant as forbidden, not as an empty directory', async () => {
    respondWith(null, { code: '42501', message: 'permission denied for table parties' });
    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as PartiesError).code).toBe('forbidden');
  });
});
