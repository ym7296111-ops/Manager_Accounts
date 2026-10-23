import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUserCapabilities } from '@/hooks/useUserCapabilities';

const { invoke, clientState } = vi.hoisted(() => {
  const invoke = vi.fn();
  return {
    invoke,
    clientState: {
      value: null as { functions: { invoke: typeof invoke } } | null,
    },
  };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => clientState.value }));

const validRows = [
  {
    id: 'grant-approve',
    permission_slug: 'users.approve',
    granted_at: '2026-10-20T10:00:00.000Z',
    expires_at: '2027-01-18T23:59:59.999Z',
  },
  {
    id: 'grant-reset',
    permission_slug: 'password_reset.manage',
    granted_at: '2026-10-20T11:00:00.000Z',
    expires_at: null,
  },
];

function configureClient() {
  clientState.value = { functions: { invoke } };
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

function mountHook(targetUserId = 'target-user') {
  const { queryClient, Wrapper } = wrapper();
  const hook = renderHook(() => useUserCapabilities(targetUserId), { wrapper: Wrapper });
  return { ...hook, queryClient };
}

async function waitForIdle(result: { current: ReturnType<typeof useUserCapabilities> }) {
  await waitFor(() => expect(result.current.isLoading).toBe(false));
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ data: { data: [] }, error: null });
  configureClient();
});

describe('useUserCapabilities read path', () => {
  it('requests the target user through the service bridge and parses both delegable capabilities', async () => {
    invoke.mockResolvedValue({ data: { data: validRows }, error: null });
    const { result } = mountHook();

    await waitFor(() => expect(result.current.grants).toHaveLength(2));
    expect(invoke).toHaveBeenCalledWith('admin-user-capabilities', {
      body: { action: 'list', targetUserId: 'target-user' },
    });
    expect(result.current.grants).toEqual([
      {
        id: 'grant-approve',
        permissionSlug: 'users.approve',
        grantedAt: '2026-10-20T10:00:00.000Z',
        expiresAt: '2027-01-18T23:59:59.999Z',
      },
      {
        id: 'grant-reset',
        permissionSlug: 'password_reset.manage',
        grantedAt: '2026-10-20T11:00:00.000Z',
        expiresAt: null,
      },
    ]);
    expect(result.current.error).toBeNull();
  });

  it.each([
    ['null result', null],
    ['undefined result', undefined],
    ['string result', 'bad-response'],
    ['number result', 17],
    ['array result', []],
    ['object without data', {}],
    ['non-array data', { data: { id: 'not-a-list' } }],
    ['string data', { data: 'not-a-list' }],
    ['null data', { data: null }],
  ])('normalizes a %s to an empty grants list', async (_label, response) => {
    invoke.mockResolvedValue({ data: response, error: null });
    const { result } = mountHook();

    await waitForIdle(result);
    expect(result.current.grants).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it.each([
    ['null row', null],
    ['string row', 'users.approve'],
    ['array row', ['grant-id', 'users.approve']],
    ['empty object', {}],
    ['missing permission', { id: 'grant-id', granted_at: '2026-10-20T00:00:00Z' }],
    ['empty permission', { id: 'grant-id', permission_slug: '', granted_at: 'now' }],
    ['non-string permission', { id: 'grant-id', permission_slug: 7, granted_at: 'now' }],
    ['missing id', { permission_slug: 'users.approve', granted_at: 'now' }],
    ['non-string id', { id: 12, permission_slug: 'users.approve', granted_at: 'now' }],
    ['missing grant time', { id: 'grant-id', permission_slug: 'users.approve' }],
    ['non-string grant time', { id: 'grant-id', permission_slug: 'users.approve', granted_at: 12 }],
  ])('filters an invalid %s instead of exposing it as a grant', async (_label, row) => {
    invoke.mockResolvedValue({ data: { data: [row] }, error: null });
    const { result } = mountHook();

    await waitForIdle(result);
    expect(result.current.grants).toEqual([]);
  });

  it.each([
    ['users.approve', null],
    ['users.approve', '2027-01-18T23:59:59.999Z'],
    ['password_reset.manage', null],
    ['password_reset.manage', '2027-01-18T23:59:59.999Z'],
    /* The delegatable set is owner-configured data now: any slug the RPC
       returns is a real grant and must survive parsing. */
    ['settings.manage', null],
    ['dashboard:read', '2027-01-18T23:59:59.999Z'],
    ['workspace.2.access', null],
  ] as const)(
    'accepts the capability %s with expiry %s without a client allow-list',
    async (permissionSlug, expiresAt) => {
      invoke.mockResolvedValue({
        data: {
          data: [
            {
              id: 'grant-id',
              permission_slug: permissionSlug,
              granted_at: '2026-10-20T00:00:00.000Z',
              expires_at: expiresAt,
            },
          ],
        },
        error: null,
      });
      const { result } = mountHook();

      await waitFor(() => expect(result.current.grants).toHaveLength(1));
      expect(result.current.grants[0]).toMatchObject({
        id: 'grant-id',
        permissionSlug,
        expiresAt,
      });
    },
  );

  it('uses an empty capability list while the target id is not available', () => {
    const { result } = mountHook('');

    expect(result.current.grants).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('starts in a loading state until the safe RPC response arrives', async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const { result } = mountHook();

    expect(result.current.isLoading).toBe(true);
    await act(async () => {
      resolveResponse?.({ data: { data: [] }, error: null });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('exposes refresh and performs a new list request', async () => {
    const { result } = mountHook();
    await waitForIdle(result);
    invoke.mockClear();

    await act(async () => result.current.refresh());

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('admin-user-capabilities', {
      body: { action: 'list', targetUserId: 'target-user' },
    });
  });
});

describe('useUserCapabilities error normalization', () => {
  it.each([
    ['permission_denied', 'forbidden'],
    ['capability_not_delegatable', 'not-delegatable'],
    ['capability_already_granted', 'duplicate'],
    ['not_found', 'not-found'],
    ['invalid_action', 'invalid-expiry'],
    ['unavailable', 'unavailable'],
    ['unexpected_server_error', 'unknown'],
  ] as const)('maps edge error %s to %s', async (wireCode, expectedCode) => {
    invoke.mockResolvedValue({
      data: null,
      error: { context: { json: vi.fn().mockResolvedValue({ error: wireCode }) } },
    });
    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe(expectedCode));
    expect(result.current.grants).toEqual([]);
  });

  it.each([
    ['missing context', {}],
    ['null context', { context: null }],
    ['string context', { context: 'bad' }],
    ['missing json method', { context: {} }],
    ['non-function json method', { context: { json: 'bad' } }],
    ['non-object error', 'error'],
  ])('normalizes %s into an unknown service failure', async (_label, edgeError) => {
    invoke.mockResolvedValue({ data: null, error: edgeError });
    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe('unknown'));
  });

  it('normalizes a rejected response-body parse to unknown', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: { context: { json: vi.fn().mockRejectedValue(new Error('invalid JSON')) } },
    });
    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe('unknown'));
  });

  it('normalizes fetch TypeErrors to network', async () => {
    invoke.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe('network'));
  });

  it('normalizes non-network thrown values to unknown', async () => {
    invoke.mockRejectedValue(new Error('unexpected exception'));
    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe('unknown'));
  });

  it('reports unavailable when the Supabase client is missing', async () => {
    clientState.value = null;
    const { result } = mountHook();

    await waitFor(() => expect(result.current.error).toBe('unavailable'));
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('useUserCapabilities mutation paths', () => {
  it.each([
    ['users.approve', null],
    ['users.approve', '2027-01-18T23:59:59.999Z'],
    ['password_reset.manage', null],
    ['password_reset.manage', '2027-01-18T23:59:59.999Z'],
    ['settings.manage', null],
  ] as const)(
    'grants %s with expiry %s through the edge function',
    async (permissionSlug, expiresAt) => {
      const { result } = mountHook();
      await waitForIdle(result);
      invoke.mockClear();

      await act(async () => result.current.grant(permissionSlug, expiresAt));

      expect(invoke).toHaveBeenCalledWith('admin-user-capabilities', {
        body: { action: 'grant', targetUserId: 'target-user', permissionSlug, expiresAt },
      });
    },
  );

  /* The client keeps NO allow-list anymore: delegability is the owner's
     database flag, so even the permanently protected slugs are forwarded —
     refusal is the database's job (covered by the SQL audit), surfaced back
     here as the 'not-delegatable' code. */
  it.each(['settings.manage', 'dashboard:read', 'roles.manage'])(
    'forwards %s to the edge function instead of refusing it client-side',
    async (permission) => {
      const { result } = mountHook();
      await waitForIdle(result);
      invoke.mockClear();

      await act(async () => result.current.grant(permission, null));

      expect(invoke).toHaveBeenCalledWith('admin-user-capabilities', {
        body: {
          action: 'grant',
          targetUserId: 'target-user',
          permissionSlug: permission,
          expiresAt: null,
        },
      });
    },
  );

  it('surfaces a server-side delegability refusal as not-delegatable', async () => {
    const { result } = mountHook();
    await waitForIdle(result);
    invoke.mockResolvedValue({
      data: null,
      error: {
        context: { json: vi.fn().mockResolvedValue({ error: 'capability_not_delegatable' }) },
      },
    });

    await expect(result.current.grant('settings.manage', null)).rejects.toMatchObject({
      code: 'not-delegatable',
    });
  });

  it('refuses an empty slug before making a request', async () => {
    const { result } = mountHook();
    await waitForIdle(result);
    invoke.mockClear();

    await expect(result.current.grant('', null)).rejects.toMatchObject({ code: 'unknown' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('revokes one capability by grant id through the edge function', async () => {
    const { result } = mountHook();
    await waitForIdle(result);
    invoke.mockClear();

    await act(async () => result.current.revoke('grant-id'));

    expect(invoke).toHaveBeenCalledWith('admin-user-capabilities', {
      body: { action: 'revoke', capabilityId: 'grant-id' },
    });
  });

  it('invalidates the target capability and delegated-users caches after a successful grant', async () => {
    const { result, queryClient } = mountHook();
    await waitForIdle(result);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => result.current.grant('users.approve', null));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user-capabilities', 'target-user'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['delegated-users'] });
  });

  it('invalidates the target capability and delegated-users caches after a successful revoke', async () => {
    const { result, queryClient } = mountHook();
    await waitForIdle(result);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => result.current.revoke('grant-id'));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['user-capabilities', 'target-user'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['delegated-users'] });
  });

  it('returns the unavailable error from a mutation when the client is missing', async () => {
    const { result } = mountHook();
    await waitForIdle(result);
    clientState.value = null;

    await expect(result.current.grant('users.approve', null)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it.each([
    ['permission_denied', 'forbidden'],
    ['capability_not_delegatable', 'not-delegatable'],
    ['capability_already_granted', 'duplicate'],
    ['not_found', 'not-found'],
    ['invalid_action', 'invalid-expiry'],
    ['unexpected_error', 'unknown'],
  ] as const)('maps mutation error %s to %s', async (wireCode, expectedCode) => {
    const { result } = mountHook();
    await waitForIdle(result);
    invoke.mockResolvedValue({
      data: null,
      error: { context: { json: vi.fn().mockResolvedValue({ error: wireCode }) } },
    });

    await expect(result.current.revoke('grant-id')).rejects.toMatchObject({ code: expectedCode });
  });

  it('maps a mutation network failure without leaking the underlying exception', async () => {
    const { result } = mountHook();
    await waitForIdle(result);
    invoke.mockRejectedValue(new TypeError('failed at secret endpoint'));

    await expect(result.current.revoke('grant-id')).rejects.toMatchObject({ code: 'network' });
  });
});
