import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';

/**
 * In-app notification Realtime subscription.
 *
 * Named `useUserNotificationsRealtime` on purpose: `useNotificationRealtime`
 * already exists and belongs to the SMTP template editor. These are unrelated
 * subsystems and must never share a channel name.
 *
 * Contract (identical to `useUsersManagement` / `useNotificationRealtime`):
 *
 *   - `postgres_changes` is an INVALIDATION SIGNAL, not a content channel. The
 *     payload is never read, stored or rendered; the caller refetches the
 *     authoritative rows over PostgREST under RLS.
 *   - The table runs REPLICA IDENTITY FULL (migration
 *     `20261028000000_user_notifications_replica_identity_full`) — not so the
 *     client may read old values (it never does), but so Realtime can match
 *     the `user_id` filter and the owner RLS policy for DELETEs: under the
 *     default identity a DELETE's old record carries only the primary key
 *     and the event is silently skipped.
 *   - The subscription is filtered to `user_id=eq.<uid>` so a notification for
 *     somebody else never wakes this client.
 *   - Events are coalesced before the signal fires, so a burst collapses into
 *     a single refetch.
 *   - When the socket or its auth setup fails, `state` becomes `offline` and
 *     the caller switches to interval polling.
 *
 * Realtime-js reuses a channel object by topic. Every effect instance therefore
 * gets a unique topic. The app mounts exactly one instance of this hook
 * (`NotificationsProvider` in `Topbar` owns the feed for both the bell and its
 * dropdown); unique topics remain as defense in depth, so an accidental second
 * mount degrades to a redundant socket instead of the production collision,
 * and a remount never registers handlers on an already-joined channel.
 */

/** Prefix only; each subscription receives a unique channel name. */
export const USER_NOTIFICATIONS_REALTIME_CHANNEL = 'user-notifications-live';

/** Burst coalescing window, mirroring `REALTIME_COALESCE_MS` in useUsersManagement. */
const REALTIME_COALESCE_MS = 250;

let channelSequence = 0;

function uniqueChannelName(): string {
  channelSequence += 1;
  const nonce = globalThis.crypto?.randomUUID?.() ?? 'local';
  return `${USER_NOTIFICATIONS_REALTIME_CHANNEL}-${channelSequence}-${nonce}`;
}

export type UserNotificationsRealtimeState = 'connecting' | 'live' | 'offline';

export interface UseUserNotificationsRealtimeOptions {
  /** Signed-in user id; the hook is a no-op when null. */
  readonly userId: string | null;
  /** Access token from the verified Auth session; no socket is opened without it. */
  readonly accessToken: string | null;
  /** Called (coalesced) on every change to the caller's own rows. */
  readonly onSignal?: () => void;
}

export interface UseUserNotificationsRealtimeResult {
  /** Socket status only — no notification payload ever leaves this hook. */
  readonly state: UserNotificationsRealtimeState;
}

function toRealtimeState(status: string): UserNotificationsRealtimeState {
  if (status === 'SUBSCRIBED') {
    return 'live';
  }
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
    return 'offline';
  }
  return 'connecting';
}

export function useUserNotificationsRealtime(
  options: UseUserNotificationsRealtimeOptions,
): UseUserNotificationsRealtimeResult {
  const { userId, accessToken, onSignal } = options;
  const enabled = userId !== null && accessToken !== null && accessToken.trim() !== '';

  /* Derive the disabled state at return time so a signed-out render never
     flashes `connecting` while React runs the effect cleanup. */
  const [state, setState] = useState<UserNotificationsRealtimeState>(() =>
    enabled ? 'connecting' : 'offline',
  );

  /* Keep the latest callback without re-subscribing on every render. Written
     from an effect — never during render. */
  const signalRef = useRef(onSignal);
  useEffect(() => {
    signalRef.current = onSignal;
  }, [onSignal]);

  const signalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);

  const scheduleSignal = useCallback(() => {
    if (signalTimerRef.current !== null) {
      return;
    }
    const generation = generationRef.current;
    signalTimerRef.current = setTimeout(() => {
      signalTimerRef.current = null;
      if (generation === generationRef.current) {
        signalRef.current?.();
      }
    }, REALTIME_COALESCE_MS);
  }, []);

  useEffect(() => {
    if (!enabled || userId === null || accessToken === null) {
      return;
    }

    const client = getSupabase();
    if (client === null) {
      return;
    }

    const generation = ++generationRef.current;
    let active = true;
    let channel: RealtimeChannel | null = null;
    const isCurrent = () => active && generationRef.current === generation;

    const connect = async () => {
      try {
        /* AuthContext publishes only a verified session. Still set Realtime's
           token explicitly and await it before opening the channel, so the
           subscribe handshake cannot race session hydration/token refresh. */
        await client.realtime.setAuth(accessToken);
        if (!isCurrent()) {
          return;
        }
        setState('connecting');

        /* Contractual order: channel → on → subscribe. */
        channel = client.channel(uniqueChannelName());
        channel
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'user_notifications',
              filter: `user_id=eq.${userId}`,
            },
            () => {
              if (isCurrent()) {
                scheduleSignal();
              }
            },
          )
          .subscribe((status, error) => {
            if (!isCurrent()) {
              return;
            }
            const nextState = toRealtimeState(String(status));
            setState(nextState);
            if (nextState === 'offline' && error) {
              console.error(
                '[useUserNotificationsRealtime] Realtime channel entered offline state',
                error,
              );
            }
          });
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        /* A 401 during setAuth/subscribe is a recoverable connectivity state:
           the feed switches to polling rather than remaining `connecting`. */
        setState('offline');
        console.error(
          '[useUserNotificationsRealtime] subscription failed; continuing without realtime',
          error,
        );
        if (channel !== null) {
          void client.removeChannel(channel);
          channel = null;
        }
      }
    };

    void connect();

    return () => {
      active = false;
      if (generationRef.current === generation) {
        generationRef.current += 1;
      }
      if (signalTimerRef.current !== null) {
        clearTimeout(signalTimerRef.current);
        signalTimerRef.current = null;
      }
      if (channel !== null) {
        void client.removeChannel(channel);
        channel = null;
      }
    };
  }, [accessToken, enabled, scheduleSignal, userId]);

  return { state: enabled ? state : 'offline' };
}
