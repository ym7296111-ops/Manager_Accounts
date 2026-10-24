import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCreatePayload,
  buildUpdatePayload,
  ClassificationWriteError,
  classifyClassificationWriteError,
  DERIVED_COLUMNS,
  useCreateClassification,
  useDeleteClassification,
  useRenameClassification,
  useSetClassificationActive,
  type ClassificationWriteOperation,
} from '@/hooks/useClassificationsMutations';

/**
 * The client-side half of the write contract.
 *
 * These tests exist to prove what the client does NOT send as much as what it
 * does: `code`, `level` and `is_leaf` are the database's, and `parent_id` has no
 * update path. The stubs record the exact payload, so a future edit that widens
 * a payload fails here before it can reach PostgREST.
 */

const { mock, calls } = vi.hoisted(() => {
  const response: { data: unknown; error: unknown } = { data: null, error: null };
  const calls = {
    table: undefined as string | undefined,
    operation: undefined as string | undefined,
    payload: undefined as Record<string, unknown> | undefined,
    select: undefined as string | undefined,
    filters: [] as Array<{ column: string; value: unknown }>,
  };
  return { mock: { client: null as { from: (table: string) => unknown } | null, response }, calls };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mock.client }));

const ROW = {
  id: 'c-new',
  parent_id: null,
  code: 'CLS-013',
  name: 'فئة',
  level: 1,
  is_leaf: true,
  is_active: true,
};

/**
 * A thenable PostgREST-builder stub covering the four shapes the hooks use:
 * `.insert(p).select(c).single()`, `.update(p).eq('id', x).select(c).single()`,
 * `.delete().eq('id', x).select(c)`, and the plain awaited `.select()`.
 */
function configureClient() {
  calls.table = undefined;
  calls.operation = undefined;
  calls.payload = undefined;
  calls.select = undefined;
  calls.filters = [];

  const settle = () => Promise.resolve({ ...mock.response });

  const terminal = () => {
    const builder: Record<string, unknown> = {
      select: (projection: string) => {
        calls.select = projection;
        const nested: Record<string, unknown> = {
          single: () => settle(),
          then: (resolve: (v: unknown) => void, reject: (r: unknown) => void): void => {
            void settle().then(resolve, reject);
          },
        };
        return nested;
      },
      single: () => settle(),
      then: (resolve: (v: unknown) => void, reject: (r: unknown) => void): void => {
        void settle().then(resolve, reject);
      },
    };
    return builder;
  };

  mock.client = {
    from: (table: string) => {
      calls.table = table;
      return {
        insert: (payload: Record<string, unknown>) => {
          calls.operation = 'insert';
          calls.payload = payload;
          return terminal();
        },
        update: (payload: Record<string, unknown>) => {
          calls.operation = 'update';
          calls.payload = payload;
          return {
            eq: (column: string, value: unknown) => {
              calls.filters.push({ column, value });
              return terminal();
            },
          };
        },
        delete: () => {
          calls.operation = 'delete';
          return {
            eq: (column: string, value: unknown) => {
              calls.filters.push({ column, value });
              return terminal();
            },
          };
        },
      };
    },
  };
}

function respondWith(data: unknown, error: unknown = null) {
  mock.response = { data, error };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

async function runMutation<TData, TVars>(
  useHook: () => { mutateAsync: (vars: TVars) => Promise<TData> },
  vars: TVars,
): Promise<TData> {
  const { result } = renderHook(useHook, { wrapper });
  return result.current.mutateAsync(vars);
}

beforeEach(() => {
  respondWith(ROW);
  configureClient();
});

describe('buildCreatePayload', () => {
  it('sends only the name for a category (level 1 has no parent key at all)', () => {
    const payload = buildCreatePayload({ name: '  المواد والمستلزمات  ' });

    expect(payload).toEqual({ name: 'المواد والمستلزمات' });
    /* Not `parent_id: null`: a root omits the key, so "this is a category" is a
       property of the request rather than of a null value. */
    expect('parent_id' in payload).toBe(false);
  });

  it('sends the name and parent_id for a group or an item', () => {
    expect(buildCreatePayload({ name: 'المواد الخام', parentId: 'cat-1' })).toEqual({
      name: 'المواد الخام',
      parent_id: 'cat-1',
    });
  });

  it('never carries a derived column', () => {
    for (const payload of [
      buildCreatePayload({ name: 'فئة' }),
      buildCreatePayload({ name: 'مجموعة', parentId: 'cat-1' }),
      buildCreatePayload({ name: 'صنف', parentId: 'grp-1' }),
    ]) {
      for (const column of DERIVED_COLUMNS) {
        expect(column in payload).toBe(false);
      }
      expect(Object.keys(payload).sort()).toEqual(
        'parent_id' in payload ? ['name', 'parent_id'] : ['name'],
      );
    }
  });

  it('refuses an empty or single-character name before any request can happen', () => {
    expect(() => buildCreatePayload({ name: '   ' })).toThrow(ClassificationWriteError);
    expect(() => buildCreatePayload({ name: 'م' })).toThrow(ClassificationWriteError);
    expect(() => buildCreatePayload({ name: '' })).toThrow(ClassificationWriteError);
  });
});

describe('buildUpdatePayload', () => {
  it('carries the name alone for a rename', () => {
    const payload = buildUpdatePayload({ name: '  اسم جديد  ' });
    expect(payload).toEqual({ name: 'اسم جديد' });
    /* An UPDATE must never be able to reparent: moving a node re-derives a whole
       subtree, and that is out of scope for this phase. */
    expect('parent_id' in payload).toBe(false);
  });

  it('carries is_active alone for a toggle', () => {
    expect(buildUpdatePayload({ isActive: false })).toEqual({ is_active: false });
    expect(buildUpdatePayload({ isActive: true })).toEqual({ is_active: true });
  });

  it('never carries a derived column', () => {
    for (const payload of [
      buildUpdatePayload({ name: 'x y' }),
      buildUpdatePayload({ isActive: false }),
    ]) {
      for (const column of DERIVED_COLUMNS) {
        expect(column in payload).toBe(false);
      }
    }
  });

  it('rejects an empty patch and an invalid name', () => {
    /* An empty patch is a no-op UPDATE worth catching; the union type already
       forbids it, so the call is forced only in this test. */
    expect(() => buildUpdatePayload({} as { name: string })).toThrow(ClassificationWriteError);
    expect(() => buildUpdatePayload({ name: ' ' })).toThrow(ClassificationWriteError);
  });
});

describe('classifyClassificationWriteError', () => {
  const classify = (error: unknown, operation: ClassificationWriteOperation) =>
    classifyClassificationWriteError(error, operation);

  it('maps RLS and JWT rejections to forbidden', () => {
    expect(classify({ code: '42501', message: 'permission denied' }, 'create')).toBe('forbidden');
    expect(classify({ code: 'PGRST301', message: 'JWT expired' }, 'delete')).toBe('forbidden');
  });

  it('reads 23503 by operation: children on delete, a vanished parent on insert', () => {
    // The same SQLSTATE means two different things, and the message must say so.
    expect(classify({ code: '23503', message: 'violates foreign key constraint' }, 'delete')).toBe(
      'hasChildren',
    );
    expect(classify({ code: '23503', message: 'violates foreign key constraint' }, 'create')).toBe(
      'missingParent',
    );
  });

  it('maps CHECK/level violations to validation and a zero-row single to notFound', () => {
    expect(classify({ code: '23514' }, 'rename')).toBe('validation');
    expect(classify({ code: '22023' }, 'rename')).toBe('validation');
    expect(classify({ code: 'PGRST116' }, 'rename')).toBe('notFound');
  });

  it('maps transport failures to network and everything else to unknown', () => {
    expect(classify(new Error('Failed to fetch'), 'create')).toBe('network');
    expect(classify({ code: 'PGRST503' }, 'create')).toBe('network');
    expect(classify({ code: '42703' }, 'create')).toBe('unknown');
    expect(classify(null, 'create')).toBe('unknown');
  });

  it('passes through an already-classified error', () => {
    expect(classify(new ClassificationWriteError('unavailable'), 'create')).toBe('unavailable');
  });
});

describe('useCreateClassification', () => {
  it('inserts the name only for a category and never the code, level or is_leaf', async () => {
    const row = await runMutation(useCreateClassification, { name: 'فئة جديدة' });

    expect(calls.table).toBe('classifications');
    expect(calls.operation).toBe('insert');
    expect(calls.payload).toEqual({ name: 'فئة جديدة' });
    expect(Object.keys(calls.payload ?? {}).sort()).toEqual(['name']);
    // The echo is read, not sent: it is what the server derived.
    expect(calls.select).toContain('level');
    expect(row.code).toBe('CLS-013');
  });

  it('sends parent_id when creating a group inside a category', async () => {
    await runMutation(useCreateClassification, { name: 'مجموعة', parentId: 'cat-1' });

    expect(calls.payload).toEqual({ name: 'مجموعة', parent_id: 'cat-1' });
  });

  it('sends parent_id when creating an item inside a group', async () => {
    await runMutation(useCreateClassification, { name: 'صنف', parentId: 'grp-1' });

    expect(calls.payload).toEqual({ name: 'صنف', parent_id: 'grp-1' });
  });

  it('issues no request at all for an invalid name', async () => {
    const { result } = renderHook(useCreateClassification, { wrapper });

    await expect(result.current.mutateAsync({ name: ' ' })).rejects.toBeInstanceOf(
      ClassificationWriteError,
    );
    expect(calls.table).toBeUndefined();
  });

  it('surfaces a 23503 as missingParent, not as a validation failure', async () => {
    respondWith(null, { code: '23503', message: 'violates foreign key constraint' });

    const { result } = renderHook(useCreateClassification, { wrapper });

    await expect(
      result.current.mutateAsync({ name: 'مجموعة', parentId: 'gone' }),
    ).rejects.toMatchObject({ code: 'missingParent' });
  });

  it('fails closed with "unavailable" when the client is not configured', async () => {
    mock.client = null;

    const { result } = renderHook(useCreateClassification, { wrapper });

    await expect(result.current.mutateAsync({ name: 'فئة' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('useRenameClassification', () => {
  it('updates the name by id and sends nothing else', async () => {
    await runMutation(useRenameClassification, { id: 'c1', name: '  اسم معدّل  ' });

    expect(calls.operation).toBe('update');
    expect(calls.payload).toEqual({ name: 'اسم معدّل' });
    expect(calls.filters).toEqual([{ column: 'id', value: 'c1' }]);
  });

  it('reports a row that vanished as notFound', async () => {
    respondWith(null, {
      code: 'PGRST116',
      message: 'JSON object requested, multiple (or no) rows',
    });

    const { result } = renderHook(useRenameClassification, { wrapper });

    await expect(result.current.mutateAsync({ id: 'gone', name: 'اسم' })).rejects.toMatchObject({
      code: 'notFound',
    });
  });
});

describe('useSetClassificationActive', () => {
  it('flips is_active and sends nothing else', async () => {
    await runMutation(useSetClassificationActive, { id: 'g1', isActive: false });

    expect(calls.operation).toBe('update');
    expect(calls.payload).toEqual({ is_active: false });
    expect(Object.keys(calls.payload ?? {})).toEqual(['is_active']);
    expect(calls.filters).toEqual([{ column: 'id', value: 'g1' }]);
  });
});

describe('useDeleteClassification', () => {
  it('deletes by id and asks for the deleted row back', async () => {
    respondWith([{ id: 'c1' }]);

    const deleted = await runMutation(useDeleteClassification, { id: 'c1' });

    expect(deleted).toEqual({ id: 'c1' });
    expect(calls.operation).toBe('delete');
    expect(calls.filters).toEqual([{ column: 'id', value: 'c1' }]);
  });

  it('translates ON DELETE RESTRICT (23503) into hasChildren', async () => {
    respondWith(null, {
      code: '23503',
      message: 'update or delete on table "classifications" violates foreign key constraint',
    });

    const { result } = renderHook(useDeleteClassification, { wrapper });

    await expect(result.current.mutateAsync({ id: 'parent' })).rejects.toMatchObject({
      code: 'hasChildren',
    });
  });

  it('reports a delete that matched no row as notFound instead of success', async () => {
    respondWith([]);

    const { result } = renderHook(useDeleteClassification, { wrapper });

    await expect(result.current.mutateAsync({ id: 'gone' })).rejects.toMatchObject({
      code: 'notFound',
    });
  });

  it('never claims success when the database refused the delete', async () => {
    respondWith(null, { code: '42501', message: 'permission denied for table classifications' });

    const { result } = renderHook(useDeleteClassification, { wrapper });

    await expect(result.current.mutateAsync({ id: 'c1' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('cache invalidation', () => {
  it('invalidates the classifications tree after a successful write', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false, staleTime: Infinity },
      },
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(useCreateClassification, { wrapper: Wrapper });

    result.current.mutate({ name: 'فئة' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['project-settings', 'classifications'],
    });
  });

  it('refetches the tree when a delete is refused for having children', async () => {
    /* The button is hidden for a node with children, so a refusal means the
       cache predates somebody else's insert. Refetching is what makes the row
       stop offering delete and the new child show up. */
    respondWith(null, { code: '23503', message: 'violates foreign key constraint' });

    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(useDeleteClassification, { wrapper: Wrapper });
    result.current.mutate({ id: 'c1' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe('hasChildren');
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['project-settings', 'classifications'],
    });
  });
});
