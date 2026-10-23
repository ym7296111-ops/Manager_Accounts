import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXECUTIVE_DASHBOARD_QUERY_KEY,
  ExecutiveDashboardError,
  parseExecutiveDashboard,
  useExecutiveDashboard,
} from '@/hooks/useExecutiveDashboard';

/**
 * Data layer of the executive dashboard.
 *
 * The Supabase client is stubbed at the seam the hook actually uses (`rpc`),
 * so these tests pin the wire contract: the RPC name, the bounded parameter,
 * the JSON shape validation, and the normalization of every failure class into
 * a locale-independent code.
 */

const { rpc, client } = vi.hoisted(() => {
  const rpc = vi.fn();
  return { rpc, client: { rpc } };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => client }));

/** Payload matching `public.get_executive_dashboard`. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated_at: '2026-10-20T09:00:00.000Z',
    timezone: 'UTC',
    window_days: 30,
    kpis: {
      total_users: 42,
      pending_approvals: 3,
      suspended_users: 1,
      pending_password_resets: 2,
      signed_in_today: 7,
    },
    daily_signups: [
      { day: '2026-10-19', count: 2 },
      { day: '2026-10-20', count: 1 },
    ],
    role_distribution: {
      items: [
        { slug: 'viewer', name_ar: 'مشاهد', name_en: 'Viewer', user_count: 30 },
        { slug: 'executive', name_ar: 'الإدارة العليا', name_en: 'Executive', user_count: 2 },
      ],
      users_without_role: 3,
    },
    recent_activity: [
      {
        id: 900,
        occurred_at: '2026-10-20T08:30:00.000Z',
        action: 'user.updated',
        event: 'user.approval_approve',
        entity: 'user',
        actor_kind: 'user',
        actor_label: 'سارة',
        target_label: 'm***@example.invalid',
        role_slugs: ['viewer'],
      },
    ],
    ...overrides,
  };
}

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  rpc.mockReset();
});

describe('parseExecutiveDashboard', () => {
  it('maps the snake_case RPC payload onto the view model', () => {
    const parsed = parseExecutiveDashboard(payload());
    expect(parsed).not.toBeNull();
    expect(parsed?.kpis.totalUsers).toBe(42);
    expect(parsed?.kpis.signedInToday).toBe(7);
    expect(parsed?.windowDays).toBe(30);
    expect(parsed?.timezone).toBe('UTC');
    expect(parsed?.dailySignups).toEqual([
      { day: '2026-10-19', count: 2 },
      { day: '2026-10-20', count: 1 },
    ]);
    expect(parsed?.usersWithoutRole).toBe(3);
    expect(parsed?.recentActivity[0]).toMatchObject({
      id: '900',
      event: 'user.approval_approve',
      actorKind: 'user',
      roleSlugs: ['viewer'],
    });
  });

  it('echoes the project time zone the RPC applied, falling back to UTC', () => {
    /* The RPC reads `appearance.default_timezone` live and echoes the zone
       it bucketed by; the screen renders every absolute time in that zone. */
    expect(parseExecutiveDashboard(payload({ timezone: 'Asia/Riyadh' }))?.timezone).toBe(
      'Asia/Riyadh',
    );
    /* Older or truncated payloads keep the historical UTC behaviour. */
    expect(parseExecutiveDashboard(payload({ timezone: undefined }))?.timezone).toBe('UTC');
    expect(parseExecutiveDashboard(payload({ timezone: 42 }))?.timezone).toBe('UTC');
  });

  it('rejects a malformed snapshot instead of rendering partial numbers', () => {
    expect(parseExecutiveDashboard(null)).toBeNull();
    expect(parseExecutiveDashboard({})).toBeNull();
    expect(parseExecutiveDashboard(payload({ kpis: null }))).toBeNull();
    expect(parseExecutiveDashboard(payload({ daily_signups: [{}] }))).toBeNull();
    expect(parseExecutiveDashboard(payload({ role_distribution: { items: [{}] } }))).toBeNull();
    expect(parseExecutiveDashboard(payload({ recent_activity: 'nope' }))).toBeNull();
  });

  it('tolerates an unknown activity event by falling back to the action', () => {
    const parsed = parseExecutiveDashboard(
      payload({
        recent_activity: [
          {
            id: '1',
            occurred_at: '2026-10-20T08:30:00.000Z',
            action: 'support.ticket_replied',
            entity: 'tickets',
            actor_kind: 'system',
            actor_label: null,
            target_label: null,
            role_slugs: [],
          },
        ],
      }),
    );
    expect(parsed?.recentActivity[0]).toMatchObject({
      event: 'support.ticket_replied',
      actorKind: 'system',
      actorLabel: null,
      roleSlugs: [],
    });
  });
});

describe('useExecutiveDashboard', () => {
  it('calls the single read-only RPC with the bounded window', async () => {
    rpc.mockResolvedValue({ data: payload(), error: null });
    const { result } = renderHook(() => useExecutiveDashboard(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_executive_dashboard', { p_window_days: 30 });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.lastSyncedAt).not.toBeNull();
  });

  it('stays parked while the caller is not allowed to read the dashboard', async () => {
    const { result } = renderHook(() => useExecutiveDashboard({ enabled: false }), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });

  it('maps 42501 to the forbidden code', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission_denied' },
    });
    const { result } = renderHook(() => useExecutiveDashboard(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.errorCode).toBe('forbidden'));
    expect(result.current.data).toBeNull();
  });

  it('maps a missing RPC to unavailable instead of crashing', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.get_executive_dashboard',
      },
    });
    const { result } = renderHook(() => useExecutiveDashboard(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.errorCode).toBe('unavailable'));
  });

  it('reports an unparseable answer as invalid-response', async () => {
    rpc.mockResolvedValue({ data: { kpis: 'nope' }, error: null });
    const { result } = renderHook(() => useExecutiveDashboard(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.errorCode).toBe('invalid-response'));
  });

  it('normalizes a transport failure to network', async () => {
    rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useExecutiveDashboard(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.errorCode).toBe('network'));
  });

  it('exposes a stable cache key and a typed error class', () => {
    expect(EXECUTIVE_DASHBOARD_QUERY_KEY).toEqual(['executive-dashboard']);
    expect(new ExecutiveDashboardError('forbidden').code).toBe('forbidden');
  });
});
