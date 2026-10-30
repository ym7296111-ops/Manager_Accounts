import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ISSUERS_QUERY_KEY,
  ISSUERS_SELECT,
  IssuersError,
  classifyIssuersError,
  parseIssuers,
  useIssuers,
} from '@/hooks/useIssuers';

const { mock, calls } = vi.hoisted(() => {
  const response: { data: unknown; error: unknown } = { data: [], error: null };
  return {
    mock: { client: null as { from: (table: string) => unknown } | null, response },
    calls: {
      table: undefined as string | undefined,
      select: undefined as string | undefined,
      orders: [] as string[],
    },
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mock.client }));

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
  return renderHook(() => useIssuers(), { wrapper: Wrapper });
}

beforeEach(() => {
  respondWith([]);
  configureClient();
});

const row = (patch: Record<string, unknown> = {}) => ({
  id: 'i1',
  code: 'YM',
  name: 'ياسر',
  is_active: true,
  ...patch,
});

describe('parseIssuers', () => {
  it('returns an empty list for a non-array payload', () => {
    expect(parseIssuers(null)).toEqual([]);
    expect(parseIssuers(undefined)).toEqual([]);
    expect(parseIssuers({})).toEqual([]);
  });

  it('maps the wire columns onto the render model and sorts by code', () => {
    const parsed = parseIssuers([
      row({ id: 'b', code: 'AB', name: 'أحمد' }),
      row({ id: 'a', code: 'ym', name: 'ياسر', is_active: false }),
    ]);

    expect(parsed).toEqual([
      { id: 'b', code: 'AB', name: 'أحمد', isActive: true },
      { id: 'a', code: 'YM', name: 'ياسر', isActive: false },
    ]);
  });

  it('drops malformed rows and codes the database CHECK could never store', () => {
    const parsed = parseIssuers([
      row(),
      row({ id: 'two', code: 'YMM' }),
      row({ id: 'blank', name: '   ' }),
      row({ id: 'no-id', id2: 'x' }),
      null,
      'YM',
      row({ id: 'a', code: 'AA' }),
      row({ id: 'a2', code: 'aa' }),
    ]);

    // `AA` sorts before `YM`, and the duplicate `aa` was dropped.
    expect(parsed.map((issuer) => issuer.id)).toEqual(['a', 'i1']);
  });
});

describe('useIssuers', () => {
  it('reads the register from public.issuers, ordered by code', async () => {
    respondWith([row()]);
    const { result } = mountHook();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls.table).toBe('issuers');
    expect(calls.select).toBe(ISSUERS_SELECT);
    expect(calls.orders).toEqual(['code']);
    expect(result.current.data).toEqual([{ id: 'i1', code: 'YM', name: 'ياسر', isActive: true }]);
    expect(ISSUERS_QUERY_KEY).toEqual(['project-settings', 'issuers']);
  });

  it('classifies a failed read instead of rendering an empty list', async () => {
    respondWith(null, { code: '42501', message: 'permission denied' });
    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(classifyIssuersError(result.current.error)).toBe('forbidden');
  });

  it('fails closed when the client is not configured', async () => {
    mock.client = null;
    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(IssuersError);
    expect(classifyIssuersError(result.current.error)).toBe('unavailable');
  });
});
