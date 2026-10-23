import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { getSupabase } from '@/lib/supabase';

const MS_PER_DAY = 86_400_000;

export const MY_CAPABILITIES_QUERY_KEY_ROOT = ['my-capabilities'] as const;
export const MY_ROLES_QUERY_KEY_ROOT = ['my-roles'] as const;

export interface MyDelegatedCapability {
  readonly id: string;
  readonly slug: string;
  readonly granted_by: string | null;
  readonly granted_by_email: string | null;
  readonly granted_at: string;
  readonly expires_at: string | null;
}

export interface MyRole {
  readonly slug: string;
  readonly name_ar: string;
  readonly name_en: string;
}

export interface MyCapabilitiesApi {
  readonly capabilities: readonly MyDelegatedCapability[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly refetch: () => Promise<void>;
}

export interface MyRolesApi {
  readonly roles: readonly MyRole[];
  readonly isLoading: boolean;
  readonly refetch: () => Promise<void>;
}

const EMPTY_DELEGATIONS: readonly MyDelegatedCapability[] = [];
const EMPTY_ROLES: readonly MyRole[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns `true` when `expiresAt` is a valid future timestamp within the 7-day
 * expiry warning window (`0 < remaining <= 7 days`).
 */
export function isDelegationExpiringSoon(expiresAt: string | null, nowMs = Date.now()): boolean {
  if (expiresAt === null || expiresAt.trim() === '') {
    return false;
  }
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  const remaining = timestamp - nowMs;
  return remaining > 0 && remaining <= 7 * MS_PER_DAY;
}

export function parseMyDelegatedCapabilities(
  data: unknown,
  nowMs = Date.now(),
): readonly MyDelegatedCapability[] {
  if (!Array.isArray(data)) {
    return EMPTY_DELEGATIONS;
  }

  const items: readonly unknown[] = data;
  const parsed: MyDelegatedCapability[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index];
    if (!isRecord(entry)) continue;

    const rawSlug = entry['slug'] ?? entry['permission_slug'];
    if (typeof rawSlug !== 'string' || rawSlug.trim() === '') continue;

    const rawExpiresAt = typeof entry['expires_at'] === 'string' ? entry['expires_at'] : null;
    if (rawExpiresAt !== null) {
      const expiryMs = Date.parse(rawExpiresAt);
      if (Number.isNaN(expiryMs) || expiryMs <= nowMs) {
        continue;
      }
    }

    const id =
      typeof entry['id'] === 'string' && entry['id'] !== '' ? entry['id'] : `${rawSlug}:${index}`;
    const grantedBy = typeof entry['granted_by'] === 'string' ? entry['granted_by'] : null;
    const grantedByEmail =
      typeof entry['granted_by_email'] === 'string' && entry['granted_by_email'] !== ''
        ? entry['granted_by_email']
        : null;
    const grantedAt = typeof entry['granted_at'] === 'string' ? entry['granted_at'] : '';

    parsed.push({
      id,
      slug: rawSlug,
      granted_by: grantedBy,
      granted_by_email: grantedByEmail,
      granted_at: grantedAt,
      expires_at: rawExpiresAt,
    });
  }

  return parsed;
}

export function parseMyRoles(data: unknown): readonly MyRole[] {
  if (!Array.isArray(data)) {
    return EMPTY_ROLES;
  }

  const seen = new Set<string>();
  const roles: MyRole[] = [];
  for (const item of data) {
    if (typeof item === 'string' && item.trim() !== '') {
      const slug = item.trim();
      if (!seen.has(slug)) {
        seen.add(slug);
        roles.push({ slug, name_ar: slug, name_en: slug });
      }
      continue;
    }
    if (!isRecord(item)) continue;
    const nested = isRecord(item['roles']) ? item['roles'] : item;
    const rawSlug = nested['slug'];
    if (typeof rawSlug !== 'string' || rawSlug.trim() === '') continue;
    const slug = rawSlug.trim();
    if (seen.has(slug)) continue;
    seen.add(slug);
    roles.push({
      slug,
      name_ar: typeof nested['name_ar'] === 'string' ? nested['name_ar'] : slug,
      name_en: typeof nested['name_en'] === 'string' ? nested['name_en'] : slug,
    });
  }
  return roles;
}

/**
 * Self-service read hook for the signed-in user's active delegated capabilities
 * (`get_my_delegated_capabilities` RPC + Realtime invalidation on `user_capabilities`).
 */
export function useMyCapabilities(): MyCapabilitiesApi {
  const { session, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const userId = session?.user.id ?? null;

  const queryKey = useMemo(
    () => [...MY_CAPABILITIES_QUERY_KEY_ROOT, userId ?? 'signed-out'] as const,
    [userId],
  );

  const query = useQuery({
    queryKey,
    enabled: userId !== null,
    staleTime: 10_000,
    retry: false,
    queryFn: async (): Promise<readonly MyDelegatedCapability[]> => {
      const client = getSupabase();
      if (client === null || typeof client.rpc !== 'function') {
        return EMPTY_DELEGATIONS;
      }
      const response: { data?: unknown; error?: unknown } = await client.rpc(
        'get_my_delegated_capabilities',
      );
      if (response.error !== null && response.error !== undefined) {
        throw response.error instanceof Error
          ? response.error
          : new Error('get_my_delegated_capabilities failed');
      }
      return parseMyDelegatedCapabilities(response.data);
    },
  });

  useEffect(() => {
    if (userId === null) return;
    const client = getSupabase();
    if (client === null || typeof client.channel !== 'function') return;

    const channel = client
      .channel(`my-delegated-capabilities:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_capabilities',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey });
        },
      )
      .subscribe();

    return () => {
      if (typeof client.removeChannel === 'function') {
        void client.removeChannel(channel);
      }
    };
  }, [queryClient, queryKey, userId]);

  const refetchQuery = query.refetch;
  const refetch = useCallback(async () => {
    await refetchQuery();
  }, [refetchQuery]);

  return {
    capabilities: query.data ?? EMPTY_DELEGATIONS,
    isLoading: authLoading || (userId !== null && query.isLoading),
    isError: query.isError,
    refetch,
  };
}

/**
 * Self-service read hook for the signed-in user's assigned roles (`get_my_roles` RPC).
 */
export function useMyRoles(): MyRolesApi {
  const { session, loading: authLoading } = useAuth();
  const userId = session?.user.id ?? null;

  const queryKey = useMemo(
    () => [...MY_ROLES_QUERY_KEY_ROOT, userId ?? 'signed-out'] as const,
    [userId],
  );

  const query = useQuery({
    queryKey,
    enabled: userId !== null,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<readonly MyRole[]> => {
      const client = getSupabase();
      if (client === null || typeof client.rpc !== 'function') {
        return EMPTY_ROLES;
      }
      const response: { data?: unknown; error?: unknown } = await client.rpc('get_my_roles');
      if (response.error !== null && response.error !== undefined) {
        return EMPTY_ROLES;
      }
      return parseMyRoles(response.data);
    },
  });

  const refetchQuery = query.refetch;
  const refetch = useCallback(async () => {
    await refetchQuery();
  }, [refetchQuery]);

  return {
    roles: query.data ?? EMPTY_ROLES,
    isLoading: authLoading || (userId !== null && query.isLoading),
    refetch,
  };
}
