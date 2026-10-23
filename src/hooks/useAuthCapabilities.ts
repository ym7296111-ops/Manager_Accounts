import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PostgrestError } from '@supabase/supabase-js';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useAuth } from '@/context/AuthContext';
import { getSupabase } from '@/lib/supabase';

/**
 * Server-resolved capability channel (Phase 2 — super-admin isolation).
 *
 * The UI must never know *which* role a user holds — it only sees capability
 * slugs (`capabilities.includes('*')` opens every door). The source of truth
 * is the SECURITY DEFINER RPC `get_my_capabilities()`, which returns the
 * caller's effective permission slugs and NEVER a role name:
 *
 *   - break-glass holder  → `["*"]`
 *   - any other user      → their real permission slugs
 *   - anonymous/inactive  → `[]`
 *
 * The resolved array is stored in a context (`AuthCapabilitiesProvider`) and
 * consumed through `useAuthCapabilities()`, which also works without a
 * provider (it falls back to the same shared query), so screens and tests can
 * adopt the hook incrementally.
 *
 * Fail-soft contract: any refusal, missing env, or malformed answer resolves
 * to an empty, NON-authoritative capability set. Consumers decide what to do
 * while the answer is unknown (`isAuthoritative === false`); the database
 * remains the security boundary in every case.
 */

/** The wildcard capability: holding it grants every other capability. */
export const WILDCARD_CAPABILITY = '*';

/**
 * Capability that unlocks the executive dashboard read model.
 *
 * `dashboard:read` is the seeded permission of the `executive` role
 * (20261020000000_add_executive_dashboard_role.sql) and the only capability
 * that role holds. The dotted alias `dashboard.read` is accepted here because
 * earlier design notes and the RPC contract used it interchangeably; keeping
 * both spellings in the dashboard family means an alias migration can never
 * flip an executive account into the full shell.
 */
export const DASHBOARD_READ_CAPABILITY = 'dashboard:read';

/**
 * The whole dashboard capability family.
 *
 * `dashboard.view` is the legacy seeded slug that is not checked by any gate
 * today, but it is still part of this surface: adding it to an executive
 * account must not restore the sidebar.
 */
export const DASHBOARD_SURFACE_CAPABILITIES: readonly string[] = [
  DASHBOARD_READ_CAPABILITY,
  'dashboard.read',
  'dashboard.view',
] as const;

/**
 * True when `capabilities` contains `dashboard:read` (or its dotted alias) and
 * NOTHING outside the dashboard family.
 *
 * This replaces the previous `capabilities.length === 1` heuristic, which made
 * the executive shell depend on an exact array length: granting any additional
 * dashboard-scoped slug (or a harmless alias) immediately restored the sidebar
 * and the settings routes. The rule below states the intent directly — "this
 * actor can reach the dashboard and no other surface" — so the family can grow
 * without reopening the trap, while `*` and every operational capability
 * (`users.manage`, `settings.manage`, …) still correctly fall outside it.
 */
export function isDashboardOnlyCapabilitySet(capabilities: readonly string[]): boolean {
  return (
    (capabilities.includes(DASHBOARD_READ_CAPABILITY) || capabilities.includes('dashboard.read')) &&
    capabilities.every((slug) => DASHBOARD_SURFACE_CAPABILITIES.includes(slug))
  );
}

/** The subset of the capability channel the shell gate reads. */
export interface DashboardOnlyInput {
  readonly capabilities: readonly string[];
  readonly isAuthoritative: boolean;
}

/**
 * Fail-soft shell gate: while the capability channel is unresolved
 * (`isAuthoritative === false`) the actor is never treated as dashboard-only,
 * exactly as before. Only an authoritative dashboard-only answer collapses the
 * shell.
 */
export function isDashboardOnlyActor(channel: DashboardOnlyInput): boolean {
  return channel.isAuthoritative && isDashboardOnlyCapabilitySet(channel.capabilities);
}

/** Shared TanStack Query key (actor-scoped — see the query below). */
export const AUTH_CAPABILITIES_QUERY_KEY = 'auth-capabilities';

export interface AuthCapabilitiesApi {
  /** Effective capability slugs. Never contains role names. */
  readonly capabilities: readonly string[];
  /** True while the initial capability lookup is in flight. */
  readonly isLoading: boolean;
  /**
   * True only when the server answered with a real capability array. While
   * false (loading, unconfigured, refused, malformed) consumers must treat the
   * capability set as unknown rather than empty.
   */
  readonly isAuthoritative: boolean;
  /** False when the Supabase env is missing: capabilities can never resolve. */
  readonly configured: boolean;
  /** True when the caller holds `capability` (the wildcard holds everything). */
  hasCapability(capability: string): boolean;
  /** Force a fresh server lookup after capability administration. */
  refetch(): Promise<void>;
}

/**
 * A capability requirement: one slug, or several slugs where ANY of them
 * satisfies the requirement (OR semantics — mirrors the server gates such as
 * `can_manage_notification_templates()` vs `can_manage_email_transport()`).
 */
export type CapabilityRequirement = string | readonly string[];

/**
 * Pure OR-check over a `hasCapability` predicate. The wildcard is already
 * handled inside `hasCapability`, so `'*'` satisfies every requirement.
 */
export function requirementMet(
  requirement: CapabilityRequirement,
  hasCapability: (capability: string) => boolean,
): boolean {
  const slugs = typeof requirement === 'string' ? [requirement] : requirement;
  return slugs.some((slug) => hasCapability(slug));
}

const EMPTY_CAPABILITIES: readonly string[] = [];

/** Parse the RPC payload: a JSON array of strings is the only valid shape. */
function parseCapabilities(data: unknown): readonly string[] | null {
  if (!Array.isArray(data)) {
    return null;
  }
  const slugs: string[] = [];
  for (const entry of data) {
    if (typeof entry === 'string' && entry !== '' && !slugs.includes(entry)) {
      slugs.push(entry);
    }
  }
  slugs.sort();
  return slugs;
}

function useCapabilitiesQuery(): AuthCapabilitiesApi {
  const { session, approvalStatus, configured, loading: authLoading } = useAuth();

  const query = useQuery({
    queryKey: [AUTH_CAPABILITIES_QUERY_KEY, session?.user.id ?? null],
    /* Strictly gated: without a session OR without Supabase env the channel
       can never resolve, so the query must stay parked (a bare `undefined`
       would read as "enabled" to TanStack Query). */
    enabled: Boolean(
      session?.user.id &&
      configured &&
      approvalStatus !== 'pending' &&
      approvalStatus !== 'rejected',
    ),
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<readonly string[] | null> => {
      if (approvalStatus === 'pending' || approvalStatus === 'rejected') return EMPTY_CAPABILITIES;
      const client = getSupabase();
      if (client === null) {
        return null;
      }
      const response: { data: unknown; error: PostgrestError | null } =
        await client.rpc('get_my_capabilities');
      if (response.error !== null) {
        /* A refusal is an answer, not a failure: degrade to non-authoritative. */
        return null;
      }
      return parseCapabilities(response.data);
    },
  });

  const capabilities =
    approvalStatus === 'pending' || approvalStatus === 'rejected'
      ? EMPTY_CAPABILITIES
      : (query.data ?? EMPTY_CAPABILITIES);
  const isAuthoritative = query.data !== null && query.data !== undefined;
  const refetchQuery = query.refetch;
  const refetch = useCallback(async () => {
    await refetchQuery();
  }, [refetchQuery]);

  return useMemo<AuthCapabilitiesApi>(() => {
    const hasCapability = (capability: string): boolean =>
      capabilities.includes(WILDCARD_CAPABILITY) || capabilities.includes(capability);
    return {
      capabilities,
      isLoading: authLoading || query.isLoading,
      isAuthoritative,
      configured,
      hasCapability,
      refetch,
    };
  }, [capabilities, authLoading, query.isLoading, isAuthoritative, configured, refetch]);
}

const AuthCapabilitiesContext = createContext<AuthCapabilitiesApi | null>(null);
AuthCapabilitiesContext.displayName = 'AuthCapabilitiesContext';

export interface AuthCapabilitiesProviderProps {
  children: ReactNode;
}

/**
 * Stores the resolved capability set in context for the whole app shell.
 * Mount inside `AuthProvider` (it reads the session) and `QueryClientProvider`.
 */
export function AuthCapabilitiesProvider({ children }: AuthCapabilitiesProviderProps) {
  const api = useCapabilitiesQuery();
  const { session, approvalStatus, configured } = useAuth();
  const queryClient = useQueryClient();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (
      userId === null ||
      !configured ||
      approvalStatus === 'pending' ||
      approvalStatus === 'rejected'
    ) {
      return;
    }
    const client = getSupabase();
    if (client === null) return;
    const channel = client
      .channel(`auth-capabilities:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_capabilities',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({
            queryKey: [AUTH_CAPABILITIES_QUERY_KEY, userId],
          });
        },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [userId, configured, approvalStatus, queryClient]);

  return createElement(AuthCapabilitiesContext.Provider, { value: api }, children);
}

/**
 * Access the caller's capabilities. Prefers the shared context value and falls
 * back to the same shared query when no provider is mounted, so individual
 * screens can adopt the channel without rewiring the whole tree.
 */
export function useAuthCapabilities(): AuthCapabilitiesApi {
  const context = useContext(AuthCapabilitiesContext);
  const fallback = useCapabilitiesQuery();
  return context ?? fallback;
}
