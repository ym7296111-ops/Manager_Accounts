import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationBell } from '@/components/layout/NotificationBell';
import { NotificationsProvider } from '@/components/layout/NotificationsProvider';
import type { UserNotificationRow } from '@/hooks/useUserNotifications';
import { I18nProvider } from '@/i18n/I18nContext';
import { ar } from '@/i18n/locales/ar';
import { en } from '@/i18n/locales/en';
import { createRealtimeClient } from '@/test/setup';

/**
 * NotificationBell + NotificationDropdown end-to-end through the REAL
 * `useUserNotifications` hook.
 *
 * Unlike `NotificationBell.test.tsx` (which stubs the hook to test the
 * open/close contract), this file stubs the BACKEND: an in-memory table the
 * fake PostgREST builder actually filters. That makes the assertions
 * regression-sensitive to the active-feed predicate — drop the
 * `.is('resolved_at', null)` anywhere and these tests fail.
 *
 * Plain DOM matchers only — this project does not depend on jest-dom.
 */

const { client } = vi.hoisted(() => {
  const client = {
    from: vi.fn(),
    rpc: vi.fn(),
    channel: vi.fn() as unknown as (name: string) => unknown,
    removeChannel: vi.fn() as unknown as (channel: unknown) => void,
    realtime: { setAuth: vi.fn() },
  };
  return { client };
});

const actorId = 'actor-1';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => client }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { id: actorId }, access_token: 'verified-session-token' },
    configured: true,
    loading: false,
  }),
}));

/** The actor's rows, as the table would hold them. */
function storedRow(overrides: Partial<UserNotificationRow> = {}): UserNotificationRow {
  return {
    id: 'n1',
    type: 'user_approval_requested',
    title_key: 'notifications.type.user_approval_requested.title',
    body_key: 'notifications.type.user_approval_requested.body',
    params: { subject_email: 'p***@example.invalid' },
    link: '/settings/system/users',
    is_read: false,
    read_at: null,
    related_id: null,
    resolved_at: null,
    created_at: '2026-10-19T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * One row in each quadrant of the active-feed predicate. Only the two
 * `active-*` rows (unread + unresolved) may ever reach the panel or the badge.
 * `resolved-unread` is the regression trap: an unread-only count would include
 * it and show 3.
 */
const TABLE: readonly UserNotificationRow[] = [
  storedRow({ id: 'active-1' }),
  storedRow({
    id: 'active-2',
    type: 'password_reset_requested',
    title_key: 'notifications.type.password_reset_requested.title',
    body_key: 'notifications.type.password_reset_requested.body',
    created_at: '2026-10-19T10:00:00.000Z',
  }),
  storedRow({
    id: 'read-1',
    type: 'user_approved',
    title_key: 'notifications.type.user_approved.title',
    body_key: 'notifications.type.user_approved.body',
    params: {},
    link: '/profile',
    is_read: true,
    read_at: '2026-10-19T11:00:00.000Z',
    created_at: '2026-10-19T08:00:00.000Z',
  }),
  storedRow({
    id: 'resolved-read',
    type: 'user_rejected',
    title_key: 'notifications.type.user_rejected.title',
    body_key: 'notifications.type.user_rejected.body',
    params: {},
    is_read: true,
    read_at: '2026-10-19T12:00:00.000Z',
    resolved_at: '2026-10-19T12:00:00.000Z',
    created_at: '2026-10-19T07:00:00.000Z',
  }),
  storedRow({
    id: 'resolved-unread',
    resolved_at: '2026-10-19T12:30:00.000Z',
    created_at: '2026-10-19T06:00:00.000Z',
  }),
];

let live: ReturnType<typeof createRealtimeClient>;
let table: UserNotificationRow[];

/** A thenable PostgREST double that applies the recorded filters to `table`. */
function createSelect() {
  return vi.fn((_columns: string, opts?: { head?: boolean }) => {
    const columnOf = (row: UserNotificationRow, column: string): unknown =>
      (row as unknown as Record<string, unknown>)[column];
    const predicates: Array<(row: UserNotificationRow) => boolean> = [];
    let cap: number | undefined;
    const head = opts?.head === true;
    const builder = {
      eq: (column: string, value: unknown) => {
        predicates.push((row) => columnOf(row, column) === value);
        return builder;
      },
      is: (column: string, value: unknown) => {
        predicates.push((row) => columnOf(row, column) === value);
        return builder;
      },
      order: () => builder,
      limit: (count: number) => {
        cap = count;
        return builder;
      },
      then: (onFulfilled: unknown, onRejected: unknown) => {
        const matched = table
          .filter((row) => predicates.every((matches) => matches(row)))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        const resolved = head
          ? { count: matched.length, data: null, error: null }
          : { data: cap === undefined ? matched : matched.slice(0, cap), error: null };
        return Promise.resolve(resolved).then(
          onFulfilled as (value: typeof resolved) => unknown,
          onRejected as (reason: unknown) => unknown,
        );
      },
    };
    return builder;
  });
}

function renderBell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  /* Mirrors the `Topbar` topology: the provider owns the single feed hook
     (and its one Realtime subscription) around the bell. */
  const tree = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter>
          <NotificationsProvider>{children}</NotificationsProvider>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
  return render(tree(<NotificationBell className="size-9" />));
}

function bellButton(): HTMLElement {
  return screen.getByRole('button', { name: /التنبيهات/ });
}

function openBell(): HTMLElement {
  fireEvent.click(bellButton());
  return screen.getByRole('dialog');
}

function visibleRowIds(panel: HTMLElement): Array<string | null> {
  return within(panel)
    .queryAllByRole('listitem')
    .map((item) => item.getAttribute('data-notification-id'));
}

beforeEach(() => {
  vi.clearAllMocks();
  table = TABLE.map((entry) => ({ ...entry }));
  live = createRealtimeClient();
  /* `restoreMocks: true` strips implementations after each test, so every seam
     is re-established here rather than relying on the hoisted defaults. */
  client.from = vi.fn(() => ({ select: createSelect() }));
  client.channel = live.channel;
  client.removeChannel = live.removeChannel;
  client.realtime.setAuth = vi.fn().mockResolvedValue(undefined);
  client.rpc = vi.fn((name: string, args?: { p_notification_id?: string }) => {
    if (name === 'mark_notification_read') {
      const target = table.find((entry) => entry.id === args?.p_notification_id);
      if (target === undefined || target.is_read) {
        return Promise.resolve({ data: false, error: null });
      }
      table = table.map((entry) =>
        entry === target ? { ...entry, is_read: true, read_at: '2026-10-19T13:00:00.000Z' } : entry,
      );
      return Promise.resolve({ data: true, error: null });
    }
    if (name === 'mark_all_notifications_read') {
      let changed = 0;
      table = table.map((entry) => {
        if (entry.is_read) {
          return entry;
        }
        changed += 1;
        return { ...entry, is_read: true, read_at: '2026-10-19T13:00:00.000Z' };
      });
      return Promise.resolve({ data: changed, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
});

describe('NotificationDropdown active feed', () => {
  it('shows only unread + unresolved rows, and the badge counts exactly those', async () => {
    renderBell();

    /* Badge: 2 active rows — not 3 (the resolved-but-unread trap row). */
    await waitFor(() => expect(screen.getByTestId('notification-badge').textContent).toBe('2'));

    const panel = openBell();

    /* Newest first, and only the active quadrant. */
    await waitFor(() => expect(visibleRowIds(panel)).toEqual(['active-2', 'active-1']));
    expect(within(panel).queryByText('تم اعتماد حسابك')).toBe(null); // read-1
    expect(within(panel).queryByText('تم رفض طلب الاعتماد')).toBe(null); // resolved-read
  });

  it('shows the empty state when only read or resolved rows exist', async () => {
    table = table.filter((entry) => !entry.id.startsWith('active-'));
    renderBell();

    const panel = openBell();

    await waitFor(() => expect(screen.getByTestId('notification-empty')).not.toBe(null));
    expect(within(panel).getByText('لا توجد إشعارات حالياً')).not.toBe(null);
    expect(visibleRowIds(panel)).toEqual([]);
    /* Nothing active → no badge, even though the table holds four rows. */
    expect(screen.queryByTestId('notification-badge')).toBe(null);
  });

  it('drops a row out of the panel as soon as it is marked read', async () => {
    /* A link-less copy keeps the panel open when clicked (no navigation). */
    table = table.map((entry) => (entry.id === 'active-1' ? { ...entry, link: null } : entry));
    renderBell();
    const panel = openBell();
    await waitFor(() => expect(visibleRowIds(panel)).toEqual(['active-2', 'active-1']));

    await act(async () => {
      fireEvent.click(within(panel).getByText('طلب اعتماد جديد'));
      await Promise.resolve();
    });

    await waitFor(() => expect(visibleRowIds(panel)).toEqual(['active-2']));
    expect(screen.getByTestId('notification-badge').textContent).toBe('1');
  });

  it('converges when a row is resolved upstream and the Realtime signal lands', async () => {
    renderBell();
    const panel = openBell();
    await waitFor(() => expect(visibleRowIds(panel)).toEqual(['active-2', 'active-1']));

    await waitFor(() => expect(live.channels.length).toBeGreaterThanOrEqual(1));
    for (let index = 0; index < live.channels.length; index += 1) {
      act(() => live.setStatus('SUBSCRIBED', index));
    }

    /* Upstream resolution stamps resolved_at (+ is_read), then the
       invalidation signal reaches the client. */
    table = table.map((entry) =>
      entry.id === 'active-1'
        ? {
            ...entry,
            is_read: true,
            read_at: '2026-10-19T14:00:00.000Z',
            resolved_at: '2026-10-19T14:00:00.000Z',
          }
        : entry,
    );
    act(() => live.emitChange(0));

    /* The signal is coalesced (250ms) before the refetch runs. */
    await waitFor(() => expect(visibleRowIds(panel)).toEqual(['active-2']), { timeout: 3000 });
    expect(screen.getByTestId('notification-badge').textContent).toBe('1');
  });

  it('renders no history affordance: the panel has no history view behind it', async () => {
    renderBell();
    const panel = openBell();
    await waitFor(() => expect(visibleRowIds(panel)).toEqual(['active-2', 'active-1']));

    /* The feed is active-only (`is_read = false AND resolved_at IS NULL`), so
       read/resolved rows never reach the panel and nothing behind it lists
       them. The previous disabled "view history" button promised a view that
       does not exist; it must stay absent until a real history route ships. */
    expect(screen.queryByTestId('notification-history')).toBe(null);
    expect(within(panel).queryByRole('button', { name: 'عرض السجل' })).toBe(null);
    expect(within(panel).queryByText('عرض السجل')).toBe(null);
    /* The footer that carried it is gone too: the list is the last block. */
    expect(panel.lastElementChild?.tagName).toBe('UL');
  });

  it('drops the history copy from both dictionaries with the button', () => {
    /* Guards the other half of the removal: the dead control must not come
       back by re-adding a string nobody renders (and `I18nContext.test.tsx`
       only enforces ar/en parity, not usage). */
    expect(Object.keys(ar)).not.toContain('notifications.panel.history');
    expect(Object.keys(en)).not.toContain('notifications.panel.history');
  });
});

describe('NotificationBell + NotificationDropdown integration', () => {
  it('opens exactly one realtime subscription for bell and dropdown together', async () => {
    renderBell();
    openBell();

    await waitFor(() => expect(screen.getByRole('dialog')).not.toBe(null));

    /* `NotificationsProvider` owns the single feed hook: with the bell
       mounted AND the dropdown open there is exactly ONE channel — the
       previous bell-plus-dropdown double subscription is gone, and opening
       the panel must not create another one. */
    await waitFor(() => expect(live.channels).toHaveLength(1));
    expect(live.channels[0]?.name).toMatch(/^user-notifications-live-/);
    /* One subscription, scoped to the caller. */
    expect(live.filters[0]).toMatchObject({
      event: '*',
      schema: 'public',
      table: 'user_notifications',
      filter: `user_id=eq.${actorId}`,
    });

    /* One feed: the badge and the panel agree on the same two active rows. */
    await waitFor(() => expect(screen.getByTestId('notification-badge').textContent).toBe('2'));
    await waitFor(() =>
      expect(visibleRowIds(screen.getByRole('dialog'))).toEqual(['active-2', 'active-1']),
    );
    /* Still one channel after the feed settled. */
    expect(live.channels).toHaveLength(1);
  });

  it('drops a row out of the open panel when it is deleted upstream', async () => {
    renderBell();
    const panel = openBell();
    await waitFor(() => expect(visibleRowIds(panel)).toEqual(['active-2', 'active-1']));
    await waitFor(() => expect(live.channels).toHaveLength(1));
    act(() => live.setStatus('SUBSCRIBED'));

    /* Upstream: the row is deleted outright (for example a direct SQL
       cleanup). The same subscription carries the DELETE (event: '*')
       and the refetch simply never sees the row again. */
    table = table.filter((entry) => entry.id !== 'active-1');
    act(() => live.emitChange());

    /* The signal is coalesced (250ms) before the refetch runs. */
    await waitFor(() => expect(visibleRowIds(panel)).toEqual(['active-2']), { timeout: 3000 });
    expect(screen.getByTestId('notification-badge').textContent).toBe('1');
  });
});

describe('NotificationDropdown — delegation_event lifecycle support', () => {
  it('renders Shield, ShieldOff, and Clock icons with localized copy and target links', async () => {
    table = [
      storedRow({
        id: 'delegation-granted',
        type: 'delegation_event',
        title_key: 'notifications.type.delegation_granted.title',
        body_key: 'notifications.type.delegation_granted.body',
        params: {
          event: 'granted',
          slug: 'users.approve',
          granter_email: 'owner@example.invalid',
          expires_at: '2026-11-15T00:00:00.000Z',
        },
        metadata: {
          event: 'granted',
          slug: 'users.approve',
          granter_email: 'owner@example.invalid',
          expires_at: '2026-11-15T00:00:00.000Z',
        },
        link: '/profile#delegations',
        created_at: '2026-10-22T12:04:00.000Z',
      }),
      storedRow({
        id: 'delegation-revoked',
        type: 'delegation_event',
        title_key: 'notifications.type.delegation_revoked.title',
        body_key: 'notifications.type.delegation_revoked.body',
        params: {
          event: 'revoked',
          slug: 'users.reset_password',
        },
        metadata: {
          event: 'revoked',
          slug: 'users.reset_password',
        },
        link: '/profile#delegations',
        created_at: '2026-10-22T12:03:00.000Z',
      }),
      storedRow({
        id: 'delegation-expiring-delegate',
        type: 'delegation_event',
        title_key: 'notifications.type.delegation_expiring.title',
        body_key: 'notifications.type.delegation_expiring.body',
        params: {
          event: 'expiring',
          slug: 'users.approve',
          days: '5',
        },
        metadata: {
          event: 'expiring',
          recipient_role: 'delegate',
          slug: 'users.approve',
          days: 5,
        },
        link: null,
        created_at: '2026-10-22T12:02:00.000Z',
      }),
      storedRow({
        id: 'delegation-expiring-granter',
        type: 'delegation_event',
        title_key: 'notifications.type.delegation_expiring_granter.title',
        body_key: 'notifications.type.delegation_expiring_granter.body',
        params: {
          event: 'expiring',
          slug: 'users.approve',
          email: 'viewer@example.invalid',
          days: '5',
        },
        metadata: {
          event: 'expiring',
          recipient_role: 'granter',
          slug: 'users.approve',
          email: 'viewer@example.invalid',
          days: 5,
        },
        link: null,
        created_at: '2026-10-22T12:01:00.000Z',
      }),
    ];

    renderBell();
    const panel = openBell();

    await waitFor(() =>
      expect(visibleRowIds(panel)).toEqual([
        'delegation-granted',
        'delegation-revoked',
        'delegation-expiring-delegate',
        'delegation-expiring-granter',
      ]),
    );

    const grantedRow = panel.querySelector('[data-notification-id="delegation-granted"]')!;
    expect(grantedRow.querySelector('[data-icon="shield"]')).not.toBe(null);
    expect(grantedRow.textContent).toContain('تم منحك تفويضاً: users.approve');
    expect(grantedRow.textContent).toContain('owner@example.invalid');
    expect(grantedRow.querySelector('a')?.getAttribute('href')).toBe('/profile#delegations');

    const revokedRow = panel.querySelector('[data-notification-id="delegation-revoked"]')!;
    expect(revokedRow.querySelector('[data-icon="shield-off"]')).not.toBe(null);
    expect(revokedRow.textContent).toContain('تم سحب تفويضك: users.reset_password');
    expect(revokedRow.querySelector('a')?.getAttribute('href')).toBe('/profile#delegations');

    const delegateExpiringRow = panel.querySelector(
      '[data-notification-id="delegation-expiring-delegate"]',
    )!;
    expect(delegateExpiringRow.querySelector('[data-icon="clock"]')).not.toBe(null);
    expect(delegateExpiringRow.textContent).toContain('تفويضك users.approve ينتهي خلال 5 أيام');
    expect(delegateExpiringRow.querySelector('a')?.getAttribute('href')).toBe(
      '/profile#delegations',
    );

    const granterExpiringRow = panel.querySelector(
      '[data-notification-id="delegation-expiring-granter"]',
    )!;
    expect(granterExpiringRow.querySelector('[data-icon="clock"]')).not.toBe(null);
    expect(granterExpiringRow.textContent).toContain(
      'تفويض viewer@example.invalid ينتهي خلال 5 أيام - جدّد أو اسحب',
    );
    expect(granterExpiringRow.querySelector('a')?.getAttribute('href')).toBe(
      '/settings/system/users',
    );
  });
});
