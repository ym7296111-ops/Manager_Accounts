import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { DELEGATED_USERS_QUERY_KEY } from '@/hooks/useDelegatedUsers';
import { getSupabase } from '@/lib/supabase';

export interface UserCapabilityGrant {
  readonly id: string;
  /** Any catalogue slug the owner currently flags `is_delegatable`. */
  readonly permissionSlug: string;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
}

export type UserCapabilityErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'duplicate'
  | 'not-found'
  | 'not-delegatable'
  | 'invalid-expiry'
  | 'network'
  | 'unknown';

export class UserCapabilityError extends Error {
  readonly code: UserCapabilityErrorCode;

  constructor(code: UserCapabilityErrorCode) {
    super(code);
    this.name = 'UserCapabilityError';
    this.code = code;
  }
}

const QUERY_PREFIX = ['user-capabilities'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGrant(value: unknown): UserCapabilityGrant | null {
  if (!isRecord(value)) return null;
  const permission = value['permission_slug'];
  /* Any catalogue slug can be delegatable now: the owner controls the set
     (permissions.is_delegatable), so the client validates shape only. */
  if (typeof permission !== 'string' || permission === '') return null;
  if (typeof value['id'] !== 'string' || typeof value['granted_at'] !== 'string') return null;
  return {
    id: value['id'],
    permissionSlug: permission,
    grantedAt: value['granted_at'],
    expiresAt: typeof value['expires_at'] === 'string' ? value['expires_at'] : null,
  };
}

async function readFailure(error: unknown): Promise<UserCapabilityErrorCode> {
  if (error instanceof TypeError) return 'network';
  if (!isRecord(error)) return 'unknown';
  const context = error['context'];
  if (!isRecord(context) || typeof context['json'] !== 'function') return 'unknown';
  try {
    const body: unknown = await (context['json'] as () => Promise<unknown>).call(context);
    const code = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : '';
    if (code === 'permission_denied') return 'forbidden';
    if (code === 'capability_not_delegatable') return 'not-delegatable';
    if (code === 'capability_already_granted') return 'duplicate';
    if (code === 'not_found') return 'not-found';
    if (code === 'invalid_action') return 'invalid-expiry';
    if (code === 'unavailable') return 'unavailable';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function invoke(body: Record<string, unknown>): Promise<unknown> {
  const client = getSupabase();
  if (client === null) throw new UserCapabilityError('unavailable');
  try {
    const response: { data?: unknown; error: unknown } = await client.functions.invoke(
      'admin-user-capabilities',
      { body },
    );
    if (response.error) throw new UserCapabilityError(await readFailure(response.error));
    return response.data;
  } catch (error) {
    if (error instanceof UserCapabilityError) throw error;
    throw new UserCapabilityError(error instanceof TypeError ? 'network' : 'unknown');
  }
}

async function fetchGrants(targetUserId: string): Promise<readonly UserCapabilityGrant[]> {
  const response = await invoke({ action: 'list', targetUserId });
  const data = isRecord(response) ? response['data'] : null;
  return Array.isArray(data)
    ? data.map(parseGrant).filter((grant): grant is UserCapabilityGrant => grant !== null)
    : [];
}

export interface UserCapabilitiesApi {
  readonly grants: readonly UserCapabilityGrant[];
  readonly isLoading: boolean;
  readonly error: UserCapabilityErrorCode | null;
  readonly grant: (permissionSlug: string, expiresAt: string | null) => Promise<void>;
  readonly revoke: (capabilityId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export function useUserCapabilities(targetUserId: string): UserCapabilitiesApi {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => [...QUERY_PREFIX, targetUserId] as const, [targetUserId]);
  const query = useQuery({
    queryKey,
    queryFn: () => fetchGrants(targetUserId),
    enabled: targetUserId !== '',
    staleTime: 10_000,
    retry: false,
  });

  const refetchQuery = query.refetch;
  const refresh = useCallback(async () => {
    await refetchQuery();
  }, [refetchQuery]);

  const grant = useCallback(
    async (permissionSlug: string, expiresAt: string | null) => {
      /* No client-side allow-list: the database refuses non-delegatable
         slugs with capability_not_delegatable and that refusal is mapped
         back into the 'not-delegatable' code above. */
      if (permissionSlug === '') throw new UserCapabilityError('unknown');
      await invoke({ action: 'grant', targetUserId, permissionSlug, expiresAt });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: DELEGATED_USERS_QUERY_KEY }),
      ]);
    },
    [queryClient, queryKey, targetUserId],
  );

  const revoke = useCallback(
    async (capabilityId: string) => {
      await invoke({ action: 'revoke', capabilityId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: DELEGATED_USERS_QUERY_KEY }),
      ]);
    },
    [queryClient, queryKey],
  );

  return {
    grants: query.data ?? [],
    isLoading: query.isPending,
    error: query.error instanceof UserCapabilityError ? query.error.code : null,
    grant,
    revoke,
    refresh,
  };
}
