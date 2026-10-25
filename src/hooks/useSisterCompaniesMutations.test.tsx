import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SISTER_COMPANIES_QUERY_KEY } from '@/hooks/useSisterCompanies';
import {
  SisterCompanyWriteError,
  buildCreatePayload,
  buildRenamePayload,
  buildSetActivePayload,
  classifySisterCompanyWriteError,
  useCreateSisterCompany,
  useDeleteSisterCompany,
  useRenameSisterCompany,
  useSetSisterCompanyActive,
} from '@/hooks/useSisterCompaniesMutations';

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
      select: undefined as string | undefined,
    },
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mock.client }));

function configureClient() {
  recorded.table = undefined;
  recorded.insert = undefined;
  recorded.update = undefined;
  recorded.eq = undefined;
  recorded.deleted = false;
  recorded.select = undefined;

  mock.client = {
    from: (table: string) => {
      recorded.table = table;
      const then = (resolve: (value: unknown) => void, reject: (reason: unknown) => void): void => {
        Promise.resolve(mock.response).then(resolve, reject);
      };
      const terminal = { then };
      const selectSingle = (columns: string) => {
        recorded.select = columns;
        return { single: () => terminal };
      };
      return {
        insert: (payload: Record<string, unknown>) => {
          recorded.insert = payload;
          return { select: selectSingle };
        },
        update: (patch: Record<string, unknown>) => {
          recorded.update = patch;
          return {
            eq: (column: string, value: unknown) => {
              recorded.eq = [column, value];
              return { select: selectSingle };
            },
          };
        },
        delete: () => {
          recorded.deleted = true;
          return {
            eq: (column: string, value: unknown) => {
              recorded.eq = [column, value];
              return {
                select: (columns: string) => {
                  recorded.select = columns;
                  return terminal;
                },
              };
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

const WRITTEN_ROW = {
  id: 'sc2',
  parent_id: null,
  level: 1,
  code: 'SIS-002',
  name: 'شركة الواحة',
  is_active: true,
};

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
  respondWith(WRITTEN_ROW);
  configureClient();
});

describe('buildCreatePayload', () => {
  it('creates a parent company with a name only', () => {
    expect(buildCreatePayload({ name: '  شركة الواحة  ' })).toEqual({ name: 'شركة الواحة' });
  });

  it('adds parent_id for a branch — and never code or level', () => {
    const payload = buildCreatePayload({ name: 'فرع الواحة', parentId: 'sc1' });
    expect(payload).toEqual({ name: 'فرع الواحة', parent_id: 'sc1' });
    expect(payload).not.toHaveProperty('code');
    expect(payload).not.toHaveProperty('level');
  });

  it('treats an empty parent id as a parent company', () => {
    expect(buildCreatePayload({ name: 'شركة', parentId: '' })).toEqual({ name: 'شركة' });
    expect(buildCreatePayload({ name: 'شركة', parentId: null })).toEqual({ name: 'شركة' });
  });

  it('refuses an invalid name before any request can happen', () => {
    for (const name of ['', '   ', 'ش']) {
      expect(() => buildCreatePayload({ name })).toThrowError(SisterCompanyWriteError);
    }
  });
});

describe('buildRenamePayload / buildSetActivePayload', () => {
  it('renames with the name alone, never the immutable columns', () => {
    const payload = buildRenamePayload('  الواحة للتطوير ');
    expect(payload).toEqual({ name: 'الواحة للتطوير' });
    for (const column of ['code', 'level', 'parent_id']) {
      expect(payload).not.toHaveProperty(column);
    }
  });

  it('carries the active flag alone', () => {
    expect(buildSetActivePayload(false)).toEqual({ is_active: false });
    expect(buildSetActivePayload(true)).toEqual({ is_active: true });
  });

  it('rejects an invalid rename', () => {
    expect(() => buildRenamePayload(' ')).toThrowError(SisterCompanyWriteError);
  });
});

describe('classifySisterCompanyWriteError', () => {
  it('maps RLS and JWT rejections to forbidden', () => {
    expect(classifySisterCompanyWriteError({ code: '42501' }, 'create')).toBe('forbidden');
    expect(classifySisterCompanyWriteError({ code: 'PGRST301' }, 'delete')).toBe('forbidden');
    expect(classifySisterCompanyWriteError({ message: 'permission denied' }, 'rename')).toBe(
      'forbidden',
    );
  });

  it('gives the immutability refusal (22023) its own code', () => {
    expect(classifySisterCompanyWriteError({ code: '22023' }, 'rename')).toBe('immutable');
  });

  it('reads 23503 by verb: branches on delete, a missing parent on create', () => {
    expect(classifySisterCompanyWriteError({ code: '23503' }, 'delete')).toBe('hasBranches');
    expect(classifySisterCompanyWriteError({ code: '23503' }, 'create')).toBe('missingParent');
  });

  it('maps CHECK violations to validation and a zero-row single to notFound', () => {
    expect(classifySisterCompanyWriteError({ code: '23514' }, 'create')).toBe('validation');
    expect(classifySisterCompanyWriteError({ code: 'PGRST116' }, 'rename')).toBe('notFound');
  });

  it('maps transport failures to network and everything else to unknown', () => {
    expect(classifySisterCompanyWriteError({ code: 'PGRST503' }, 'toggle')).toBe('network');
    expect(classifySisterCompanyWriteError({ message: 'Failed to fetch' }, 'toggle')).toBe(
      'network',
    );
    expect(classifySisterCompanyWriteError({ code: 'XX000' }, 'toggle')).toBe('unknown');
  });

  it('passes through an already-classified error', () => {
    expect(
      classifySisterCompanyWriteError(new SisterCompanyWriteError('validation'), 'create'),
    ).toBe('validation');
  });
});

describe('useCreateSisterCompany', () => {
  it('inserts the name and, for a branch, the parent id', async () => {
    const { result } = mountHook(() => useCreateSisterCompany());

    result.current.mutate({ name: 'فرع الاختبار', parentId: 'sc1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.table).toBe('sister_companies');
    expect(recorded.insert).toEqual({ name: 'فرع الاختبار', parent_id: 'sc1' });
    expect(recorded.insert).not.toHaveProperty('code');
    expect(recorded.insert).not.toHaveProperty('level');
  });

  it('issues no request at all for an invalid name', async () => {
    const { result } = mountHook(() => useCreateSisterCompany());

    result.current.mutate({ name: 'ش' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as SisterCompanyWriteError).code).toBe('validation');
    expect(recorded.table).toBeUndefined();
  });

  it('fails closed with "unavailable" when the client is not configured', async () => {
    mock.client = null;
    const { result } = mountHook(() => useCreateSisterCompany());

    result.current.mutate({ name: 'شركة بلا اتصال' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as SisterCompanyWriteError).code).toBe('unavailable');
  });
});

describe('useRenameSisterCompany', () => {
  it('updates the name by id and sends nothing derived', async () => {
    const { result } = mountHook(() => useRenameSisterCompany());

    result.current.mutate({ id: 'sc1', name: 'الواحة للتطوير' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.update).toEqual({ name: 'الواحة للتطوير' });
    expect(recorded.eq).toEqual(['id', 'sc1']);
  });

  it('reports a row that vanished as notFound', async () => {
    respondWith(null, { code: 'PGRST116' });
    const { result } = mountHook(() => useRenameSisterCompany());

    result.current.mutate({ id: 'gone', name: 'اسم صالح' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as SisterCompanyWriteError).code).toBe('notFound');
  });
});

describe('useSetSisterCompanyActive', () => {
  it('flips is_active and sends nothing else', async () => {
    const { result } = mountHook(() => useSetSisterCompanyActive());

    result.current.mutate({ id: 'sc1', isActive: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.update).toEqual({ is_active: false });
    expect(recorded.eq).toEqual(['id', 'sc1']);
  });
});

describe('useDeleteSisterCompany', () => {
  it('deletes by id and asks for the deleted row back', async () => {
    respondWith([{ id: 'sc1' }]);
    const { result } = mountHook(() => useDeleteSisterCompany());

    result.current.mutate({ id: 'sc1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.deleted).toBe(true);
    expect(recorded.eq).toEqual(['id', 'sc1']);
    expect(recorded.select).toBe('id');
    expect(result.current.data).toEqual({ id: 'sc1' });
  });

  it('reports a delete that matched no row as notFound instead of success', async () => {
    respondWith([]);
    const { result } = mountHook(() => useDeleteSisterCompany());

    result.current.mutate({ id: 'gone' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as SisterCompanyWriteError).code).toBe('notFound');
  });

  it('translates ON DELETE RESTRICT (23503) into hasBranches', async () => {
    respondWith(null, { code: '23503' });
    const { result } = mountHook(() => useDeleteSisterCompany());

    result.current.mutate({ id: 'sc1' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as SisterCompanyWriteError).code).toBe('hasBranches');
  });
});

describe('cache invalidation', () => {
  it('invalidates the sister tree after a successful write', async () => {
    const { result, queryClient } = mountHook(() => useCreateSisterCompany());
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    result.current.mutate({ name: 'شركة جديدة' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: SISTER_COMPANIES_QUERY_KEY });
  });

  it('refetches the tree when a delete is refused', async () => {
    respondWith(null, { code: '23503' });
    const { result, queryClient } = mountHook(() => useDeleteSisterCompany());
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    result.current.mutate({ id: 'sc1' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: SISTER_COMPANIES_QUERY_KEY });
  });
});
