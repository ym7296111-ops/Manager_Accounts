import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PARTIES_QUERY_KEY } from '@/hooks/useParties';
import {
  PartyWriteError,
  buildCreatePayload,
  buildSetActivePayload,
  buildUpdatePayload,
  classifyPartyWriteError,
  useCreateParty,
  useDeleteParty,
  useSetPartyActive,
  useUpdateParty,
  type CreatePartyInput,
} from '@/hooks/usePartiesMutations';
import type { PartyType } from '@/lib/database.types';

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
  type: 'customer',
  code: 'CUS-001',
  name: 'مؤسسة الأفق',
  tax_number: null,
  commercial_register: null,
  address: null,
  contact_person: null,
  phone: null,
  email: null,
  credit_limit: null,
  payment_terms: null,
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
  type: 'local_supplier',
  name: 'شركة النيل للتوريدات',
  ...patch,
});

describe('buildCreatePayload', () => {
  it('sends the type and the editable columns — and never a code', () => {
    const payload = buildCreatePayload(
      createInput({
        name: '  شركة النيل للتوريدات الصناعية ',
        taxNumber: ' 123456789 ',
        email: 'sales@nile-supplies.example.com',
        creditLimit: 250000.5,
        paymentTerms: 30,
      }),
    );

    expect(payload).toEqual({
      type: 'local_supplier',
      name: 'شركة النيل للتوريدات الصناعية',
      tax_number: '123456789',
      commercial_register: null,
      address: null,
      contact_person: null,
      phone: null,
      email: 'sales@nile-supplies.example.com',
      credit_limit: 250000.5,
      payment_terms: 30,
    });
    expect(payload).not.toHaveProperty('code');
  });

  it('sends explicit null credit terms for a customer that recorded none', () => {
    const payload = buildCreatePayload(createInput({ type: 'customer' }));
    expect(payload.credit_limit).toBeNull();
    expect(payload.payment_terms).toBeNull();
  });

  it('sends both credit keys for every remaining type, including a foreign supplier', () => {
    const payload = buildCreatePayload(
      createInput({ type: 'foreign_supplier', creditLimit: 5000, paymentTerms: 30 }),
    );
    expect(payload).toMatchObject({
      type: 'foreign_supplier',
      credit_limit: 5000,
      payment_terms: 30,
    });
  });

  it('refuses an invalid name, email, credit value or type before any request can happen', () => {
    const invalid: Partial<CreatePartyInput>[] = [
      { name: '  ' },
      { name: 'ش' },
      { email: 'not-an-email' },
      { creditLimit: -1 },
      { creditLimit: Number.NaN },
      { paymentTerms: 45 as CreatePartyInput['paymentTerms'] },
      { type: 'vendor' as PartyType },
      /* Retired types cannot mint codes any more. */
      { type: 'supplier' as PartyType },
      { type: 'internal' as PartyType },
      { type: 'sister_company' as PartyType },
    ];
    for (const patch of invalid) {
      expect(() => buildCreatePayload(createInput(patch))).toThrowError(PartyWriteError);
    }
  });
});

describe('buildUpdatePayload', () => {
  it('never carries the immutable type or code', () => {
    const payload = buildUpdatePayload({
      name: 'مؤسسة الأفق للتجارة',
      creditLimit: 150000,
      paymentTerms: 60,
    });

    expect(payload).not.toHaveProperty('type');
    expect(payload).not.toHaveProperty('code');
    expect(payload).toMatchObject({
      name: 'مؤسسة الأفق للتجارة',
      credit_limit: 150000,
      payment_terms: 60,
    });
  });

  it('writes explicit nulls when the user clears the credit terms', () => {
    const payload = buildUpdatePayload({
      name: 'مؤسسة الأفق للتجارة',
      creditLimit: null,
      paymentTerms: null,
    });
    expect(payload.credit_limit).toBeNull();
    expect(payload.payment_terms).toBeNull();
  });

  it('rejects an invalid name and an out-of-set credit value', () => {
    expect(() => buildUpdatePayload({ name: '' })).toThrowError(PartyWriteError);
    expect(() => buildUpdatePayload({ name: 'اسم صالح', paymentTerms: 45 as never })).toThrowError(
      PartyWriteError,
    );
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
    expect(classifyPartyWriteError({ message: 'permission denied' }, 'update')).toBe('forbidden');
  });

  it('gives the immutability refusal (22023) its own code', () => {
    expect(classifyPartyWriteError({ code: '22023' }, 'update')).toBe('immutable');
  });

  it('reads 23503 as "still referenced" only on delete', () => {
    expect(classifyPartyWriteError({ code: '23503' }, 'delete')).toBe('hasReferences');
    expect(classifyPartyWriteError({ code: '23503' }, 'create')).toBe('unknown');
  });

  it('maps CHECK violations to validation and a zero-row single to notFound', () => {
    expect(classifyPartyWriteError({ code: '23514' }, 'create')).toBe('validation');
    expect(classifyPartyWriteError({ code: 'PGRST116' }, 'update')).toBe('notFound');
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
  it('inserts the type and fields, with no code key anywhere in the payload', async () => {
    const { result } = mountHook(() => useCreateParty());

    result.current.mutate(createInput({ type: 'customer', creditLimit: 100, paymentTerms: 0 }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.table).toBe('parties');
    expect(recorded.insert).toMatchObject({
      type: 'customer',
      credit_limit: 100,
      payment_terms: 0,
    });
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

describe('useUpdateParty', () => {
  it('updates the editable columns by id and sends neither type nor code', async () => {
    const { result } = mountHook(() => useUpdateParty());

    result.current.mutate({
      id: 'p1',
      name: 'مؤسسة الأفق للتجارة والتوزيع',
      creditLimit: 150000,
      paymentTerms: 60,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.update).toMatchObject({
      name: 'مؤسسة الأفق للتجارة والتوزيع',
      credit_limit: 150000,
      payment_terms: 60,
    });
    expect(recorded.update).not.toHaveProperty('type');
    expect(recorded.update).not.toHaveProperty('code');
    expect(recorded.eq).toEqual(['id', 'p1']);
  });

  it('clears credit terms by sending nulls, not by omitting the keys', async () => {
    const { result } = mountHook(() => useUpdateParty());

    result.current.mutate({
      id: 'p9',
      name: 'عميل بلا ائتمان',
      creditLimit: null,
      paymentTerms: null,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(recorded.update).toHaveProperty('credit_limit', null);
    expect(recorded.update).toHaveProperty('payment_terms', null);
  });

  it('reports a row that vanished as notFound', async () => {
    respondWith(null, { code: 'PGRST116' });
    const { result } = mountHook(() => useUpdateParty());

    result.current.mutate({ id: 'gone', name: 'اسم صالح' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as PartyWriteError).code).toBe('notFound');
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
