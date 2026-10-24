import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyStationsError,
  parseStationsDirectory,
  STATIONS_DIRECTORY_QUERY_KEY,
  STATIONS_SELECT,
  StationsDirectoryError,
  useStationsDirectory,
} from '@/hooks/useStationsDirectory';

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

/**
 * A thenable PostgREST-builder stub. `order()` returns itself so the chained
 * `.order(...).order(...)` shape is exercised, and the recorded projections let
 * the test assert the exact query the hook issues.
 */
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
            order: (column: string, options?: { referencedTable?: string }) => {
              calls.orders.push(options?.referencedTable ?? column);
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

/** Mirrors `supabase.from(...).select(...)` returning `{ data, error }`. */
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
  return renderHook(() => useStationsDirectory(), { wrapper: Wrapper });
}

beforeEach(() => {
  respondWith([]);
  configureClient();
});

describe('parseStationsDirectory', () => {
  it('maps the nested response and nests warehouses under their station', () => {
    const parsed = parseStationsDirectory([
      {
        id: 's1',
        code: 'ST-01',
        name: 'المحطة الرئيسية',
        is_active: true,
        warehouses: [
          { id: 'w2', code: 'WH-002', name: 'مخزن قطع الغيار', is_active: false },
          { id: 'w1', code: 'WH-001', name: 'مخزن المواد الخام', is_active: true },
        ],
      },
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      id: 's1',
      code: 'ST-01',
      name: 'المحطة الرئيسية',
      isActive: true,
      warehouses: [
        { id: 'w1', code: 'WH-001', name: 'مخزن المواد الخام', isActive: true },
        { id: 'w2', code: 'WH-002', name: 'مخزن قطع الغيار', isActive: false },
      ],
    });
  });

  it('sorts stations and warehouses by code regardless of wire order', () => {
    const parsed = parseStationsDirectory([
      { id: 's2', code: 'ST-02', name: 'b', is_active: true, warehouses: [] },
      { id: 's1', code: 'ST-01', name: 'a', is_active: true, warehouses: [] },
      { id: 's10', code: 'ST-10', name: 'c', is_active: true, warehouses: [] },
    ]);

    expect(parsed.map((station) => station.code)).toEqual(['ST-01', 'ST-02', 'ST-10']);
  });

  it('drops rows missing a required scalar instead of blanking the directory', () => {
    const parsed = parseStationsDirectory([
      { id: 'ok', code: 'ST-01', name: 'سليمة', is_active: true, warehouses: [] },
      { id: 'bad-1', code: '', name: 'بلا كود', is_active: true, warehouses: [] },
      { id: 'bad-2', code: 'ST-02', name: '   ', is_active: true, warehouses: [] },
      { code: 'ST-03', name: 'بلا معرّف', is_active: true, warehouses: [] },
      null,
      'garbage',
    ]);

    expect(parsed.map((station) => station.code)).toEqual(['ST-01']);
  });

  it('treats a missing or non-array warehouse list as empty, and drops bad warehouses', () => {
    const parsed = parseStationsDirectory([
      { id: 's1', code: 'ST-01', name: 'بلا مخازن', is_active: true },
      {
        id: 's2',
        code: 'ST-02',
        name: 'مخازن مختلطة',
        is_active: true,
        warehouses: [{ id: 'w1', code: 'WH-001', name: 'سليم', is_active: true }, { id: 'w2' }],
      },
    ]);

    expect(parsed[0]?.warehouses).toEqual([]);
    expect(parsed[1]?.warehouses.map((warehouse) => warehouse.code)).toEqual(['WH-001']);
  });

  it('returns an empty list for null, undefined or a non-array payload', () => {
    expect(parseStationsDirectory(null)).toEqual([]);
    expect(parseStationsDirectory(undefined)).toEqual([]);
    expect(parseStationsDirectory({ id: 's1' })).toEqual([]);
  });

  it('never reports isActive for anything other than a literal true', () => {
    const parsed = parseStationsDirectory([
      { id: 's1', code: 'ST-01', name: 'a', is_active: 'true', warehouses: [] },
      { id: 's2', code: 'ST-02', name: 'b', warehouses: [] },
    ]);

    expect(parsed.map((station) => station.isActive)).toEqual([false, false]);
  });
});

describe('classifyStationsError', () => {
  it('maps RLS and JWT rejections to forbidden', () => {
    expect(classifyStationsError({ code: '42501', message: 'permission denied' })).toBe(
      'forbidden',
    );
    expect(classifyStationsError({ code: 'PGRST301', message: 'JWT expired' })).toBe('forbidden');
    expect(classifyStationsError({ message: 'permission_denied for table stations' })).toBe(
      'forbidden',
    );
  });

  it('maps transport failures to network and everything else to unknown', () => {
    expect(classifyStationsError(new Error('Failed to fetch'))).toBe('network');
    expect(classifyStationsError({ code: 'PGRST503', message: 'unavailable' })).toBe('network');
    expect(classifyStationsError({ code: '42703', message: 'column x does not exist' })).toBe(
      'unknown',
    );
    expect(classifyStationsError(null)).toBe('unknown');
  });

  it('passes through an already-classified StationsDirectoryError', () => {
    expect(classifyStationsError(new StationsDirectoryError('unavailable'))).toBe('unavailable');
  });
});

describe('STATIONS_SELECT', () => {
  it('hints the warehouses embed with its station_id FK and keeps the response key', () => {
    /* One FK today, but an unqualified embed fails silently (PGRST201/300) the
       moment a second relationship appears. See postgrest-embeds.test.ts. */
    expect(STATIONS_SELECT).toContain('warehouses!station_id(');
    expect(STATIONS_SELECT).not.toMatch(/warehouses\(/);
    expect(STATIONS_SELECT).not.toMatch(/:\s*warehouses!/);
  });

  it('projects the exact columns the accordion renders', () => {
    expect(STATIONS_SELECT).toContain('id, code, name, is_active');
    expect(STATIONS_SELECT).toContain('id, code, name, is_active)');
  });
});

describe('useStationsDirectory', () => {
  it('runs one nested query against public.stations and returns the parsed directory', async () => {
    respondWith([
      {
        id: 's1',
        code: 'ST-01',
        name: 'المحطة الرئيسية',
        is_active: true,
        warehouses: [{ id: 'w1', code: 'WH-001', name: 'مخزن', is_active: true }],
      },
    ]);

    const { result } = mountHook();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls.table).toBe('stations');
    expect(calls.select).toBe(STATIONS_SELECT);
    expect(calls.orders).toEqual(['code', 'warehouses']);
    expect(result.current.data?.[0]?.warehouses).toHaveLength(1);
  });

  it('exposes 42501 as a forbidden StationsDirectoryError rather than an empty list', async () => {
    respondWith(null, { code: '42501', message: 'permission denied for table stations' });

    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(StationsDirectoryError);
    expect((result.current.error as StationsDirectoryError).code).toBe('forbidden');
  });

  it('fails closed with "unavailable" when the Supabase client is not configured', async () => {
    mock.client = null;

    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as StationsDirectoryError).code).toBe('unavailable');
    expect(calls.table).toBeUndefined();
  });

  it('caches under the project-settings stations key', async () => {
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(STATIONS_DIRECTORY_QUERY_KEY).toEqual(['project-settings', 'stations-directory']);
  });
});
