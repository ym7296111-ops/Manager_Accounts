import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { useAuthCapabilities } from '@/hooks/useAuthCapabilities';
import { getSupabase } from '@/lib/supabase';

/**
 * Capability gate for `/settings/app/notifications` (Phase 3.3 composite screen).
 *
 * The screen is a composite: the template editor is fenced by
 * `notifications.manage` and the SMTP carrier by `settings.manage`. Since
 * Phase 2 the FIRST source is the server-resolved capability channel
 * (`useAuthCapabilities` → `get_my_capabilities()`): the UI never re-implements
 * the `*` / active-profile rules and never learns role names — it only reads
 * `capabilities.includes('*')` (every door) or the named slugs. Holding `*`
 * short-circuits the whole gate.
 *
 * When the capability channel is unavailable (loading, unconfigured, refused,
 * or malformed answer) the gate falls back to the two server-side helpers the
 * RPCs themselves use — `can_manage_notification_templates()` and
 * `can_manage_email_transport()` — resolved concurrently in one TanStack
 * Query entry. A caller holding either capability may open the screen, which
 * is the OR contract requested for this gate.
 *
 * The gate is a convenience only: it decides what to *render*. Every write and
 * read on the screen is still refused by RLS and by the RPCs themselves for a
 * caller without the capability (SQLSTATE `42501`).
 */

export interface NotificationAccessApi {
  /**
   * `null` while unresolved (auth in flight / capability query pending),
   * `false` once refused, `true` when the caller holds either capability.
   */
  readonly canManage: boolean | null;
  /** Template editor capability (`notifications.manage` or `*`). */
  readonly canManageTemplates: boolean;
  /** SMTP carrier capability (`settings.manage` or `*`). */
  readonly canManageTransport: boolean;
  readonly isAccessLoading: boolean;
  /** False when the Supabase env is missing: the gate can never pass. */
  readonly configured: boolean;
}

interface Capabilities {
  readonly canManageTemplates: boolean;
  readonly canManageTransport: boolean;
}

const DENIED: Capabilities = { canManageTemplates: false, canManageTransport: false };

export const NOTIFICATION_ACCESS_QUERY_KEY = 'notifications-can-manage';

export function useNotificationAccess(): NotificationAccessApi {
  const { session, configured, loading: authLoading } = useAuth();
  const capabilitiesChannel = useAuthCapabilities();

  /* Authoritative capability array: map slugs straight onto the two gates —
     the wildcard (or the named slug) opens exactly what the server would. */
  const viaCapabilities: Capabilities | null = capabilitiesChannel.isAuthoritative
    ? {
        canManageTemplates: capabilitiesChannel.hasCapability('notifications.manage'),
        canManageTransport: capabilitiesChannel.hasCapability('settings.manage'),
      }
    : null;

  const needsServerGate = viaCapabilities === null && !capabilitiesChannel.isLoading;

  const accessQuery = useQuery({
    queryKey: [NOTIFICATION_ACCESS_QUERY_KEY, session?.user.id],
    enabled: needsServerGate && Boolean(session?.user.id) && configured,
    retry: false,
    queryFn: async (): Promise<Capabilities> => {
      const client = getSupabase();
      if (client === null) {
        return DENIED;
      }

      // One round trip in parallel rather than two sequential capability calls.
      const [templates, transport] = await Promise.all([
        client.rpc('can_manage_notification_templates'),
        client.rpc('can_manage_email_transport'),
      ]);

      return {
        // A refusal (missing grant → 42501) is an answer, not a failure: deny.
        canManageTemplates: templates.error === null && templates.data === true,
        canManageTransport: transport.error === null && transport.data === true,
      };
    },
  });

  const capabilities = viaCapabilities ?? accessQuery.data ?? DENIED;

  const canManage: boolean | null = !configured
    ? false
    : authLoading ||
        capabilitiesChannel.isLoading ||
        (needsServerGate && Boolean(session?.user.id) && accessQuery.isLoading)
      ? null
      : capabilities.canManageTemplates || capabilities.canManageTransport;

  return {
    canManage,
    canManageTemplates: capabilities.canManageTemplates,
    canManageTransport: capabilities.canManageTransport,
    isAccessLoading:
      authLoading ||
      capabilitiesChannel.isLoading ||
      (needsServerGate && Boolean(session?.user.id) && accessQuery.isLoading),
    configured,
  };
}
