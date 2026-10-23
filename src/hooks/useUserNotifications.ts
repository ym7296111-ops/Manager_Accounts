import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useUserNotificationsRealtime } from '@/hooks/useUserNotificationsRealtime';
import { getSupabase } from '@/lib/supabase';

/**
 * In-app notification feed (bell + dropdown).
 *
 * Scope: in-product only. There is no email, no push and no external transport
 * anywhere in this hook — it reads `public.user_notifications` over PostgREST
 * under RLS and mutates it through two SECURITY DEFINER RPCs.
 *
 * Two separate queries on purpose:
 *
 *   - the UNREAD COUNT is what the bell badge renders. It must stay cheap and
 *     must keep updating even when the dropdown was never opened, so it uses a
 *     `head: true` count that transfers no rows.
 *   - the LIST is only needed once the dropdown opens.
 *
 * Both queries share the ACTIVE-FEED predicate `is_read = false AND
 * resolved_at IS NULL`. A row that was read, or resolved upstream (an owner
 * approved the account, a reset request was finalized, …), belongs to the
 * history — never to the panel and never to the badge. The filter is applied
 * server-side, so a resolved row cannot flash in the UI before local
 * filtering would have hidden it.
 *
 * Every query key is scoped by the signed-in user's id
 * (`['user-notifications', userId, …]`), so one account's cached rows can
 * never be served to the next account on the same browser. `AuthContext`
 * additionally drops the whole key family on sign-out.
 *
 * Liveness follows the house pattern (see `useUsersManagement`): Realtime is an
 * invalidation SIGNAL, never a content channel — the payload is ignored and the
 * authoritative rows are refetched. Whenever the socket is not live (still
 * connecting, or offline) the hook falls back to interval polling so the badge
 * still converges.
 *
 * The feed is deliberately NOT capability-gated. A pending or rejected account
 * has an empty capability set, yet it is exactly the account that must see
 * "your request was approved". Ownership (RLS) is the only gate.
 */

/**
 * Root of every feed query key. Used for prefix invalidation and for dropping
 * the whole family from the cache (see the sign-out cleanup in `AuthContext`,
 * which passes this exact prefix to `removeQueries`).
 */
export const USER_NOTIFICATIONS_QUERY_KEY_ROOT = ['user-notifications'] as const;

/**
 * Feed list key, scoped to one signed-in user. The active feed (the default)
 * nests directly under the user; the full history gets a `'history'` suffix so
 * the two lists can never collide in the cache. A signed-out caller keeps a
 * stable `'signed-out'` segment — both queries are disabled in that state, so
 * the key never actually fetches.
 */
export function userNotificationsQueryKey(userId: string | null, onlyActive = true) {
  const scope = userId ?? 'signed-out';
  return onlyActive
    ? ([...USER_NOTIFICATIONS_QUERY_KEY_ROOT, scope] as const)
    : ([...USER_NOTIFICATIONS_QUERY_KEY_ROOT, scope, 'history'] as const);
}

/** Unread (active) count key, scoped to one signed-in user. */
export function userNotificationsUnreadKey(userId: string | null) {
  return [...USER_NOTIFICATIONS_QUERY_KEY_ROOT, userId ?? 'signed-out', 'unread-count'] as const;
}

/** Closed allowlist mirrored by the `user_notifications_type_check` constraint. */
export type UserNotificationType =
  | 'user_approval_requested'
  | 'password_reset_requested'
  | 'user_approved'
  | 'user_rejected'
  | 'delegation_event';

export interface UserNotificationRow {
  readonly id: string;
  readonly type: UserNotificationType;
  /** i18n key, never rendered prose (for example `notifications.type.user_approved.title`). */
  readonly title_key: string;
  readonly body_key: string;
  /** Interpolation values only; identifiers arrive already masked by SQL. */
  readonly params: Readonly<Record<string, string>>;
  /** Structured event payload (for example `delegation_event`: `event`, `slug`, `days`, …). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Relative in-app route enforced by a CHECK constraint. */
  readonly link: string | null;
  readonly is_read: boolean;
  readonly read_at: string | null;
  readonly related_id: string | null;
  readonly resolved_at: string | null;
  readonly created_at: string;
}

export interface UseUserNotificationsOptions {
  /**
   * Active feed only (default `true`): the LIST query is restricted to
   * `is_read = false AND resolved_at IS NULL` — the exact predicate the badge
   * counts — so read or resolved rows never render. Pass `false` for the
   * unbounded history view. The unread count always uses the active
   * predicate, regardless of this option.
   */
  readonly onlyActive?: boolean;
}

export interface UserNotificationsApi {
  /** Rows for the dropdown, newest first. Active rows unless opted out. */
  readonly notifications: readonly UserNotificationRow[];
  /** Unread + unresolved count for the badge; `null` while unresolved. */
  readonly unreadCount: number | null;
  readonly isLoading: boolean;
  readonly isError: boolean;
  /** `connecting` | `live` | `offline` — drives the polling fallback. */
  readonly realtimeState: 'connecting' | 'live' | 'offline';
  /** Marks one notification read; resolves false when the server refused it. */
  readonly markRead: (id: string) => Promise<boolean>;
  /** Marks the whole feed read; resolves with how many rows changed. */
  readonly markAllRead: () => Promise<number>;
  readonly isMarking: boolean;
  readonly refetch: () => void;
}

/** The dropdown shows a bounded window; older rows stay in the database. */
const FEED_LIMIT = 20;

/**
 * Typed failure for the mark-read RPCs, following the house pattern
 * (`AppIdentityError`, `PasswordResetError`): the UI never inspects a raw
 * PostgREST shape and the linter never sees a non-Error throw.
 */
export class UserNotificationsError extends Error {
  override readonly name = 'UserNotificationsError';
  readonly rpc: 'mark_notification_read' | 'mark_all_notifications_read';

  constructor(rpc: 'mark_notification_read' | 'mark_all_notifications_read', message: string) {
    super(message);
    this.rpc = rpc;
  }
}

function toRpcError(
  rpc: 'mark_notification_read' | 'mark_all_notifications_read',
  error: unknown,
): UserNotificationsError {
  const message = error instanceof Error ? error.message : `${rpc}: the server refused the request`;
  return new UserNotificationsError(rpc, message);
}

const EMPTY_FEED: readonly UserNotificationRow[] = [];

/** Poll whenever the live feed is not up; a live socket makes it redundant. */
const FALLBACK_POLL_MS = 30_000;

const ROW_COLUMNS =
  'id, type, title_key, body_key, params, metadata, link, is_read, read_at, related_id, resolved_at, created_at';

function isRow(value: unknown): value is UserNotificationRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && typeof candidate.title_key === 'string';
}

export function useUserNotifications(
  options: UseUserNotificationsOptions = {},
): UserNotificationsApi {
  const queryClient = useQueryClient();
  const { session, configured } = useAuth();
  const userId = session?.user.id ?? null;
  const accessToken = session?.access_token ?? null;
  /* Without a signed-in user both queries stay disabled — no session, no fetch. */
  const enabled =
    configured && userId !== null && accessToken !== null && accessToken.trim() !== '';
  const onlyActive = options.onlyActive ?? true;

  /* Scoped keys, memoized so `invalidate` (and the dropdown's `refetch`
     effect keyed on it) keeps a stable identity across renders. */
  const listKey = useMemo(
    () => userNotificationsQueryKey(userId, onlyActive),
    [onlyActive, userId],
  );
  const unreadKey = useMemo(() => userNotificationsUnreadKey(userId), [userId]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: listKey });
    void queryClient.invalidateQueries({ queryKey: unreadKey });
  }, [listKey, queryClient, unreadKey]);

  /* Realtime subscription lives here so the badge converges even when the
     dropdown was never opened. It is a pure invalidation signal. */
  const { state: realtimeState } = useUserNotificationsRealtime({
    userId,
    accessToken,
    onSignal: invalidate,
  });

  /* Poll until the socket is actually live: a slow `connecting` phase must not
     freeze the badge any more than a dead socket does. */
  const refetchInterval = realtimeState === 'live' ? false : FALLBACK_POLL_MS;

  const unreadQuery = useQuery({
    queryKey: unreadKey,
    enabled,
    refetchInterval,
    refetchOnWindowFocus: true,
    /* Non-zero staleTime keeps the badge from flickering on every render. */
    staleTime: 15_000,
    queryFn: async (): Promise<number> => {
      const client = getSupabase();
      if (client === null) {
        return 0;
      }
      /* Active-feed predicate: unread AND unresolved. A resolved row is
         already answered elsewhere, so it must not inflate the badge. */
      const { count, error } = await client
        .from('user_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('is_read', false)
        .is('resolved_at', null);
      if (error !== null) {
        throw error;
      }
      return count ?? 0;
    },
  });

  const listQuery = useQuery({
    queryKey: listKey,
    enabled,
    refetchInterval,
    refetchOnWindowFocus: true,
    /* Opening the panel and returning to the tab should always see the latest
       feed; cache reuse still deduplicates overlapping requests. */
    staleTime: 0,
    queryFn: async (): Promise<readonly UserNotificationRow[]> => {
      const client = getSupabase();
      if (client === null) {
        return EMPTY_FEED;
      }
      let request = client.from('user_notifications').select(ROW_COLUMNS);
      if (onlyActive) {
        /* Same active-feed predicate as the badge; applied server-side so
           read/resolved rows never cross the wire toward the panel. */
        request = request.eq('is_read', false).is('resolved_at', null);
      }
      const { data, error } = await request
        .order('created_at', { ascending: false })
        .limit(FEED_LIMIT);
      if (error !== null) {
        throw error;
      }
      return Array.isArray(data) ? data.filter(isRow) : EMPTY_FEED;
    },
  });

  const markReadMutation = useMutation({
    mutationFn: async (id: string): Promise<boolean> => {
      const client = getSupabase();
      if (client === null) {
        return false;
      }
      /* Ownership is enforced server-side in the WHERE clause, so another
         user's id resolves to a silent `false` rather than an error. */
      const response: { data?: unknown; error: unknown } = await client.rpc(
        'mark_notification_read',
        { p_notification_id: id },
      );
      if (response.error !== null && response.error !== undefined) {
        throw toRpcError('mark_notification_read', response.error);
      }
      return response.data === true;
    },
    /* Optimistic: update the row immediately, then let the server confirm. */
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<readonly UserNotificationRow[]>(listKey);
      if (previous !== undefined) {
        /* The active feed holds unread rows only, so marking one read removes
           it; the history view keeps the row and flips it in place. */
        queryClient.setQueryData<readonly UserNotificationRow[]>(
          listKey,
          onlyActive
            ? previous.filter((row) => row.id !== id)
            : previous.map((row) =>
                row.id === id && !row.is_read
                  ? { ...row, is_read: true, read_at: new Date().toISOString() }
                  : row,
              ),
        );
      }
      const previousCount = queryClient.getQueryData<number>(unreadKey);
      if (typeof previousCount === 'number' && previousCount > 0) {
        queryClient.setQueryData<number>(unreadKey, previousCount - 1);
      }
      return { previous, previousCount };
    },
    onError: (_error, _id, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
      if (context?.previousCount !== undefined) {
        queryClient.setQueryData(unreadKey, context.previousCount);
      }
    },
    onSettled: () => {
      invalidate();
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async (): Promise<number> => {
      const client = getSupabase();
      if (client === null) {
        return 0;
      }
      const response: { data?: unknown; error: unknown } = await client.rpc(
        'mark_all_notifications_read',
      );
      if (response.error !== null && response.error !== undefined) {
        throw toRpcError('mark_all_notifications_read', response.error);
      }
      return typeof response.data === 'number' ? response.data : 0;
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<readonly UserNotificationRow[]>(listKey);
      if (previous !== undefined) {
        /* Active feed: every row leaves at once. History: flip in place. */
        const stamp = new Date().toISOString();
        queryClient.setQueryData<readonly UserNotificationRow[]>(
          listKey,
          onlyActive
            ? EMPTY_FEED
            : previous.map((row) =>
                row.is_read ? row : { ...row, is_read: true, read_at: stamp },
              ),
        );
      }
      const previousCount = queryClient.getQueryData<number>(unreadKey);
      if (previousCount !== undefined) {
        queryClient.setQueryData<number>(unreadKey, 0);
      }
      return { previous, previousCount };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
      if (context?.previousCount !== undefined) {
        queryClient.setQueryData(unreadKey, context.previousCount);
      }
    },
    onSettled: () => {
      invalidate();
    },
  });

  const markRead = useCallback(
    (id: string) => markReadMutation.mutateAsync(id),
    [markReadMutation],
  );
  const markAllRead = useCallback(() => markAllReadMutation.mutateAsync(), [markAllReadMutation]);

  return {
    notifications: listQuery.data ?? EMPTY_FEED,
    unreadCount: enabled ? (unreadQuery.data ?? null) : 0,
    isLoading: enabled && (unreadQuery.isLoading || listQuery.isLoading),
    isError: unreadQuery.isError || listQuery.isError,
    realtimeState,
    markRead,
    markAllRead,
    isMarking: markReadMutation.isPending || markAllReadMutation.isPending,
    refetch: invalidate,
  };
}
