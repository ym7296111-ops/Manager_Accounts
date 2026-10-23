import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/context/AuthContext';

/**
 * Sign-out cache hygiene: `AuthProvider` must drop the cached notification
 * feed (`['user-notifications', …]`) on every path that ends a session, so the
 * next account on the same browser can never read the previous account's rows
 * or badge count. Unrelated entries (branding, localization, …) must survive.
 *
 * The Supabase client is stubbed at the seams `AuthContext` touches
 * (`auth.*`, `from('profiles')…`). Sessions are verified, so the profile stub
 * reports `approved`.
 *
 * Plain DOM matchers only — this project does not depend on jest-dom.
 */

const USER_ID = 'user-1';

const session = { user: { id: USER_ID }, access_token: 'verified-session-token' };

type AuthListener = (event: string, session: unknown) => void;

const { client, authApi, emitAuth } = vi.hoisted(() => {
  let listener: AuthListener | null = null;
  const authApi = {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  };
  const client = {
    auth: authApi,
    from: vi.fn(),
    /** Test handle: assign the captured listener from `beforeEach`. */
    captureListener: (next: AuthListener) => {
      listener = next;
    },
  };
  const emitAuth = (event: string, value: unknown) => listener?.(event, value);
  return { client, authApi, emitAuth };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => client }));

/** Surface the signed-in id, loading flag, and a sign-out trigger for assertions. */
function Probe() {
  const { session, loading, signOut } = useAuth();
  return (
    <>
      <output data-testid="who">{session?.user.id ?? 'signed-out'}</output>
      <output data-testid="loading">{String(loading)}</output>
      <button type="button" onClick={() => void signOut()}>
        sign out
      </button>
    </>
  );
}

function renderAuth(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function renderSignedIn(queryClient: QueryClient) {
  renderAuth(queryClient);
  await waitFor(() => expect(screen.getByTestId('who').textContent).toBe(USER_ID));
}

/** Seed the caches a signed-in session would have built. */
function seedCaches(queryClient: QueryClient) {
  queryClient.setQueryData(['user-notifications', USER_ID], [{ id: 'n1' }]);
  queryClient.setQueryData(['user-notifications', USER_ID, 'unread-count'], 4);
  /* Another user's stale entry must go too — the cleanup is prefix-wide. */
  queryClient.setQueryData(['user-notifications', 'previous-user'], [{ id: 'stale' }]);
  queryClient.setQueryData(['user-notifications', 'previous-user', 'history'], [{ id: 'old' }]);
  /* Unrelated app-shell cache: must survive a sign-out. */
  queryClient.setQueryData(['branding'], { appName: 'Keep me' });
}

function expectNotificationCacheCleared(queryClient: QueryClient) {
  const remaining = queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
    .filter((key) => key[0] === 'user-notifications');
  expect(remaining).toEqual([]);
  expect(queryClient.getQueryData(['branding'])).toEqual({ appName: 'Keep me' });
}

beforeEach(() => {
  vi.clearAllMocks();
  /* `restoreMocks: true` strips implementations after each test, so every seam
     is re-established here rather than relying on the hoisted defaults. */
  authApi.getSession = vi.fn().mockResolvedValue({ data: { session }, error: null });
  authApi.onAuthStateChange = vi.fn((listener: AuthListener) => {
    client.captureListener(listener);
    return { data: { subscription: { unsubscribe: () => undefined } } };
  });
  authApi.signOut = vi.fn().mockResolvedValue({ error: null });
  client.from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: { approval_status: 'approved' }, error: null }),
      }),
    }),
  }));
});

describe('AuthProvider sign-out cache cleanup', () => {
  it('drops the user-notifications cache when signOut() succeeds', async () => {
    const queryClient = new QueryClient();
    await renderSignedIn(queryClient);
    seedCaches(queryClient);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
      await Promise.resolve();
    });

    expect(authApi.signOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('signed-out'));
    expectNotificationCacheCleared(queryClient);
  });

  it('drops the user-notifications cache on a SIGNED_OUT auth event', async () => {
    const queryClient = new QueryClient();
    await renderSignedIn(queryClient);
    seedCaches(queryClient);

    /* Session ended elsewhere (expiry, remote revocation): the event, not
       signOut(), is what reaches this tab. */
    act(() => emitAuth('SIGNED_OUT', null));

    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('signed-out'));
    expectNotificationCacheCleared(queryClient);
  });

  it('keeps the caches while the user stays signed in', async () => {
    const queryClient = new QueryClient();
    await renderSignedIn(queryClient);
    seedCaches(queryClient);

    expect(queryClient.getQueryData(['user-notifications', USER_ID, 'unread-count'])).toBe(4);
    expect(queryClient.getQueryData(['branding'])).toEqual({ appName: 'Keep me' });
  });

  it('does not flip loading back to true when re-verifying the same approved user on USER_UPDATED', async () => {
    const queryClient = new QueryClient();
    await renderSignedIn(queryClient);
    expect(screen.getByTestId('loading').textContent).toBe('false');

    act(() => emitAuth('USER_UPDATED', { user: { id: USER_ID }, access_token: 'refreshed-token' }));
    expect(screen.getByTestId('loading').textContent).toBe('false');

    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe(USER_ID));
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });
});
