import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDelegationExpiringSoon,
  parseMyDelegatedCapabilities,
  parseMyRoles,
  useMyCapabilities,
  useMyRoles,
} from '@/hooks/useMyCapabilities';
import { createRealtimeClient } from '@/test/setup';

const { client, authState } = vi.hoisted(() => {
  const state: { userId: string | null; loading: boolean } = {
    userId: 'user-delegate-1',
    loading: false,
  };
  return {
    client: {
      rpc: vi.fn(),
      channel: (_name: string): unknown => undefined,
      removeChannel: (_channel: unknown): void => undefined,
    },
    authState: state,
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => client,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    session: authState.userId !== null ? { user: { id: authState.userId } } : null,
    configured: true,
    loading: authState.loading,
  }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useMyCapabilities & useMyRoles', () => {
  let live: ReturnType<typeof createRealtimeClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    authState.userId = 'user-delegate-1';
    authState.loading = false;
    live = createRealtimeClient();
    client.channel = live.channel;
    client.removeChannel = live.removeChannel;
  });

  it('computes 7-day expiring-soon status boundaries accurately', () => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    expect(isDelegationExpiringSoon(null, now)).toBe(false);
    expect(isDelegationExpiringSoon('not-a-date', now)).toBe(false);
    expect(isDelegationExpiringSoon('2026-10-22T11:59:59.000Z', now)).toBe(false);
    expect(isDelegationExpiringSoon('2026-10-27T12:00:00.000Z', now)).toBe(true);
    expect(isDelegationExpiringSoon('2026-10-29T12:00:00.000Z', now)).toBe(true);
    expect(isDelegationExpiringSoon('2026-11-05T12:00:00.000Z', now)).toBe(false);
  });

  it('filters expired delegations and preserves active and permanent grants', () => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    const parsed = parseMyDelegatedCapabilities(
      [
        {
          id: 'cap-active',
          slug: 'users.approve',
          granted_by: 'owner-1',
          granted_by_email: 'owner@example.com',
          granted_at: '2026-10-20T10:00:00.000Z',
          expires_at: '2026-10-27T10:00:00.000Z',
        },
        {
          id: 'cap-expired',
          slug: 'users.reset_password',
          granted_by: 'owner-1',
          granted_by_email: 'owner@example.com',
          granted_at: '2026-10-01T10:00:00.000Z',
          expires_at: '2026-10-21T10:00:00.000Z',
        },
        {
          id: 'cap-permanent',
          slug: 'settings.manage',
          granted_by: 'owner-1',
          granted_by_email: 'owner@example.com',
          granted_at: '2026-10-20T10:00:00.000Z',
          expires_at: null,
        },
      ],
      now,
    );

    expect(parsed.map((item) => item.id)).toEqual(['cap-active', 'cap-permanent']);
  });

  it('calls get_my_delegated_capabilities RPC and refreshes on Realtime change', async () => {
    let rows = [
      {
        id: 'cap-1',
        slug: 'users.approve',
        granted_by: 'owner-1',
        granted_by_email: 'owner@example.com',
        granted_at: '2026-10-22T09:00:00.000Z',
        expires_at: null,
      },
    ];
    client.rpc = vi.fn((fnName: string) => {
      if (fnName === 'get_my_delegated_capabilities') {
        return Promise.resolve({ data: rows, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const { result } = renderHook(() => useMyCapabilities(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(client.rpc).toHaveBeenCalledWith('get_my_delegated_capabilities');
    expect(result.current.capabilities).toHaveLength(1);
    expect(result.current.capabilities[0]?.slug).toBe('users.approve');

    rows = [];
    act(() => live.emitChange(0));
    await waitFor(() => expect(result.current.capabilities).toHaveLength(0));
  });

  it('parses and returns caller roles from get_my_roles', async () => {
    client.rpc = vi.fn((fnName: string) => {
      if (fnName === 'get_my_roles') {
        return Promise.resolve({
          data: [{ slug: 'viewer', name_ar: 'مشاهد', name_en: 'Viewer' }],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    });

    expect(parseMyRoles(['editor', 'editor'])).toEqual([
      { slug: 'editor', name_ar: 'editor', name_en: 'editor' },
    ]);

    const { result } = renderHook(() => useMyRoles(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.roles).toEqual([{ slug: 'viewer', name_ar: 'مشاهد', name_en: 'Viewer' }]);
  });
});
