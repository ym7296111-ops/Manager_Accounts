import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STATIONS_DIRECTORY_QUERY_KEY } from '@/hooks/useStationsDirectory';
import {
  classifyStationWriteError,
  StationWriteError,
  useCreateStation,
  useCreateWarehouse,
  useDeleteStation,
  useDeleteWarehouse,
  useUpdateStation,
  useUpdateWarehouse,
  validateName,
} from '@/hooks/useStationsMutations';

const { mock, recorded } = vi.hoisted(() => {
  const response: { data: unknown; error: unknown } = { data: undefined, error: undefined };
  return {
    mock: {
      client: null as { from: (table: string) => unknown } | null,
      response,
    },
    recorded: {
      table: undefined as string | undefined,
      insert: undefined as Record<string, unknown> | undefined,
      update: undefined as Record<string, unknown> | undefined,
      eq: undefined as [string, unknown] | undefined,
      deleted: false,
    },
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mock.client }));

/**
 * A thenable PostgREST-builder stub covering the three shapes the mutations use:
 * `insert().select().single()`, `update().eq().select().single()` and
 * `delete().eq()`.
 */
function configureClient() {
  recorded.table = undefined;
  recorded.insert = undefined;
  recorded.update = undefined;
  recorded.eq = undefined;
  recorded.deleted = false;

  mock.client = {
    from: (table: string) => {
      recorded.table = table;
      const then = (resolve: (value: unknown) => void, reject: (reason: unknown) => void): void => {
        Promise.resolve(mock.response).then(resolve, reject);
      };
      const terminal = { then };
      const withSelect = { select: () => ({ single: () => terminal }), then };
      return {
        insert: (payload: Record<string, unknown>) => {
          recorded.insert = payload;
          return withSelect;
        },
        update: (patch: Record<string, unknown>) => {
          recorded.update = patch;
          return {
            eq: (column: string, value: unknown) => {
              recorded.eq = [column, value];
              return withSelect;
            },
          };
        },
        delete: () => {
          recorded.deleted = true;
          return {
            eq: (column: string, value: unknown) => {
              recorded.eq = [column, value];
              return terminal;
            },
          };
        },
      };
    },
  };
}

function respondWith(data: unknown = null, error: unknown = null) {
  mock.response = { data, error };
}

function mountHook<H>(hook: () => H) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const result = renderHook(hook, { wrapper: Wrapper });
  return { ...result, queryClient };
}

beforeEach(() => {
  respondWith();
  configureClient();
});

describe('validateName', () => {
  it('trims, then requires content, then the two-character minimum', () => {
    expect(validateName(' محطة ')).toEqual({ ok: true, value: 'محطة' });
    expect(validateName('')).toEqual({ ok: false, code: 'required' });
    expect(validateName('\t\n  ')).toEqual({ ok: false, code: 'required' });
    expect(validateName('ا')).toEqual({ ok: false, code: 'tooShort' });
    expect(validateName('ا ب')).toEqual({ ok: true, value: 'ا ب' });
  });
});

describe('classifyStationWriteError', () => {
  it('maps RLS and JWT rejections to forbidden', () => {
    expect(classifyStationWriteError({ code: '42501' })).toBe('forbidden');
    expect(classifyStationWriteError({ code: 'PGRST301' })).toBe('forbidden');
    expect(classifyStationWriteError({ message: 'permission denied for table stations' })).toBe(
      'forbidden',
    );
  });

  it('maps the RESTRICT and unique violations to conflict', () => {
    /* 23503 is what warehouses_station_id_fkey ON DELETE RESTRICT raises when a
       station still has warehouses; the UI must say so in plain language. */
    expect(
      classifyStationWriteError({
        code: '23503',
        message: 'update or delete on table "stations" violates foreign key constraint',
      }),
    ).toBe('conflict');
    expect(classifyStationWriteError({ code: '23505' })).toBe('conflict');
  });

  it('maps the CHECK constraint to validation and transport failures to network', () => {
    expect(classifyStationWriteError({ code: '23514' })).toBe('validation');
    expect(classifyStationWriteError(new Error('Failed to fetch'))).toBe('network');
    expect(classifyStationWriteError({ code: '42703' })).toBe('unknown');
  });

  it('passes through an already-classified error', () => {
    expect(classifyStationWriteError(new StationWriteError('validation'))).toBe('validation');
  });
});

describe('useCreateStation', () => {
  it('inserts the name only — never a code, which the server mints', async () => {
    respondWith({ id: 's9', code: 'ST-04', name: 'محطة', is_active: true });
    const { result } = mountHook(useCreateStation);

    result.current.mutate({ name: '  محطة  ' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.table).toBe('stations');
    expect(recorded.insert).toEqual({ name: 'محطة' });
    expect(Object.keys(recorded.insert ?? {})).not.toContain('code');
  });

  it('refuses an invalid name before touching the client', async () => {
    const { result } = mountHook(useCreateStation);

    result.current.mutate({ name: ' ' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as StationWriteError).code).toBe('validation');
    expect(recorded.table).toBeUndefined();
  });

  it('fails closed as unavailable when no client is configured', async () => {
    mock.client = null;
    const { result } = mountHook(useCreateStation);

    result.current.mutate({ name: 'محطة' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as StationWriteError).code).toBe('unavailable');
  });

  it('classifies an RLS rejection on insert as forbidden', async () => {
    respondWith(null, { code: '42501', message: 'permission denied for table stations' });
    const { result } = mountHook(useCreateStation);

    result.current.mutate({ name: 'محطة' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as StationWriteError).code).toBe('forbidden');
  });

  it('invalidates the directory so the accordion refetches', async () => {
    const { result, queryClient } = mountHook(useCreateStation);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    result.current.mutate({ name: 'محطة' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: STATIONS_DIRECTORY_QUERY_KEY });
  });
});

describe('useUpdateStation', () => {
  it('sends only the name when renaming', async () => {
    const { result } = mountHook(useUpdateStation);

    result.current.mutate({ id: 's1', name: 'اسم جديد' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.table).toBe('stations');
    expect(recorded.update).toEqual({ name: 'اسم جديد' });
    expect(recorded.eq).toEqual(['id', 's1']);
  });

  it('sends only is_active when toggling, and never a code', async () => {
    const { result } = mountHook(useUpdateStation);

    result.current.mutate({ id: 's1', isActive: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.update).toEqual({ is_active: false });
    expect(Object.keys(recorded.update ?? {})).not.toContain('code');
  });

  it('refuses an empty patch rather than issuing a no-op UPDATE', async () => {
    const { result } = mountHook(useUpdateStation);

    result.current.mutate({ id: 's1' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as StationWriteError).code).toBe('validation');
    expect(recorded.table).toBeUndefined();
  });
});

describe('useDeleteStation', () => {
  it('deletes by id and reports the RESTRICT violation as a conflict', async () => {
    const { result } = mountHook(useDeleteStation);

    result.current.mutate({ id: 's2' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(recorded.deleted).toBe(true);
    expect(recorded.table).toBe('stations');
    expect(recorded.eq).toEqual(['id', 's2']);

    respondWith(null, {
      code: '23503',
      message: 'violates foreign key constraint "warehouses_station_id_fkey"',
    });
    result.current.mutate({ id: 's1' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as StationWriteError).code).toBe('conflict');
  });
});

describe('warehouse mutations', () => {
  it('creates a warehouse under its station without a code', async () => {
    const { result } = mountHook(useCreateWarehouse);

    result.current.mutate({ stationId: 's1', name: 'مخزن' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.table).toBe('warehouses');
    expect(recorded.insert).toEqual({ station_id: 's1', name: 'مخزن' });
  });

  it('updates a warehouse name by id', async () => {
    const { result } = mountHook(useUpdateWarehouse);

    result.current.mutate({ id: 'w1', name: 'مخزن معدّل' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.update).toEqual({ name: 'مخزن معدّل' });
    expect(recorded.eq).toEqual(['id', 'w1']);
  });

  it('deletes a warehouse by id', async () => {
    const { result } = mountHook(useDeleteWarehouse);

    result.current.mutate({ id: 'w2' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.table).toBe('warehouses');
    expect(recorded.deleted).toBe(true);
    expect(recorded.eq).toEqual(['id', 'w2']);
  });
});
