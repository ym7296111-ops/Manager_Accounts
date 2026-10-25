import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SISTER_COMPANIES_QUERY_KEY,
  SISTER_COMPANIES_SELECT,
  SisterCompaniesError,
  classifySisterCompaniesError,
  parseSisterCompanies,
  useSisterCompanies,
} from '@/hooks/useSisterCompanies';

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
  return renderHook(() => useSisterCompanies(), { wrapper: Wrapper });
}

beforeEach(() => {
  respondWith([]);
  configureClient();
});

const row = (patch: Record<string, unknown> = {}) => ({
  id: 'sc1',
  parent_id: null,
  level: 1,
  code: 'SIS-001',
  name: 'الشركة المتحدة للخدمات اللوجستية',
  is_active: true,
  ...patch,
});

describe('parseSisterCompanies', () => {
  it('returns an empty tree for a non-array payload', () => {
    expect(parseSisterCompanies(null)).toEqual([]);
    expect(parseSisterCompanies(undefined)).toEqual([]);
    expect(parseSisterCompanies({})).toEqual([]);
  });

  it('assembles parents with their branches, sorted numerically by code', () => {
    const parsed = parseSisterCompanies([
      row({ id: 'b2', parent_id: 'sc1', level: 2, code: 'SIS-001-02', name: 'فرع ثانٍ' }),
      row({ id: 'sc2', code: 'SIS-002', name: 'شركة الواحة' }),
      row({ id: 'b1', parent_id: 'sc1', level: 2, code: 'SIS-001-01', name: 'فرع أول' }),
      row(),
    ]);

    expect(parsed.map((company) => company.code)).toEqual(['SIS-001', 'SIS-002']);
    expect(parsed[0]?.branches.map((branch) => branch.code)).toEqual(['SIS-001-01', 'SIS-001-02']);
    expect(parsed[1]?.branches).toEqual([]);
  });

  it('maps the wire columns onto the render model', () => {
    const [company] = parseSisterCompanies([row({ is_active: false })]);

    expect(company).toEqual({
      id: 'sc1',
      parentId: null,
      level: 1,
      code: 'SIS-001',
      name: 'الشركة المتحدة للخدمات اللوجستية',
      isActive: false,
      branches: [],
    });
  });

  it('drops malformed rows, orphans and anything deeper than two levels', () => {
    const parsed = parseSisterCompanies([
      row(),
      row({ id: 'bad-name', code: 'SIS-003', name: '' }),
      row({ id: 'bad-level', level: 3, code: 'SIS-004', name: 'مستوى ثالث' }),
      row({ id: 'orphan', parent_id: 'missing', level: 2, code: 'SIS-005-01', name: 'يتيم' }),
      row({ id: 'deep', parent_id: 'b2', level: 2, code: 'SIS-001-02-01', name: 'تحت فرع' }),
      row({ id: 'b2', parent_id: 'sc1', level: 2, code: 'SIS-001-02', name: 'فرع ثانٍ' }),
      row({ id: 'sc1', code: 'SIS-001', name: 'مكررة' }),
      'not a row',
      null,
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.branches.map((branch) => branch.id)).toEqual(['b2']);
  });
});

describe('classifySisterCompaniesError', () => {
  it('maps RLS and JWT rejections to forbidden', () => {
    expect(classifySisterCompaniesError({ code: '42501' })).toBe('forbidden');
    expect(classifySisterCompaniesError({ code: 'PGRST301' })).toBe('forbidden');
    expect(classifySisterCompaniesError({ message: 'permission denied for table x' })).toBe(
      'forbidden',
    );
  });

  it('maps transport failures to network and everything else to unknown', () => {
    expect(classifySisterCompaniesError({ code: 'PGRST503' })).toBe('network');
    expect(classifySisterCompaniesError({ message: 'Failed to fetch' })).toBe('network');
    expect(classifySisterCompaniesError({ code: 'PGRST200' })).toBe('unknown');
    expect(classifySisterCompaniesError(null)).toBe('unknown');
  });

  it('passes through an already-classified error', () => {
    expect(classifySisterCompaniesError(new SisterCompaniesError('unavailable'))).toBe(
      'unavailable',
    );
  });
});

describe('useSisterCompanies', () => {
  it('reads the whole tree in one request, ordered by code', async () => {
    respondWith([row()]);
    const { result } = mountHook();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls.table).toBe('sister_companies');
    expect(calls.select).toBe(SISTER_COMPANIES_SELECT);
    expect(calls.orders).toEqual(['code']);
    expect(result.current.data).toHaveLength(1);
    expect(SISTER_COMPANIES_QUERY_KEY).toEqual(['project-settings', 'sister-companies']);
  });

  it('fails closed with "unavailable" when the client is not configured', async () => {
    mock.client = null;
    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as SisterCompaniesError).code).toBe('unavailable');
  });

  it('surfaces a denied grant as forbidden, not as an empty tree', async () => {
    respondWith(null, { code: '42501', message: 'permission denied for table sister_companies' });
    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as SisterCompaniesError).code).toBe('forbidden');
  });
});
