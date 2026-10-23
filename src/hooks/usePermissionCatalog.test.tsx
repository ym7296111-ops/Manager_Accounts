import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERMISSION_CATALOG_ERROR_KEYS,
  isProtectedPermissionSlug,
  parsePermissionCatalog,
  usePermissionCatalog,
} from '@/hooks/usePermissionCatalog';

/**
 * Data layer of owner-configured delegation.
 *
 * The Supabase client is stubbed at the seams the hook uses (`from`, `rpc`,
 * `auth.getUser`), pinning the contract: catalogue reads come from
 * `public.permissions` (no hardcoded slug list), writes call
 * `admin_set_permission_delegatable` with the caller's OWN id as executor,
 * and every refusal class normalizes into a locale-independent code.
 */

const { mockFrom, mockRpc, mockGetUser, clientState } = vi.hoisted(() => {
  const mockFrom = vi.fn();
  const mockRpc = vi.fn();
  const mockGetUser = vi.fn();
  const clientState = {
    value: null as null | {
      from: typeof mockFrom;
      rpc: typeof mockRpc;
      auth: { getUser: typeof mockGetUser };
    },
  };
  return { mockFrom, mockRpc, mockGetUser, clientState };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => clientState.value }));

const ROWS = [
  {
    id: 'p-settings',
    slug: 'settings.manage',
    module: 'app',
    name_ar: 'الإعدادات الإدارية العامة',
    name_en: 'Manage general settings',
    description: null,
    is_delegatable: false,
  },
  {
    id: 'p-star',
    slug: '*',
    module: 'system',
    name_ar: 'كل الصلاحيات',
    name_en: 'All permissions',
    description: 'wildcard',
    is_delegatable: false,
  },
  {
    id: 'p-approve',
    slug: 'users.approve',
    module: 'system',
    name_ar: 'اعتماد المستخدمين',
    name_en: 'Approve users',
    description: null,
    is_delegatable: true,
  },
];

function configureClient() {
  clientState.value = { from: mockFrom, rpc: mockRpc, auth: { getUser: mockGetUser } };
}

function mockCatalogResult(result: { data: unknown; error: unknown }) {
  mockFrom.mockReturnValue({
    select: () => ({
      order: () => ({
        limit: () => Promise.resolve(result),
      }),
    }),
  });
}

function mockCatalogReject(error: Error) {
  mockFrom.mockReturnValue({
    select: () => ({
      order: () => ({
        limit: () => Promise.reject(error),
      }),
    }),
  });
}

function mountHook() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => usePermissionCatalog(), { wrapper: Wrapper });
  return { ...hook, queryClient };
}

async function waitForIdle(result: { current: ReturnType<typeof usePermissionCatalog> }) {
  await waitFor(() => expect(result.current.isLoading).toBe(false));
}

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset().mockResolvedValue({
    data: { permission_slug: 'settings.manage', is_delegatable: true, changed: true },
    error: null,
  });
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
  configureClient();
  mockCatalogResult({ data: ROWS, error: null });
});

describe('parsePermissionCatalog', () => {
  it.each([null, undefined, 'rows', 42, { data: [] }])(
    'normalizes a non-array payload (%s) to an empty catalogue',
    (payload) => {
      expect(parsePermissionCatalog(payload)).toEqual([]);
    },
  );

  it('drops malformed rows and maps the survivors', () => {
    const parsed = parsePermissionCatalog([
      null,
      'users.approve',
      { slug: 'users.approve' },
      { id: 'p-x' },
      { id: '', slug: 'users.approve' },
      ROWS[2],
      { ...ROWS[0], id: 9 },
    ]);
    expect(parsed).toEqual([
      {
        id: 'p-approve',
        slug: 'users.approve',
        module: 'system',
        nameAr: 'اعتماد المستخدمين',
        nameEn: 'Approve users',
        description: null,
        isDelegatable: true,
      },
    ]);
  });

  it('treats anything but literal true as not delegatable', () => {
    const parsed = parsePermissionCatalog([
      { ...ROWS[2], is_delegatable: 'true' },
      { ...ROWS[0], is_delegatable: 1 },
    ]);
    expect(parsed.every((entry) => entry.isDelegatable === false)).toBe(true);
  });

  it('orders by module rank, then slug, regardless of wire order', () => {
    const parsed = parsePermissionCatalog(ROWS);
    expect(parsed.map((entry) => entry.slug)).toEqual(['*', 'users.approve', 'settings.manage']);
  });
});

describe('usePermissionCatalog read path', () => {
  it('loads the catalogue from the permissions table and derives delegatable + bySlug', async () => {
    const { result } = mountHook();
    await waitFor(() => expect(result.current.permissions).toHaveLength(3));

    expect(mockFrom).toHaveBeenCalledWith('permissions');
    expect(result.current.delegatable.map((entry) => entry.slug)).toEqual(['users.approve']);
    expect(result.current.bySlug.get('settings.manage')?.nameEn).toBe('Manage general settings');
    expect(result.current.bySlug.get('*')?.isDelegatable).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('refresh re-reads the permissions table', async () => {
    const { result } = mountHook();
    await waitForIdle(result);
    mockFrom.mockClear();

    await act(async () => result.current.refresh());

    expect(mockFrom).toHaveBeenCalledWith('permissions');
  });

  it.each([
    [{ code: 'PGRST205', message: 'relation not found' }, 'unavailable'],
    [{ code: '42501', message: 'permission denied' }, 'forbidden'],
    [{ code: 'XX000', message: 'something exploded' }, 'unknown'],
  ] as const)('maps the read failure %s to %s', async (pgError, expected) => {
    mockCatalogResult({ data: null, error: pgError });
    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe(expected));
    expect(result.current.permissions).toEqual([]);
  });

  it('maps a transport failure to network', async () => {
    mockCatalogReject(new TypeError('Failed to fetch'));
    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe('network'));
  });

  it('reports unavailable when the Supabase client is missing', async () => {
    clientState.value = null;
    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe('unavailable'));
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('usePermissionCatalog write path', () => {
  it('calls the RPC with the caller as executor and refetches the catalogue', async () => {
    const { result, queryClient } = mountHook();
    await waitForIdle(result);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => result.current.setDelegatable('settings.manage', true));

    expect(mockRpc).toHaveBeenCalledWith('admin_set_permission_delegatable', {
      p_permission_slug: 'settings.manage',
      p_is_delegatable: true,
      p_executor_id: 'owner-1',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['permission-catalog'] });
  });

  it('fails closed as forbidden when there is no verified caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const { result } = mountHook();
    await waitForIdle(result);

    await expect(result.current.setDelegatable('settings.manage', true)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('fails as unavailable when the client is missing', async () => {
    const { result } = mountHook();
    await waitForIdle(result);
    clientState.value = null;

    await expect(result.current.setDelegatable('settings.manage', true)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: '42501', message: 'permission_is_protected' }, 'protected'],
    [{ code: '42501', message: 'permission_denied' }, 'forbidden'],
    [{ code: '22023', message: 'invalid_capability' }, 'not-found'],
    [{ code: 'PGRST202', message: 'function not found' }, 'unavailable'],
    [{ code: 'XX000', message: 'boom' }, 'unknown'],
  ] as const)('maps the RPC refusal %s to %s', async (pgError, expected) => {
    mockRpc.mockResolvedValue({ data: null, error: pgError });
    const { result } = mountHook();
    await waitForIdle(result);

    await expect(result.current.setDelegatable('settings.manage', true)).rejects.toMatchObject({
      code: expected,
    });
  });
});

describe('protected slugs and error keys', () => {
  it('marks only the wildcard and role management as protected', () => {
    expect(isProtectedPermissionSlug('*')).toBe(true);
    expect(isProtectedPermissionSlug('roles.manage')).toBe(true);
    expect(isProtectedPermissionSlug('users.approve')).toBe(false);
    expect(isProtectedPermissionSlug('settings.manage')).toBe(false);
    expect(isProtectedPermissionSlug('')).toBe(false);
  });

  it('maps every error code onto a roles.delegatable dictionary key', () => {
    for (const key of Object.values(PERMISSION_CATALOG_ERROR_KEYS)) {
      expect(key.startsWith('roles.delegatable.error.')).toBe(true);
    }
  });
});
