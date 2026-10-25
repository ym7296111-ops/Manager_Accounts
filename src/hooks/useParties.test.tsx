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
  type: 'local_supplier',
  code: 'LOC-001',
  name: 'شركة النيل',
  tax_number: null,
  commercial_register: null,
  address: null,
  contact_person: null,
  phone: null,
  email: null,
  credit_limit: null,
  payment_terms: null,
  is_active: true,
  ...patch,
});

describe('parseParties', () => {
  it('returns an empty list for a non-array payload', () => {
    expect(parseParties(null)).toEqual([]);
    expect(parseParties(undefined)).toEqual([]);
    expect(parseParties({})).toEqual([]);
  });

  it('orders by type (local supplier, foreign supplier, customer), then numeric code', () => {
    const parsed = parseParties([
      row({ id: 'c1', type: 'customer', code: 'CUS-001', name: 'عميل' }),
      row({ id: 'l10', type: 'local_supplier', code: 'LOC-010', name: 'عاشر' }),
      row({ id: 'f1', type: 'foreign_supplier', code: 'FRN-001', name: 'أجنبي' }),
      row({ id: 'l2', type: 'local_supplier', code: 'LOC-002', name: 'ثانٍ' }),
    ]);

    expect(parsed.map((party) => party.code)).toEqual(['LOC-002', 'LOC-010', 'FRN-001', 'CUS-001']);
  });

  it('maps the wire columns onto the render model', () => {
    const [party] = parseParties([
      row({
        tax_number: '123456789',
        commercial_register: '101010',
        address: 'المنطقة الصناعية',
        contact_person: 'أحمد سامي',
        phone: '+20238200000',
        email: 'sales@nile-supplies.example.com',
        credit_limit: 250000,
        payment_terms: 30,
        is_active: false,
      }),
    ]);

    expect(party).toEqual({
      id: 'p1',
      type: 'local_supplier',
      code: 'LOC-001',
      name: 'شركة النيل',
      taxNumber: '123456789',
      commercialRegister: '101010',
      address: 'المنطقة الصناعية',
      contactPerson: 'أحمد سامي',
      phone: '+20238200000',
      email: 'sales@nile-supplies.example.com',
      creditLimit: 250000,
      paymentTerms: 30,
      isActive: false,
    });
  });

  it('tolerates a stringified credit limit and collapses blank optionals to null', () => {
    const [party] = parseParties([row({ tax_number: '   ', credit_limit: '250.5' })]);
    expect(party?.taxNumber).toBeNull();
    expect(party?.creditLimit).toBe(250.5);
  });

  it('reads impossible credit values as unset instead of trusting them', () => {
    const [party] = parseParties([row({ credit_limit: -3, payment_terms: 45 })]);
    expect(party?.creditLimit).toBeNull();
    expect(party?.paymentTerms).toBeNull();

    const [immediate] = parseParties([row({ credit_limit: 0, payment_terms: 0 })]);
    expect(immediate?.creditLimit).toBe(0);
    expect(immediate?.paymentTerms).toBe(0);
  });

  it('drops malformed rows instead of blanking the directory', () => {
    const parsed = parseParties([
      row(),
      row({ id: 'p2', code: 'LOC-002', name: '' }),
      row({ id: 'p3', code: 'LOC-003', type: 'vendor', name: 'نوع مجهول' }),
      /* Retired types have no badge and no place in the table. */
      row({ id: 'p4', code: 'SIS-001', type: 'sister_company', name: 'شقيقة' }),
      row({ id: 'p5', code: 'INT-001', type: 'internal', name: 'داخلية' }),
      row({ id: 'p1', code: 'LOC-099', name: 'مكررة' }),
      'not a row',
      null,
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.code).toBe('LOC-001');
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
  it('reads the whole directory in one request, ordered by code', async () => {
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
