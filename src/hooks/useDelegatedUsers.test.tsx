import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELEGATED_USERS_QUERY_KEY,
  getSoonestExpiry,
  hasAnyExpiry,
  parseDelegatedUsers,
  useDelegatedUsers,
} from '@/hooks/useDelegatedUsers';
import { USERS_QUERY_KEY } from '@/hooks/useUsersManagement';

const { invoke, fromSelect, clientState } = vi.hoisted(() => {
  const invoke = vi.fn();
  const fromSelect = vi.fn();
  return {
    invoke,
    fromSelect,
    clientState: {
      value: null as {
        functions: { invoke: typeof invoke };
        from?: (table: string) => unknown;
      } | null,
    },
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => clientState.value }));

function configureClient() {
  clientState.value = {
    functions: { invoke },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: fromSelect,
        }),
      }),
    }),
  };
}

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

function mountHook(options?: { readonly enabled?: boolean }) {
  const { queryClient, Wrapper } = wrapper();
  const hook = renderHook(() => useDelegatedUsers(options), { wrapper: Wrapper });
  return { ...hook, queryClient };
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ data: { data: [] }, error: null });
  fromSelect.mockReset().mockResolvedValue({ data: [], error: null });
  configureClient();
});

describe('useDelegatedUsers', () => {
  it('stores active delegations with expires_at and granted_at under ["delegated-users"]', async () => {
    invoke.mockResolvedValue({
      data: {
        data: [
          {
            user_id: 'user-a',
            permission_slug: 'users.approve',
            granted_at: '2026-10-20T09:00:00.000Z',
            expires_at: null,
          },
          {
            user_id: 'user-a',
            permission_slug: 'password_reset.manage',
            granted_at: '2026-10-21T10:30:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
          },
          {
            user_id: 'user-expired',
            permission_slug: 'users.approve',
            granted_at: '2019-01-01T00:00:00.000Z',
            expires_at: '2020-01-01T00:00:00.000Z',
          },
        ],
      },
      error: null,
    });

    const { result, queryClient } = mountHook();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(DELEGATED_USERS_QUERY_KEY).toEqual(['delegated-users']);
    expect(queryClient.getQueryData(['delegated-users'])).toBeDefined();
    expect(invoke).toHaveBeenCalledWith('admin-user-capabilities', {
      body: { action: 'list-all' },
    });
    expect(result.current.delegatedUsers.get('user-a')).toEqual([
      {
        slug: 'password_reset.manage',
        granted_at: '2026-10-21T10:30:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      {
        slug: 'users.approve',
        granted_at: '2026-10-20T09:00:00.000Z',
        expires_at: null,
      },
    ]);
    expect(result.current.delegatedUsers.has('user-expired')).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('computes getSoonestExpiry and hasAnyExpiry across permanent and expiring grants', () => {
    const permanentOnly = [
      { slug: 'users.approve', expires_at: null, granted_at: '2026-10-22T00:00:00.000Z' },
    ];
    expect(getSoonestExpiry(permanentOnly)).toBeNull();
    expect(hasAnyExpiry(permanentOnly)).toBe(false);

    const mixed = [
      { slug: 'settings.manage', expires_at: null, granted_at: '2026-10-22T00:00:00.000Z' },
      {
        slug: 'password_reset.manage',
        expires_at: '2026-11-01T12:00:00.000Z',
        granted_at: '2026-10-22T00:00:00.000Z',
      },
      {
        slug: 'users.approve',
        expires_at: '2026-10-25T12:00:00.000Z',
        granted_at: '2026-10-22T00:00:00.000Z',
      },
    ];
    expect(hasAnyExpiry(mixed)).toBe(true);
    expect(getSoonestExpiry(mixed)?.toISOString()).toBe('2026-10-25T12:00:00.000Z');
  });

  it('filters expired and malformed rows in parseDelegatedUsers', () => {
    const fixedNow = Date.parse('2026-10-22T12:00:00.000Z');
    const parsed = parseDelegatedUsers(
      [
        null,
        'invalid',
        {},
        { user_id: '', permission_slug: 'users.approve', expires_at: null },
        { user_id: 'u1', permission_slug: '', expires_at: null },
        { user_id: 'u1', permission_slug: 'users.approve', expires_at: '2026-10-22T11:59:59.000Z' },
        {
          user_id: 'u2',
          permission_slug: 'settings.manage',
          granted_at: '2026-10-20T00:00:00.000Z',
          expires_at: null,
        },
        {
          user_id: 'u2',
          permission_slug: 'users.approve',
          granted_at: '2026-10-21T00:00:00.000Z',
          expires_at: '2026-10-22T12:00:01.000Z',
        },
      ],
      fixedNow,
    );

    expect(parsed.has('u1')).toBe(false);
    expect(parsed.get('u2')).toEqual([
      {
        slug: 'settings.manage',
        granted_at: '2026-10-20T00:00:00.000Z',
        expires_at: null,
      },
      {
        slug: 'users.approve',
        granted_at: '2026-10-21T00:00:00.000Z',
        expires_at: '2026-10-22T12:00:01.000Z',
      },
    ]);
  });

  it('does not fetch while enabled is false', () => {
    const { result } = mountHook({ enabled: false });
    expect(result.current.delegatedUsers.size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('falls back to per-user RPC listing when the edge bridge does not recognize list-all yet', async () => {
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(USERS_QUERY_KEY, [
      { id: 'u-regular', status: 'active', approvalStatus: 'approved', isProtected: false },
      { id: 'u-delegated', status: 'active', approvalStatus: 'approved', isProtected: false },
      { id: 'u-owner', status: 'active', approvalStatus: 'approved', isProtected: true },
    ]);

    invoke.mockImplementation((_fn: string, opts: { body: Record<string, unknown> }) => {
      if (opts.body['action'] === 'list-all') {
        return Promise.resolve({
          data: null,
          error: { context: { json: vi.fn().mockResolvedValue({ error: 'invalid_action' }) } },
        });
      }
      if (opts.body['action'] === 'list' && opts.body['targetUserId'] === 'u-delegated') {
        return Promise.resolve({
          data: {
            data: [
              {
                id: 'g1',
                permission_slug: 'users.approve',
                granted_at: '2026-10-22T00:00:00Z',
                expires_at: null,
              },
            ],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: { data: [] }, error: null });
    });

    const { result } = renderHook(() => useDelegatedUsers(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.delegatedUsers.get('u-delegated')).toEqual([
      {
        slug: 'users.approve',
        granted_at: '2026-10-22T00:00:00Z',
        expires_at: null,
      },
    ]);
    expect(result.current.delegatedUsers.has('u-regular')).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it.each([
    ['permission_denied', 'forbidden'],
    ['unavailable', 'unavailable'],
    ['unexpected', 'unknown'],
  ] as const)('maps bridge error %s to %s', async (wireCode, expected) => {
    invoke.mockResolvedValue({
      data: null,
      error: { context: { json: vi.fn().mockResolvedValue({ error: wireCode }) } },
    });

    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe(expected));
    expect(result.current.delegatedUsers.size).toBe(0);
  });

  it('maps missing Supabase client to unavailable and supports manual refresh', async () => {
    const { result } = mountHook();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    invoke.mockClear();

    clientState.value = null;
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.error).toBe('unavailable'));
    expect(invoke).not.toHaveBeenCalled();
  });
});
