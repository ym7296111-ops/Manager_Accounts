import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NOTIFICATION_TEMPLATES_QUERY_KEY } from '@/hooks/useNotificationTemplates';
import { getSupabase } from '@/lib/supabase';

/**
 * Notification Templates Realtime invalidation signal (Phase 3.3).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §3.2 (policy matrix, `supabase_realtime` row): **only** `notification_templates` is published
 *   to `authenticated`; the secrets carrier tables stay off the wire entirely.
 * - §3.6.3 & §3.6.4: `channel: postgres_changes(notification_templates) → invalidate` — the event
 *   is used strictly as a **cache-invalidation signal** (signal, not content): the payload is never
 *   read, stored, or rendered.
 * - §0 (executive decision): **zero Realtime broadcasts from `notification_transport_secrets`**,
 *   and no subscription to `notification_transports` either — this hook deliberately registers a
 *   single `.on('postgres_changes', …)` filter and nothing else.
 *
 * Invalidating the `['notification-templates']` prefix refreshes every `(key, locale, status)`
 * query variant at once (see `useNotificationTemplates`), which is what keeps a second editor's
 * screen in sync with a publish made elsewhere.
 */

/** Stable channel name — one channel per screen instance; never shared with other tables. */
export const NOTIFICATION_TEMPLATES_REALTIME_CHANNEL = 'notification-templates-live';

/** Realtime socket health, mirroring the state vocabulary of the users / support screens. */
export type NotificationRealtimeState = 'connecting' | 'live' | 'offline';

export interface UseNotificationRealtimeOptions {
  /**
   * §3.6.4: never open a socket without a permission gate. Callers that already resolved
   * `notifications.manage` (or `*`) pass `true`; a read-only / unauthenticated caller passes
   * `false` and the hook becomes a no-op.
   */
  readonly enabled?: boolean;
}

export interface UseNotificationRealtimeResult {
  /** Socket status only — no template payload ever leaves this hook. */
  readonly state: NotificationRealtimeState;
}

function toRealtimeState(status: string): NotificationRealtimeState {
  if (status === 'SUBSCRIBED') {
    return 'live';
  }
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
    return 'offline';
  }
  return 'connecting';
}

export function useNotificationRealtime(
  options?: UseNotificationRealtimeOptions,
): UseNotificationRealtimeResult {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<NotificationRealtimeState>(() =>
    enabled ? 'connecting' : 'offline',
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const client = getSupabase();
    if (client === null) {
      return;
    }

    let disposed = false;
    const channel = client
      .channel(NOTIFICATION_TEMPLATES_REALTIME_CHANNEL)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notification_templates' },
        () => {
          // §3.6.4: invalidation signal only — the payload is intentionally ignored.
          void queryClient.invalidateQueries({ queryKey: NOTIFICATION_TEMPLATES_QUERY_KEY });
        },
      )
      .subscribe((status) => {
        if (disposed) {
          return;
        }
        setState(toRealtimeState(String(status)));
      });

    return () => {
      disposed = true;
      void client.removeChannel(channel);
    };
  }, [enabled, queryClient]);

  return { state: enabled ? state : 'offline' };
}
