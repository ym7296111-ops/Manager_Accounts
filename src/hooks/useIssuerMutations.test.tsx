import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IssuerWriteError,
  buildCreateIssuerPayload,
  buildRenameIssuerPayload,
  buildSetIssuerActivePayload,
  classifyIssuerWriteError,
  useCreateIssuer,
  useRenameIssuer,
  useSetIssuerActive,
} from '@/hooks/useIssuerMutations';

interface Call {
  table: string;
  operation: 'insert' | 'update';
  payload: Record<string, unknown>;
  filters: Array<readonly [string, unknown]>;
}

const { mock, calls } = vi.hoisted(() => {
  const response: { data: unknown; error: unknown } = { data: null, error: null };
  return {
    mock: { client: null as { from: (table: string) => unknown } | null, response },
    calls: [] as Call[],
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mock.client }));

/**
 * The smallest PostgREST-shaped client the three mutations chain:
 * `from(t).insert(p).select(c).single()` and
 * `from(t).update(p).eq('id', id).select(c).single()`.
 */
function configureClient() {
  calls.length = 0;
  mock.client = {
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        const record: Call = {
          table,
          operation: 'insert',
          payload,
          filters: [],
        };
        calls.push(record);
        return {
          select: () => ({
            single: () => Promise.resolve(mock.response),
          }),
        };
      },
      update: (payload: Record<string, unknown>) => {
        const record: Call = {
          table,
          operation: 'update',
          payload,
          filters: [],
        };
        calls.push(record);
        return {
          eq: (column: string, value: unknown) => {
            record.filters.push([column, value] as const);
            return {
              select: () => ({
                single: () => Promise.resolve(mock.response),
              }),
            };
          },
        };
      },
    }),
  };
}

function mountHook<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper: Wrapper });
}

beforeEach(() => {
  configureClient();
  mock.response = {
    data: { id: 'i1', code: 'YM', name: 'ياسر', is_active: true },
    error: null,
  };
});

describe('payload builders', () => {
  it('creates with the two letters up-cased and the name trimmed', () => {
    expect(buildCreateIssuerPayload({ code: 'ym', name: '  ياسر ' })).toEqual({
      code: 'YM',
      name: 'ياسر',
    });
  });

  it('falls back to the code when the optional name is blank', () => {
    expect(buildCreateIssuerPayload({ code: 'ab', name: '   ' })).toEqual({
      code: 'AB',
      name: 'AB',
    });
  });

  it('refuses a code that is not two Latin letters', () => {
    expect(() => buildCreateIssuerPayload({ code: 'YMX', name: 'ياسر' })).toThrow(IssuerWriteError);
    expect(() => buildCreateIssuerPayload({ code: 'يم', name: 'ياسر' })).toThrow(IssuerWriteError);
  });

  it('never sends the code on an update', () => {
    expect(buildRenameIssuerPayload({ code: 'YM', name: 'ياسر عبد الله' })).toEqual({
      name: 'ياسر عبد الله',
    });
    expect(buildSetIssuerActivePayload(false)).toEqual({ is_active: false });
  });
});

describe('classifyIssuerWriteError', () => {
  it('maps the database refusals onto value-free codes', () => {
    expect(classifyIssuerWriteError({ code: '42501' }, 'create')).toBe('forbidden');
    expect(classifyIssuerWriteError({ code: '23505' }, 'create')).toBe('duplicate');
    expect(classifyIssuerWriteError({ code: '23514' }, 'create')).toBe('validation');
    expect(classifyIssuerWriteError({ code: 'PGRST116' }, 'rename')).toBe('notFound');
    expect(classifyIssuerWriteError(new TypeError('Failed to fetch'), 'toggle')).toBe('network');
    expect(classifyIssuerWriteError(new Error('boom'), 'toggle')).toBe('unknown');
    expect(classifyIssuerWriteError(new IssuerWriteError('validation'), 'create')).toBe(
      'validation',
    );
  });
});

describe('mutations', () => {
  it('inserts `{ code, name }` into public.issuers', async () => {
    const { result } = mountHook(() => useCreateIssuer());

    result.current.mutate({ code: 'ym', name: 'ياسر' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe('issuers');
    expect(calls[0]?.operation).toBe('insert');
    expect(calls[0]?.payload).toEqual({ code: 'YM', name: 'ياسر' });
  });

  it('renames by id with the name only — the code is the identity', async () => {
    const { result } = mountHook(() => useRenameIssuer());

    result.current.mutate({ id: 'i1', code: 'YM', name: 'ياسر عبد الله' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls[0]?.operation).toBe('update');
    expect(calls[0]?.payload).toEqual({ name: 'ياسر عبد الله' });
    expect(calls[0]?.filters).toEqual([['id', 'i1']]);
  });

  it('toggles the flag instead of deleting the row', async () => {
    const { result } = mountHook(() => useSetIssuerActive());

    result.current.mutate({ id: 'i1', isActive: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls[0]?.payload).toEqual({ is_active: false });
    expect(calls[0]?.filters).toEqual([['id', 'i1']]);
  });

  it('reports a duplicate code as `duplicate` and never claims success', async () => {
    mock.response = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const { result } = mountHook(() => useCreateIssuer());

    result.current.mutate({ code: 'YM', name: 'ياسر' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(IssuerWriteError);
    expect(result.current.error?.code).toBe('duplicate');
  });
});
