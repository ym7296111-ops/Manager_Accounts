import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { USERS_QUERY_KEY } from '@/hooks/useUsersManagement';
import { getSupabase } from '@/lib/supabase';

/**
 * Active user-scoped delegations directory (`['delegated-users']`).
 *
 * * Reads every active capability grant (`revoked_at IS NULL` and
 *   `expires_at IS NULL OR expires_at > now()`) through the service-role
 *   `admin-user-capabilities` bridge (`action: 'list-all'`), gated by the
 *   database's own `get_user_capabilities` executor check (`owner` /
 *   `super_admin` active approved callers only).
 * * Falls back seamlessly to per-user `action: 'list'` (`get_user_capabilities`
 *   RPC) when talking to a bridge build that predates `list-all`, so preview
 *   deployments keep full parity before the function is redeployed.
 * * Exposes a `ReadonlyMap<userId, readonly DelegatedCapability[]>` containing
 *   only users with at least one active delegation, sorted deterministically.
 */

export interface DelegatedCapability {
  readonly slug: string;
  readonly expires_at: string | null;
  readonly granted_at: string;
}

export type DelegatedUsersMap = ReadonlyMap<string, readonly DelegatedCapability[]>;

export type DelegatedUsersErrorCode = 'unavailable' | 'forbidden' | 'network' | 'unknown';

export class DelegatedUsersError extends Error {
  readonly code: DelegatedUsersErrorCode;

  constructor(code: DelegatedUsersErrorCode) {
    super(code);
    this.name = 'DelegatedUsersError';
    this.code = code;
  }
}

export const DELEGATED_USERS_QUERY_KEY = ['delegated-users'] as const;

const EMPTY_DELEGATED_USERS: DelegatedUsersMap = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGrantActive(expiresAt: unknown, nowMs: number): boolean {
  if (expiresAt === null || expiresAt === undefined) {
    return true;
  }
  if (typeof expiresAt !== 'string') {
    return false;
  }
  const timestamp = Date.parse(expiresAt);
  return !Number.isNaN(timestamp) && timestamp > nowMs;
}

/**
 * Return the earliest expiration `Date` across `delegations`, or `null` when
 * every grant is permanent (`expires_at === null`).
 */
export function getSoonestExpiry(delegations: readonly DelegatedCapability[]): Date | null {
  let soonestMs: number | null = null;
  for (const entry of delegations) {
    if (entry.expires_at === null) {
      continue;
    }
    const parsed = Date.parse(entry.expires_at);
    if (Number.isNaN(parsed)) {
      continue;
    }
    if (soonestMs === null || parsed < soonestMs) {
      soonestMs = parsed;
    }
  }
  return soonestMs === null ? null : new Date(soonestMs);
}

/**
 * Return `true` when at least one grant in `delegations` carries a valid
 * `expires_at` timestamp.
 */
export function hasAnyExpiry(delegations: readonly DelegatedCapability[]): boolean {
  return getSoonestExpiry(delegations) !== null;
}

/**
 * Group wire rows into `user_id -> sorted unique DelegatedCapability[]`,
 * keeping only active grants (`expires_at IS NULL OR expires_at > now()`).
 */
export function parseDelegatedUsers(data: unknown, nowMs = Date.now()): DelegatedUsersMap {
  if (!Array.isArray(data)) {
    return EMPTY_DELEGATED_USERS;
  }

  const grouped = new Map<string, Map<string, DelegatedCapability>>();
  for (const row of data) {
    if (!isRecord(row)) continue;
    const userId = row['user_id'];
    const rawSlug = row['permission_slug'] ?? row['slug'];
    if (
      typeof userId !== 'string' ||
      userId === '' ||
      typeof rawSlug !== 'string' ||
      rawSlug === ''
    ) {
      continue;
    }
    if (!isGrantActive(row['expires_at'], nowMs)) {
      continue;
    }
    const expiresAt = typeof row['expires_at'] === 'string' ? row['expires_at'] : null;
    const grantedAt = typeof row['granted_at'] === 'string' ? row['granted_at'] : '';

    let bySlug = grouped.get(userId);
    if (bySlug === undefined) {
      bySlug = new Map<string, DelegatedCapability>();
      grouped.set(userId, bySlug);
    }
    bySlug.set(rawSlug, {
      slug: rawSlug,
      expires_at: expiresAt,
      granted_at: grantedAt,
    });
  }

  const result = new Map<string, readonly DelegatedCapability[]>();
  for (const [userId, bySlug] of grouped) {
    if (bySlug.size > 0) {
      result.set(
        userId,
        Array.from(bySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug)),
      );
    }
  }
  return result;
}

async function readBridgeErrorCode(error: unknown): Promise<string | null> {
  if (!isRecord(error)) return null;
  const context = error['context'];
  if (!isRecord(context) || typeof context['json'] !== 'function') return null;
  try {
    const body: unknown = await (context['json'] as () => Promise<unknown>).call(context);
    return isRecord(body) && typeof body['error'] === 'string' ? body['error'] : null;
  } catch {
    return null;
  }
}

function mapBridgeCode(wireCode: string | null): DelegatedUsersErrorCode {
  if (wireCode === 'permission_denied') return 'forbidden';
  if (wireCode === 'unavailable') return 'unavailable';
  return 'unknown';
}

async function resolveFallbackUserIds(queryClient: QueryClient): Promise<readonly string[]> {
  const cached: unknown = queryClient.getQueryData(USERS_QUERY_KEY);
  if (Array.isArray(cached) && cached.length > 0) {
    return cached
      .filter(
        (entry): entry is Record<string, unknown> =>
          isRecord(entry) &&
          typeof entry['id'] === 'string' &&
          entry['id'] !== '' &&
          entry['isProtected'] !== true &&
          (entry['status'] === undefined || entry['status'] === 'active') &&
          (entry['approvalStatus'] === undefined || entry['approvalStatus'] === 'approved'),
      )
      .map((entry) => entry['id'] as string);
  }

  const client = getSupabase();
  if (client === null || typeof client.from !== 'function') {
    return [];
  }
  const { data, error } = await client
    .from('profiles')
    .select('id')
    .eq('status', 'active')
    .eq('approval_status', 'approved');
  if (error !== null || !Array.isArray(data)) {
    return [];
  }
  return data
    .map((row: unknown) => (isRecord(row) && typeof row['id'] === 'string' ? row['id'] : ''))
    .filter((id) => id !== '');
}

async function fetchViaPerUserRpc(queryClient: QueryClient): Promise<DelegatedUsersMap> {
  const client = getSupabase();
  if (client === null || typeof client.functions?.invoke !== 'function') {
    throw new DelegatedUsersError('unavailable');
  }
  const userIds = await resolveFallbackUserIds(queryClient);
  if (userIds.length === 0) {
    return EMPTY_DELEGATED_USERS;
  }

  const combinedRows: Record<string, unknown>[] = [];
  await Promise.all(
    userIds.map(async (targetUserId) => {
      const response: { data?: unknown; error: unknown } = await client.functions.invoke(
        'admin-user-capabilities',
        { body: { action: 'list', targetUserId } },
      );
      if (response.error) {
        const wireCode = await readBridgeErrorCode(response.error);
        if (wireCode === 'permission_denied' || wireCode === 'unavailable') {
          throw new DelegatedUsersError(mapBridgeCode(wireCode));
        }
        return;
      }
      const list = isRecord(response.data) ? response.data['data'] : null;
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!isRecord(item)) continue;
        combinedRows.push({
          user_id: targetUserId,
          permission_slug: item['permission_slug'],
          granted_at: item['granted_at'] ?? '',
          expires_at: item['expires_at'] ?? null,
        });
      }
    }),
  );

  return parseDelegatedUsers(combinedRows);
}

async function fetchDelegatedUsers(queryClient: QueryClient): Promise<DelegatedUsersMap> {
  const client = getSupabase();
  if (client === null || typeof client.functions?.invoke !== 'function') {
    throw new DelegatedUsersError('unavailable');
  }
  try {
    const response: { data?: unknown; error: unknown } = await client.functions.invoke(
      'admin-user-capabilities',
      { body: { action: 'list-all' } },
    );
    if (response.error) {
      if (response.error instanceof TypeError) {
        throw new DelegatedUsersError('network');
      }
      const wireCode = await readBridgeErrorCode(response.error);
      if (wireCode === 'invalid_action') {
        return await fetchViaPerUserRpc(queryClient);
      }
      throw new DelegatedUsersError(mapBridgeCode(wireCode));
    }
    const payload = isRecord(response.data) ? response.data['data'] : null;
    return parseDelegatedUsers(payload);
  } catch (caught) {
    if (caught instanceof DelegatedUsersError) {
      throw caught;
    }
    throw new DelegatedUsersError(caught instanceof TypeError ? 'network' : 'unknown');
  }
}

export interface DelegatedUsersApi {
  readonly delegatedUsers: DelegatedUsersMap;
  readonly isLoading: boolean;
  readonly error: DelegatedUsersErrorCode | null;
  readonly refresh: () => Promise<void>;
}

export function useDelegatedUsers(options?: { readonly enabled?: boolean }): DelegatedUsersApi {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const query = useQuery({
    queryKey: DELEGATED_USERS_QUERY_KEY,
    queryFn: () => fetchDelegatedUsers(queryClient),
    enabled,
    staleTime: 10_000,
    retry: false,
  });

  const refetchQuery = query.refetch;
  const refresh = useCallback(async () => {
    await refetchQuery();
  }, [refetchQuery]);

  return {
    delegatedUsers: query.data ?? EMPTY_DELEGATED_USERS,
    isLoading: query.isPending,
    error: query.error instanceof DelegatedUsersError ? query.error.code : null,
    refresh,
  };
}
