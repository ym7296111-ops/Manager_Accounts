import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLASSIFICATIONS_QUERY_KEY,
  CLASSIFICATIONS_SELECT,
  ClassificationsError,
  classifyClassificationsError,
  parseClassifications,
  useClassifications,
} from '@/hooks/useClassifications';
import type { ClassificationNode } from '@/hooks/useClassifications';

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
  return renderHook(() => useClassifications(), { wrapper: Wrapper });
}

beforeEach(() => {
  respondWith([]);
  configureClient();
});

/** Flattens the tree into `code:level` strings so ordering is easy to assert. */
function outline(nodes: readonly ClassificationNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${'  '.repeat(depth)}${node.code}:${node.level}`,
    ...outline(node.children, depth + 1),
  ]);
}

describe('parseClassifications', () => {
  it('assembles a three-level tree from a flat, unordered response', () => {
    const parsed = parseClassifications([
      { id: 'i1', parent_id: 'g1', code: 'CLS-004', name: 'تصنيف فرعي أدنى', is_active: true },
      { id: 'g1', parent_id: 'c1', code: 'CLS-002', name: 'تصنيف فرعي', is_active: true },
      { id: 'c1', parent_id: null, code: 'CLS-001', name: 'تصنيف أساسي', is_active: true },
    ]);

    expect(outline(parsed)).toEqual(['CLS-001:1', '  CLS-002:2', '    CLS-004:3']);
    expect(parsed[0]?.children[0]?.children[0]?.name).toBe('تصنيف فرعي أدنى');
  });

  it('assembles a branch deeper than the old three-level ceiling', () => {
    /* The schema no longer caps depth (20261105000000), so the client builder
       must not either — it derives levels purely from the parent links. */
    const parsed = parseClassifications([
      { id: 'n6', parent_id: 'n5', code: 'CLS-106', name: 'ديزل آليات ثقيلة' },
      { id: 'n3', parent_id: 'n2', code: 'CLS-103', name: 'سولار' },
      { id: 'n1', parent_id: null, code: 'CLS-101', name: 'مخزون' },
      { id: 'n5', parent_id: 'n4', code: 'CLS-105', name: 'ديزل معدات' },
      { id: 'n2', parent_id: 'n1', code: 'CLS-102', name: 'وقود' },
      { id: 'n4', parent_id: 'n3', code: 'CLS-104', name: 'سولار تشغيل' },
    ]);

    expect(outline(parsed)).toEqual([
      'CLS-101:1',
      '  CLS-102:2',
      '    CLS-103:3',
      '      CLS-104:4',
      '        CLS-105:5',
      '          CLS-106:6',
    ]);
  });

  it('derives level from the structure and ignores a level claimed on the wire', () => {
    const parsed = parseClassifications([
      { id: 'c1', parent_id: null, code: 'CLS-001', name: 'تصنيف أساسي', level: 3 },
      { id: 'g1', parent_id: 'c1', code: 'CLS-002', name: 'تصنيف فرعي', level: 1 },
    ]);

    expect(parsed[0]?.level).toBe(1);
    expect(parsed[0]?.children[0]?.level).toBe(2);
  });

  it('sorts siblings by code with numeric awareness, including codes past 999', () => {
    const parsed = parseClassifications([
      { id: 'c2', parent_id: null, code: 'CLS-02', name: 'b' },
      { id: 'c10', parent_id: null, code: 'CLS-100', name: 'c' },
      { id: 'c1', parent_id: null, code: 'CLS-01', name: 'a' },
    ]);

    /* Plain string order would sort CLS-100 before CLS-02. */
    expect(parsed.map((node) => node.code)).toEqual(['CLS-01', 'CLS-02', 'CLS-100']);
  });

  it('carries the derived is_leaf and is_active flags, and defaults to false', () => {
    const parsed = parseClassifications([
      {
        id: 'c1',
        parent_id: null,
        code: 'CLS-001',
        name: 'تصنيف أساسي',
        is_leaf: false,
        is_active: true,
      },
      { id: 'i1', parent_id: 'c1', code: 'CLS-002', name: 'تصنيف فرعي أدنى', is_leaf: 'true' },
    ]);

    expect(parsed[0]?.isLeaf).toBe(false);
    expect(parsed[0]?.isActive).toBe(true);
    expect(parsed[0]?.children[0]?.isLeaf).toBe(false);
    expect(parsed[0]?.children[0]?.isActive).toBe(false);
  });

  it('treats a missing parent_id as a root and drops rows with an unusable one', () => {
    const parsed = parseClassifications([
      { id: 'c1', code: 'CLS-001', name: 'جذر بلا حقل أب' },
      { id: 'c2', parent_id: '', code: 'CLS-002', name: 'أب فارغ' },
      { id: 'c3', parent_id: 42, code: 'CLS-003', name: 'أب غير نصي' },
    ]);

    expect(parsed.map((node) => node.code)).toEqual(['CLS-001']);
    expect(parsed[0]?.level).toBe(1);
  });

  it('drops malformed rows instead of blanking the tree', () => {
    const parsed = parseClassifications([
      { id: 'ok', parent_id: null, code: 'CLS-001', name: 'سليمة' },
      { id: 'bad-1', parent_id: null, code: '', name: 'بلا كود' },
      { id: 'bad-2', parent_id: null, code: 'CLS-002', name: '   ' },
      { parent_id: null, code: 'CLS-003', name: 'بلا معرّف' },
      null,
      'garbage',
    ]);

    expect(parsed.map((node) => node.code)).toEqual(['CLS-001']);
  });

  it('never renders an orphan or a cycle: neither is reachable from a root', () => {
    const parsed = parseClassifications([
      { id: 'root', parent_id: null, code: 'CLS-001', name: 'جذر' },
      { id: 'orphan', parent_id: 'missing', code: 'CLS-002', name: 'يتيم' },
      { id: 'loop-a', parent_id: 'loop-b', code: 'CLS-003', name: 'أ' },
      { id: 'loop-b', parent_id: 'loop-a', code: 'CLS-004', name: 'ب' },
      { id: 'self', parent_id: 'self', code: 'CLS-005', name: 'ذاتي' },
    ]);

    expect(outline(parsed)).toEqual(['CLS-001:1']);
  });

  it('keeps the first row when the payload repeats an id', () => {
    const parsed = parseClassifications([
      { id: 'c1', parent_id: null, code: 'CLS-001', name: 'الأولى' },
      { id: 'c1', parent_id: null, code: 'CLS-999', name: 'المكررة' },
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('الأولى');
  });

  it('returns an empty list for null, undefined or a non-array payload', () => {
    expect(parseClassifications(null)).toEqual([]);
    expect(parseClassifications(undefined)).toEqual([]);
    expect(parseClassifications({ id: 'c1' })).toEqual([]);
  });
});

describe('classifyClassificationsError', () => {
  it('maps RLS and JWT rejections to forbidden', () => {
    expect(classifyClassificationsError({ code: '42501', message: 'permission denied' })).toBe(
      'forbidden',
    );
    expect(classifyClassificationsError({ code: 'PGRST301', message: 'JWT expired' })).toBe(
      'forbidden',
    );
    expect(
      classifyClassificationsError({ message: 'permission_denied for table classifications' }),
    ).toBe('forbidden');
  });

  it('maps transport failures to network and everything else to unknown', () => {
    expect(classifyClassificationsError(new Error('Failed to fetch'))).toBe('network');
    expect(classifyClassificationsError({ code: 'PGRST503', message: 'unavailable' })).toBe(
      'network',
    );
    expect(
      classifyClassificationsError({ code: '42703', message: 'column x does not exist' }),
    ).toBe('unknown');
    expect(classifyClassificationsError(null)).toBe('unknown');
  });

  it('passes through an already-classified ClassificationsError', () => {
    expect(classifyClassificationsError(new ClassificationsError('unavailable'))).toBe(
      'unavailable',
    );
  });
});

describe('CLASSIFICATIONS_SELECT', () => {
  it('projects exactly what the tree needs and never asks for a level', () => {
    /* `level` is derived from parent_id on both sides; selecting it would give
       the UI a second, possibly stale, source of truth. `code` is read-only. */
    expect(CLASSIFICATIONS_SELECT).toBe('id, parent_id, code, name, is_leaf, is_active');
  });
});

describe('useClassifications', () => {
  it('runs one flat query against public.classifications and returns the tree', async () => {
    respondWith([
      { id: 'g1', parent_id: 'c1', code: 'CLS-002', name: 'تصنيف فرعي', is_active: true },
      { id: 'c1', parent_id: null, code: 'CLS-001', name: 'تصنيف أساسي', is_active: true },
    ]);

    const { result } = mountHook();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(calls.table).toBe('classifications');
    expect(calls.select).toBe(CLASSIFICATIONS_SELECT);
    /* One request, one ordering: no pagination, no per-level fetch. */
    expect(calls.orders).toEqual(['code']);
    expect(result.current.data?.[0]?.children).toHaveLength(1);
  });

  it('exposes 42501 as a forbidden ClassificationsError rather than an empty tree', async () => {
    respondWith(null, { code: '42501', message: 'permission denied for table classifications' });

    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(ClassificationsError);
    expect((result.current.error as ClassificationsError).code).toBe('forbidden');
  });

  it('fails closed with "unavailable" when the Supabase client is not configured', async () => {
    mock.client = null;

    const { result } = mountHook();

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect((result.current.error as ClassificationsError).code).toBe('unavailable');
    expect(calls.table).toBeUndefined();
  });

  it('does not fetch while disabled', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useClassifications({ enabled: false }), { wrapper: Wrapper });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.table).toBeUndefined();
  });

  it('caches under the project-settings classifications key', async () => {
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(CLASSIFICATIONS_QUERY_KEY).toEqual(['project-settings', 'classifications']);
  });
});
