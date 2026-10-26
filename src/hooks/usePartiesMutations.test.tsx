import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PARTIES_QUERY_KEY } from '@/hooks/useParties';
import {
  PartyWriteError,
  buildCreatePayload,
  buildRenamePayload,
  buildSetActivePayload,
  classifyPartyWriteError,
  useCreateParty,
  useDeleteParty,
  useRenameParty,
  useSetPartyActive,
  type CreatePartyInput,
} from '@/hooks/usePartiesMutations';
import type { PartyBranch } from '@/lib/database.types';

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

/**
 * A thenable PostgREST-builder stub covering the three shapes the mutations
 * use: `insert().select().single()`, `update().eq().select().single()` and
 * `delete().eq().select('id')`.
 */
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
  id: 'p1',
  branch: 'outbound',
  code: 'OUT-001',
  name: 'مؤسسة الأفق',
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

const createInput = (patch: Partial<CreatePartyInput> = {}): CreatePartyInput => ({
  branch: 'inbound',
  name: 'شركة النيل للتوريدات',
  ...patch,
});

describe('buildCreatePayload', () => {
  it('sends the branch and the trimmed name — and never a code', () => {
    const payload = buildCreatePayload(createInput({ name: '  شركة النيل للتوريدات الصناعية ' }));

    expect(payload).toEqual({
      branch: 'inbound',
      name: 'شركة النيل للتوريدات الصناعية',
    });
    expect(payload).not.toHaveProperty('code');
    /* Nothing else may ride along: a party is a name and a branch. */
    expect(Object.keys(payload).sort()).toEqual(['branch', 'name']);
  });

  it('sends the outbound branch when the row belongs to the other root', () => {
    expect(buildCreatePayload(createInput({ branch: 'outbound' }))).toEqual({
      branch: 'outbound',
      name: 'شركة النيل للتوريدات',
    });
  });

  it('refuses an invalid name or a branch outside the two roots before any request', () => {
    const invalid: Partial<CreatePartyInput>[] = [
      { name: '  ' },
      { name: 'ش' },
      { branch: 'vendor' as PartyBranch },
      { branch: 'local_supplier' as PartyBranch },
      { branch: '' as PartyBranch },
      { branch: null as unknown as PartyBranch },
    ];
    for (const patch of invalid) {
      expect(() => buildCreatePayload(createInput(patch))).toThrowError(PartyWriteError);
    }
  });
});

describe('buildRenamePayload', () => {
  it('never carries the immutable branch or code', () => {
    const payload = buildRenamePayload('  مؤسسة الأفق للتجارة ');

    expect(payload).toEqual({ name: 'مؤسسة الأفق للتجارة' });
    expect(payload).not.toHaveProperty('branch');
    expect(payload).not.toHaveProperty('code');
  });

  it('rejects an invalid name', () => {
    expect(() => buildRenamePayload('')).toThrowError(PartyWriteError);
    expect(() => buildRenamePayload('ش')).toThrowError(PartyWriteError);
  });
});

describe('buildSetActivePayload', () => {
  it('carries the flag alone', () => {
    expect(buildSetActivePayload(false)).toEqual({ is_active: false });
    expect(buildSetActivePayload(true)).toEqual({ is_active: true });
  });
});

describe('classifyPartyWriteError', () => {
  it('maps RLS and JWT rejections to forbidden', () => {
    expect(classifyPartyWriteError({ code: '42501' }, 'create')).toBe('forbidden');
    expect(classifyPartyWriteError({ code: 'PGRST301' }, 'delete')).toBe('forbidden');
    expect(classifyPartyWriteError({ message: 'permission denied' }, 'rename')).toBe('forbidden');
  });

  it('gives the immutability refusal (22023) its own code', () => {
    expect(classifyPartyWriteError({ code: '22023' }, 'rename')).toBe('immutable');
  });

  it('reads 23503 as "still referenced" only on delete', () => {
    expect(classifyPartyWriteError({ code: '23503' }, 'delete')).toBe('hasReferences');
    expect(classifyPartyWriteError({ code: '23503' }, 'create')).toBe('unknown');
  });

  it('maps CHECK violations to validation and a zero-row single to notFound', () => {
    expect(classifyPartyWriteError({ code: '23514' }, 'create')).toBe('validation');
    expect(classifyPartyWriteError({ code: 'PGRST116' }, 'rename')).toBe('notFound');
  });

  it('maps transport failures to network and everything else to unknown', () => {
    expect(classifyPartyWriteError({ code: 'PGRST503' }, 'toggle')).toBe('network');
    expect(classifyPartyWriteError({ message: 'Failed to fetch' }, 'toggle')).toBe('network');
    expect(classifyPartyWriteError({ code: 'XX000' }, 'toggle')).toBe('unknown');
  });

  it('passes through an already-classified error', () => {
    expect(classifyPartyWriteError(new PartyWriteError('validation'), 'create')).toBe('validation');
  });
});

describe('useCreateParty', () => {
  it('inserts the branch and the name, with no code key anywhere in the payload', async () => {
    const { result } = mountHook(() => useCreateParty());

    result.current.mutate(createInput({ branch: 'outbound', name: 'مؤسسة الأفق' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.table).toBe('parties');
    expect(recorded.insert).toEqual({ branch: 'outbound', name: 'مؤسسة الأفق' });
    expect(recorded.insert).not.toHaveProperty('code');
  });

  it('issues no request at all for an invalid name', async () => {
    const { result } = mountHook(() => useCreateParty());

    result.current.mutate(createInput({ name: 'ش' }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as PartyWriteError).code).toBe('validation');
    expect(recorded.table).toBeUndefined();
  });

  it('fails closed with "unavailable" when the client is not configured', async () => {
    mock.client = null;
    const { result } = mountHook(() => useCreateParty());

    result.current.mutate(createInput());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as PartyWriteError).code).toBe('unavailable');
  });
});

describe('useRenameParty', () => {
  it('renames by id and sends neither branch nor code', async () => {
    const { result } = mountHook(() => useRenameParty());

    result.current.mutate({ id: 'p1', name: 'مؤسسة الأفق للتجارة والتوزيع' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.update).toEqual({ name: 'مؤسسة الأفق للتجارة والتوزيع' });
    expect(recorded.update).not.toHaveProperty('branch');
    expect(recorded.update).not.toHaveProperty('code');
    expect(recorded.eq).toEqual(['id', 'p1']);
  });

  it('reports a row that vanished as notFound', async () => {
    respondWith(null, { code: 'PGRST116' });
    const { result } = mountHook(() => useRenameParty());

    result.current.mutate({ id: 'gone', name: 'اسم صالح' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as PartyWriteError).code).toBe('notFound');
  });

  it('issues no request for an invalid name', async () => {
    const { result } = mountHook(() => useRenameParty());

    result.current.mutate({ id: 'p1', name: ' ' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as PartyWriteError).code).toBe('validation');
    expect(recorded.update).toBeUndefined();
  });
});

describe('useSetPartyActive', () => {
  it('flips is_active and sends nothing else', async () => {
    const { result } = mountHook(() => useSetPartyActive());

    result.current.mutate({ id: 'p1', isActive: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.update).toEqual({ is_active: false });
    expect(recorded.eq).toEqual(['id', 'p1']);
  });
});

describe('useDeleteParty', () => {
  it('deletes by id and asks for the deleted row back', async () => {
    respondWith([{ id: 'p1' }]);
    const { result } = mountHook(() => useDeleteParty());

    result.current.mutate({ id: 'p1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.deleted).toBe(true);
    expect(recorded.eq).toEqual(['id', 'p1']);
    expect(recorded.select).toBe('id');
    expect(result.current.data).toEqual({ id: 'p1' });
  });

  it('reports a delete that matched no row as notFound instead of success', async () => {
    respondWith([]);
    const { result } = mountHook(() => useDeleteParty());

    result.current.mutate({ id: 'gone' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as PartyWriteError).code).toBe('notFound');
  });

  it('translates a future ON DELETE RESTRICT (23503) into hasReferences', async () => {
    respondWith(null, { code: '23503' });
    const { result } = mountHook(() => useDeleteParty());

    result.current.mutate({ id: 'p1' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as PartyWriteError).code).toBe('hasReferences');
  });
});

describe('cache invalidation', () => {
  it('invalidates the parties directory after a successful write', async () => {
    const { result, queryClient } = mountHook(() => useCreateParty());
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    result.current.mutate(createInput());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: PARTIES_QUERY_KEY });
  });

  it('refetches the directory when a delete is refused', async () => {
    respondWith(null, { code: '23503' });
    const { result, queryClient } = mountHook(() => useDeleteParty());
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    result.current.mutate({ id: 'p1' });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: PARTIES_QUERY_KEY });
  });
});
