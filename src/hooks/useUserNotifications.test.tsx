import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeClient } from '@/test/setup';
import {
  USER_NOTIFICATIONS_QUERY_KEY_ROOT,
  userNotificationsQueryKey,
  userNotificationsUnreadKey,
  useUserNotifications,
  UserNotificationsError,
  type UseUserNotificationsOptions,
  type UserNotificationRow,
} from '@/hooks/useUserNotifications';
import { USER_NOTIFICATIONS_REALTIME_CHANNEL } from '@/hooks/useUserNotificationsRealtime';

/**
 * In-app notification feed: unread count, list, mark-read mutations and the
 * Realtime invalidation signal.
 *
 * The Supabase client is stubbed at the seam these hooks actually use
 * (`from().select()`, `rpc()`, `channel()`); the Realtime double comes from the
 * shared helper in `src/test/setup.ts`.
 */

const { rpc, select, client } = vi.hoisted(() => {
  const rpc = vi.fn();
  const select =
    vi.fn<(columns: string, options?: { count?: string; head?: boolean }) => unknown>();
  const client = {
    from: vi.fn(() => ({ select })),
    rpc,
    channel: vi.fn() as unknown as (name: string) => unknown,
    removeChannel: vi.fn() as unknown as (channel: unknown) => void,
    realtime: { setAuth: vi.fn() },
  };
  return { rpc, select, client };
});

const actorId = 'actor-1';

/** Mutable auth seam: most tests run signed in; the disabled-feed test nulls it. */
const auth = vi.hoisted(() => ({
  session: null as { user: { id: string }; access_token: string } | null,
}));

vi.mock('@/lib/supabase', () => ({ getSupabase: () => client }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    session: auth.session,
    configured: true,
    loading: false,
  }),
}));

function row(overrides: Partial<UserNotificationRow> = {}): UserNotificationRow {
  return {
    id: 'n1',
    type: 'user_approval_requested',
    title_key: 'notifications.type.user_approval_requested.title',
    body_key: 'notifications.type.user_approval_requested.body',
    params: { subject_email: 'p***@example.invalid' },
    link: '/settings/system/users',
    is_read: false,
    read_at: null,
    related_id: null,
    resolved_at: null,
    created_at: '2026-10-19T09:00:00.000Z',
    ...overrides,
  };
}

/** Two unread rows: one queue event, one decision addressed to the actor. */
const FEED: readonly UserNotificationRow[] = [
  row(),
  row({
    id: 'n2',
    type: 'user_approved',
    title_key: 'notifications.type.user_approved.title',
    body_key: 'notifications.type.user_approved.body',
    params: {},
    link: '/profile',
    created_at: '2026-10-19T08:00:00.000Z',
  }),
];

let live: ReturnType<typeof createRealtimeClient>;

/** Every `.eq()`/`.is()` the two queries apply, so tests can assert the
    active-feed predicate (`is_read = false AND resolved_at IS NULL`) instead
    of trusting the stub. */
interface FilterRecord {
  readonly query: 'unread-count' | 'list';
  readonly method: 'eq' | 'is';
  readonly column: string;
  readonly value: unknown;
}
let filterLog: FilterRecord[] = [];

/** The active-feed predicate both queries must apply. */
const ACTIVE_FILTERS = [
  { method: 'eq', column: 'is_read', value: false },
  { method: 'is', column: 'resolved_at', value: null },
] as const;

function filtersFor(query: 'unread-count' | 'list') {
  return filterLog
    .filter((record) => record.query === query)
    .map(({ method, column, value }) => ({ method, column, value }));
}

/**
 * `select` serves both queries; branch on the options so the count query stays
 * a head-only request (no rows over the wire). Both builders are THENABLE,
 * like a PostgREST filter builder: the hook may await at any point of the
 * chain (`.eq().is()` for the count, `.eq().is().order().limit()` for the list).
 */
function stubSelect(options: { count?: number; rows?: readonly unknown[]; error?: unknown }) {
  select.mockImplementation((_columns: string, opts?: { head?: boolean }) => {
    const head = opts?.head === true;
    const query = head ? ('unread-count' as const) : ('list' as const);
    const resolved = head
      ? { count: options.count ?? 0, data: null, error: options.error ?? null }
      : { data: options.rows ?? [], error: options.error ?? null };
    const builder = {
      eq: (column: string, value: unknown) => {
        filterLog.push({ query, method: 'eq', column, value });
        return builder;
      },
      is: (column: string, value: unknown) => {
        filterLog.push({ query, method: 'is', column, value });
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      then: (onFulfilled: unknown, onRejected: unknown) =>
        Promise.resolve(resolved).then(
          onFulfilled as (value: typeof resolved) => unknown,
          onRejected as (reason: unknown) => unknown,
        ),
    };
    return builder;
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderNotifications(options?: UseUserNotificationsOptions) {
  return renderHook(() => useUserNotifications(options), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.session = { user: { id: actorId }, access_token: 'verified-session-token' };
  filterLog = [];
  live = createRealtimeClient();
  /* `restoreMocks: true` strips implementations after each test, so every seam
     is re-established here rather than relying on the hoisted defaults. */
  client.from = vi.fn(() => ({ select }));
  client.channel = live.channel;
  client.removeChannel = live.removeChannel;
  client.realtime.setAuth = vi.fn().mockResolvedValue(undefined);
  rpc.mockResolvedValue({ data: true, error: null });
  stubSelect({ count: 2, rows: FEED });
});

describe('useUserNotifications', () => {
  it('reports the unread count from a head-only query', async () => {
    const { result } = renderNotifications();

    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    /* The badge must not pull rows: count uses head:true. */
    const countCall = select.mock.calls.find((call) => call[1]?.head === true);
    expect(countCall).toBeDefined();
    expect(countCall?.[0]).toBe('id');

    /* …and it must count the ACTIVE feed only: a row resolved upstream (or
       already read) must never inflate the badge. */
    expect(filtersFor('unread-count')).toEqual(expect.arrayContaining([...ACTIVE_FILTERS]));
  });

  it('loads the feed newest-first and bounded', async () => {
    const { result } = renderNotifications();

    await waitFor(() => expect(result.current.notifications).toHaveLength(2));
    expect(result.current.notifications[0]?.id).toBe('n1');

    /* The list query selects the full row projection, never head-only. */
    const listCall = select.mock.calls.find((call) => call[1]?.head !== true);
    expect(listCall?.[0]).toContain('title_key');
    expect(listCall?.[0]).toContain('created_at');
  });

  it('filters the list to the active feed server-side by default', async () => {
    const { result } = renderNotifications();

    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    /* WHERE is_read = false AND resolved_at IS NULL — applied by PostgREST,
       not in the browser, so read/resolved rows never render. */
    expect(filtersFor('list')).toEqual(expect.arrayContaining([...ACTIVE_FILTERS]));
  });

  it('leaves the list unfiltered when the history is requested (onlyActive: false)', async () => {
    const { result } = renderNotifications({ onlyActive: false });

    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    expect(filtersFor('list')).toEqual([]);
    /* The badge stays on the active predicate either way. */
    expect(filtersFor('unread-count')).toEqual(expect.arrayContaining([...ACTIVE_FILTERS]));
  });

  it('never fetches without a signed-in user', async () => {
    auth.session = null;

    const { result } = renderNotifications();

    /* Both queries are disabled (enabled = false): no request, no socket. */
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notifications).toHaveLength(0);
    expect(result.current.unreadCount).toBe(0);
    expect(select).not.toHaveBeenCalled();
    expect(live.channel).not.toHaveBeenCalled();
  });

  it('marks a single notification read through the RPC', async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    let changed = false;
    await act(async () => {
      changed = await result.current.markRead('n1');
    });

    expect(changed).toBe(true);
    expect(rpc).toHaveBeenCalledWith('mark_notification_read', { p_notification_id: 'n1' });
  });

  it('removes the row from the active feed optimistically before the server answers', async () => {
    /* A never-settling RPC freezes the mutation so the optimistic cache is
       observable on its own. */
    rpc.mockImplementationOnce(() => new Promise(() => undefined));
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));
    expect(result.current.unreadCount).toBe(2);

    act(() => {
      void result.current.markRead('n1');
    });

    /* A read row leaves the active feed (the server-side filter would drop it
       on refetch) and the badge decrements with it. */
    await waitFor(() => {
      expect(result.current.notifications.some((n) => n.id === 'n1')).toBe(false);
    });
    expect(result.current.unreadCount).toBe(1);
  });

  it('flips the row in place (not removal) in the history view', async () => {
    rpc.mockImplementationOnce(() => new Promise(() => undefined));
    const { result } = renderNotifications({ onlyActive: false });
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    act(() => {
      void result.current.markRead('n1');
    });

    await waitFor(() => {
      expect(result.current.notifications.find((n) => n.id === 'n1')?.is_read).toBe(true);
    });
  });

  it('clears the active feed optimistically when marking all as read', async () => {
    rpc.mockImplementationOnce(() => new Promise(() => undefined));
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    act(() => {
      void result.current.markAllRead();
    });

    await waitFor(() => {
      expect(result.current.notifications).toHaveLength(0);
      expect(result.current.unreadCount).toBe(0);
    });
  });

  it('marks the whole feed read and reports how many rows changed', async () => {
    rpc.mockResolvedValueOnce({ data: 2, error: null });
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    let changed = -1;
    await act(async () => {
      changed = await result.current.markAllRead();
    });

    expect(changed).toBe(2);
    expect(rpc).toHaveBeenCalledWith('mark_all_notifications_read');
  });

  it('surfaces a typed error when the RPC is refused', async () => {
    rpc.mockRejectedValueOnce(new UserNotificationsError('mark_notification_read', 'denied'));
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    await expect(result.current.markRead('n1')).rejects.toBeInstanceOf(UserNotificationsError);
  });

  it('restores the cache when a mutation fails', async () => {
    rpc.mockRejectedValueOnce(new UserNotificationsError('mark_notification_read', 'denied'));
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    await act(async () => {
      await expect(result.current.markRead('n1')).rejects.toBeInstanceOf(UserNotificationsError);
    });

    /* The optimistically-removed row returns, unread, with the badge restored. */
    await waitFor(() => {
      expect(result.current.notifications.find((n) => n.id === 'n1')?.is_read).toBe(false);
      expect(result.current.unreadCount).toBe(2);
    });
  });
});

describe('useUserNotifications realtime signal', () => {
  it('subscribes once, on its own channel, scoped to the caller', async () => {
    renderNotifications();

    await waitFor(() => expect(live.channels).toHaveLength(1));
    expect(live.channels[0]?.name).toMatch(new RegExp(`^${USER_NOTIFICATIONS_REALTIME_CHANNEL}-`));
    expect(live.channels[0]?.name).not.toBe('notification-templates-live');

    /* Scoped: another user's notification must not wake this client. */
    expect(live.filters[0]).toMatchObject({
      event: '*',
      schema: 'public',
      table: 'user_notifications',
      filter: `user_id=eq.${actorId}`,
    });
  });

  it('finishes loading and serves the feed when Realtime auth rejects with 401', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.realtime.setAuth = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

    const { result } = renderNotifications();

    await waitFor(() => {
      expect(result.current.realtimeState).toBe('offline');
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.isError).toBe(false);
    expect(result.current.notifications).toHaveLength(2);
    expect(live.channel).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('reports the socket state from the channel status', async () => {
    const { result } = renderNotifications();

    await waitFor(() => expect(live.channels).toHaveLength(1));
    act(() => live.setStatus('SUBSCRIBED'));
    await waitFor(() => expect(result.current.realtimeState).toBe('live'));

    act(() => live.setStatus('CLOSED'));
    await waitFor(() => expect(result.current.realtimeState).toBe('offline'));
  });

  it('invalidates the cache when the feed changes upstream', async () => {
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    const callsBefore = select.mock.calls.length;

    /* Upstream: a new row lands and the unread count grows. */
    stubSelect({ count: 3, rows: [...FEED, row({ id: 'n3' })] });
    act(() => live.setStatus('SUBSCRIBED'));
    act(() => {
      live.emitChange();
    });

    /* The signal is coalesced, so advance past the debounce window. */
    await waitFor(
      () => {
        expect(select.mock.calls.length).toBeGreaterThan(callsBefore);
      },
      { timeout: 2000 },
    );
    await waitFor(() => expect(result.current.unreadCount).toBe(3));
  });

  it('drops the badge and the row when a notification is resolved upstream', async () => {
    const { result } = renderNotifications();
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
    await waitFor(() => expect(result.current.notifications).toHaveLength(2));

    /* Upstream: `n1` gets resolved (resolved_at stamped by the backend), so
       the server-side active-feed filter now returns only `n2`. */
    stubSelect({ count: 1, rows: FEED.filter((entry) => entry.id !== 'n1') });
    act(() => live.setStatus('SUBSCRIBED'));
    act(() => {
      live.emitChange();
    });

    /* A resolve is just another Realtime change: BOTH queries invalidate and
       the badge converges without the user touching anything. */
    await waitFor(() => expect(result.current.unreadCount).toBe(1), { timeout: 2000 });
    await waitFor(() => {
      expect(result.current.notifications.map((entry) => entry.id)).toEqual(['n2']);
    });
  });

  it('polls while the socket is still connecting, not only when offline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderNotifications();
      await waitFor(() => expect(result.current.unreadCount).toBe(2));

      /* No status was ever reported, so the socket never left `connecting`;
         the badge must still converge via the 30s fallback poll. */
      expect(result.current.realtimeState).toBe('connecting');
      const callsBefore = select.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(select.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reads the realtime payload — the event carries no arguments', async () => {
    renderNotifications();
    await waitFor(() => expect(live.channels).toHaveLength(1));

    const handler = live.channels[0]?.handlers[0];
    expect(handler).toBeDefined();
    /* The registered callback takes no payload parameter. */
    expect(handler?.cb.length).toBe(0);
  });
});

describe('useUserNotifications query keys', () => {
  it('keeps the badge and the list on distinct keys, scoped by user id', () => {
    expect(userNotificationsQueryKey(actorId)).toEqual(['user-notifications', actorId]);
    expect(userNotificationsUnreadKey(actorId)).toEqual([
      'user-notifications',
      actorId,
      'unread-count',
    ]);
    expect(userNotificationsUnreadKey(actorId)).not.toEqual(userNotificationsQueryKey(actorId));
    /* The bare root stays the prefix AuthContext drops on sign-out. */
    expect(USER_NOTIFICATIONS_QUERY_KEY_ROOT).toEqual(['user-notifications']);
  });

  it('never lets two users share a cache entry', () => {
    expect(userNotificationsQueryKey('user-a')).not.toEqual(userNotificationsQueryKey('user-b'));
    expect(userNotificationsUnreadKey('user-a')).not.toEqual(userNotificationsUnreadKey('user-b'));
  });

  it('keeps the history list on its own key, apart from the active list', () => {
    expect(userNotificationsQueryKey(actorId, false)).toEqual([
      'user-notifications',
      actorId,
      'history',
    ]);
  });

  it('registers the scoped keys in the query cache at runtime', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useUserNotifications(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual(['user-notifications', actorId]);
    expect(keys).toContainEqual(['user-notifications', actorId, 'unread-count']);
  });
});
