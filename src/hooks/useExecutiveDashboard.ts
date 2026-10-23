import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PostgrestError } from '@supabase/supabase-js';
import { useCallback } from 'react';
import type { TranslationKey } from '@/i18n/I18nContext';
import { getSupabase } from '@/lib/supabase';

/**
 * Executive dashboard data layer.
 *
 * One TanStack Query entry feeds the whole dashboard from ONE read-only RPC
 * (`get_executive_dashboard`). The RPC is the only sanctioned read path: the
 * dashboard tables are protected by row level security that narrows
 * `profiles` / `user_roles` / `audit_logs` to the caller's own rows (or to
 * `is_admin()`), so a browser-side aggregate would return plausible-looking
 * but wrong numbers. The function runs SECURITY DEFINER, verifies the caller
 * is an active approved holder of `dashboard:read`, and returns aggregates
 * only.
 *
 * Contract notes:
 *   - every failure is normalised to a locale-independent code; the screen
 *     maps it onto the bilingual dictionary and never renders raw SQL text;
 *   - `staleTime` and `refetchInterval` are both 60s, so a dashboard left open
 *     converges without a Realtime subscription (none of the four source
 *     tables is published for the browser);
 *   - the parser validates the JSON shape instead of trusting it, because a
 *     half-deployed schema (RPC missing / old signature) must surface as
 *     `unavailable` rather than crash a chart.
 */

/** Default window handled down to the RPC (the RPC accepts 7..90). */
export const EXECUTIVE_DASHBOARD_WINDOW_DAYS = 30;

/** Single cache key for the screen. */
export const EXECUTIVE_DASHBOARD_QUERY_KEY = ['executive-dashboard'] as const;

/* ------------------------------------------------------------------ types */

export interface ExecutiveDashboardKpis {
  readonly totalUsers: number;
  readonly pendingApprovals: number;
  readonly suspendedUsers: number;
  readonly pendingPasswordResets: number;
  readonly signedInToday: number;
}

export interface SignupPoint {
  /** `YYYY-MM-DD` calendar bucket in the project time zone (see `timezone`). */
  readonly day: string;
  readonly count: number;
}

export interface RoleDistributionItem {
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly userCount: number;
}

export interface RecentActivityItem {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  /** Exact event name (`user.approval_approve`, …) or the action fallback. */
  readonly event: string;
  readonly entity: string | null;
  readonly actorKind: 'user' | 'system';
  /** Full name, masked e-mail, or `null` when the actor was deleted. */
  readonly actorLabel: string | null;
  /** Full name, masked e-mail, role name, or `null` when unresolvable. */
  readonly targetLabel: string | null;
  readonly roleSlugs: readonly string[];
}

export interface ExecutiveDashboard {
  readonly generatedAt: string;
  readonly timezone: string;
  readonly windowDays: number;
  readonly kpis: ExecutiveDashboardKpis;
  readonly dailySignups: readonly SignupPoint[];
  readonly roleDistribution: readonly RoleDistributionItem[];
  readonly usersWithoutRole: number;
  readonly recentActivity: readonly RecentActivityItem[];
}

/** Locale-independent failure codes for the screen. */
export type ExecutiveDashboardErrorCode =
  'unavailable' | 'forbidden' | 'invalid-response' | 'network' | 'unknown';

/** Every failure code → its bilingual dictionary key. */
export const EXECUTIVE_DASHBOARD_ERROR_KEYS: Record<ExecutiveDashboardErrorCode, TranslationKey> = {
  unavailable: 'dashboard.error.unavailable',
  forbidden: 'dashboard.error.forbidden',
  'invalid-response': 'dashboard.error.invalidResponse',
  network: 'dashboard.error.network',
  unknown: 'dashboard.error.unknown',
};

/** Internal error carrying a normalized code; raw Supabase errors stay here. */
export class ExecutiveDashboardError extends Error {
  readonly code: ExecutiveDashboardErrorCode;

  constructor(code: ExecutiveDashboardErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ExecutiveDashboardError';
    this.code = code;
  }
}

/* ------------------------------------------------------------ error model */

function mapPostgrestError(error: { readonly code: string; readonly message: string }) {
  const message = error.message.toLowerCase();
  if (error.code === '42501' || message.includes('permission_denied')) {
    return new ExecutiveDashboardError('forbidden');
  }
  if (
    error.code === 'PGRST202' ||
    error.code === 'PGRST204' ||
    message.includes('could not find the function') ||
    message.includes('schema cache')
  ) {
    return new ExecutiveDashboardError('unavailable');
  }
  if (message.includes('rate limit') || message.includes('too many')) {
    return new ExecutiveDashboardError('network');
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return new ExecutiveDashboardError('network');
  }
  return new ExecutiveDashboardError('unknown');
}

function toErrorCode(caught: unknown): ExecutiveDashboardErrorCode {
  if (caught instanceof ExecutiveDashboardError) {
    return caught.code;
  }
  if (caught instanceof TypeError) {
    return 'network';
  }
  return 'unknown';
}

/* ------------------------------------------------------- runtime parsing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Audit ids are bigints serialised as numbers or strings; normalise both. */
function asId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === 'string' ? value : '';
}

function parseKpis(value: unknown): ExecutiveDashboardKpis | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    totalUsers: asNumber(value['total_users']),
    pendingApprovals: asNumber(value['pending_approvals']),
    suspendedUsers: asNumber(value['suspended_users']),
    pendingPasswordResets: asNumber(value['pending_password_resets']),
    signedInToday: asNumber(value['signed_in_today']),
  };
}

function parseDailySignups(value: unknown): SignupPoint[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const points: SignupPoint[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const day = asString(entry['day']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return null;
    }
    points.push({ day, count: asNumber(entry['count']) });
  }
  return points;
}

function parseRoleDistribution(value: unknown): {
  items: RoleDistributionItem[];
  usersWithoutRole: number;
} | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) {
    return null;
  }
  const items: RoleDistributionItem[] = [];
  for (const entry of value['items']) {
    if (!isRecord(entry)) {
      return null;
    }
    const slug = asString(entry['slug']);
    if (slug === '') {
      return null;
    }
    items.push({
      slug,
      nameAr: asString(entry['name_ar'], slug),
      nameEn: asString(entry['name_en'], slug),
      userCount: asNumber(entry['user_count']),
    });
  }
  return { items, usersWithoutRole: asNumber(value['users_without_role']) };
}

function parseRecentActivity(value: unknown): RecentActivityItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: RecentActivityItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const rawRoles = entry['role_slugs'];
    const roleSlugs = Array.isArray(rawRoles)
      ? rawRoles.filter((slug): slug is string => typeof slug === 'string')
      : [];
    items.push({
      id: asId(entry['id']),
      occurredAt: asString(entry['occurred_at']),
      action: asString(entry['action']),
      event: asString(entry['event'], asString(entry['action'])),
      entity: asNullableString(entry['entity']),
      actorKind: entry['actor_kind'] === 'system' ? 'system' : 'user',
      actorLabel: asNullableString(entry['actor_label']),
      targetLabel: asNullableString(entry['target_label']),
      roleSlugs,
    });
  }
  return items;
}

/**
 * Validate and normalise the RPC payload. Exported for tests; a `null` result
 * means "the server answered something this screen cannot render" and is
 * surfaced as `invalid-response` rather than as an empty dashboard.
 */
export function parseExecutiveDashboard(value: unknown): ExecutiveDashboard | null {
  if (!isRecord(value)) {
    return null;
  }
  const kpis = parseKpis(value['kpis']);
  const dailySignups = parseDailySignups(value['daily_signups']);
  const roles = parseRoleDistribution(value['role_distribution']);
  const recentActivity = parseRecentActivity(value['recent_activity']);
  if (kpis === null || dailySignups === null || roles === null || recentActivity === null) {
    return null;
  }
  return {
    generatedAt: asString(value['generated_at']),
    timezone: asString(value['timezone'], 'UTC'),
    windowDays: asNumber(value['window_days']) || EXECUTIVE_DASHBOARD_WINDOW_DAYS,
    kpis,
    dailySignups,
    roleDistribution: roles.items,
    usersWithoutRole: roles.usersWithoutRole,
    recentActivity,
  };
}

/* ------------------------------------------------------------------ fetch */

interface RpcResponse {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

async function fetchExecutiveDashboard(windowDays: number): Promise<ExecutiveDashboard> {
  const client = getSupabase();
  if (client === null) {
    throw new ExecutiveDashboardError('unavailable');
  }

  try {
    const response = (await client.rpc('get_executive_dashboard', {
      p_window_days: windowDays,
    })) as unknown as RpcResponse;

    if (response.error !== null) {
      throw mapPostgrestError(response.error);
    }
    const parsed = parseExecutiveDashboard(response.data);
    if (parsed === null) {
      throw new ExecutiveDashboardError('invalid-response');
    }
    return parsed;
  } catch (caught) {
    if (caught instanceof ExecutiveDashboardError) {
      throw caught;
    }
    throw new ExecutiveDashboardError(toErrorCode(caught));
  }
}

/* ------------------------------------------------------------------- hook */

export interface ExecutiveDashboardApi {
  readonly data: ExecutiveDashboard | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly errorCode: ExecutiveDashboardErrorCode | null;
  readonly lastSyncedAt: number | null;
  readonly refresh: () => void;
}

export interface UseExecutiveDashboardOptions {
  /**
   * Gate the query on the caller's capability. Defaults to `true`; the screen
   * passes the resolved dashboard capability so an unauthorized viewer never
   * issues the request (the RPC refuses it anyway).
   */
  readonly enabled?: boolean;
  readonly windowDays?: number;
}

export function useExecutiveDashboard(
  options: UseExecutiveDashboardOptions = {},
): ExecutiveDashboardApi {
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const windowDays = options.windowDays ?? EXECUTIVE_DASHBOARD_WINDOW_DAYS;

  const query = useQuery({
    queryKey: [...EXECUTIVE_DASHBOARD_QUERY_KEY, windowDays],
    enabled,
    queryFn: () => fetchExecutiveDashboard(windowDays),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: (failureCount, error) =>
      error instanceof ExecutiveDashboardError && error.code === 'network' && failureCount < 2,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: EXECUTIVE_DASHBOARD_QUERY_KEY });
  }, [queryClient]);

  return {
    data: query.data ?? null,
    isLoading: query.isPending && query.isFetching,
    isRefreshing: query.isFetching && !query.isPending,
    errorCode:
      query.error === null
        ? null
        : query.error instanceof ExecutiveDashboardError
          ? query.error.code
          : 'unknown',
    lastSyncedAt: query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null,
    refresh,
  };
}
