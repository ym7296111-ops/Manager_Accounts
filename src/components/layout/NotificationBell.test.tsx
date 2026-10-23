import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { I18nProvider } from '@/i18n/I18nContext';
import { NotificationBell } from '@/components/layout/NotificationBell';
import type { UserNotificationsApi, UserNotificationRow } from '@/hooks/useUserNotifications';

/**
 * NotificationBell + NotificationDropdown: presence, unread badge, and the
 * open/close contract copied from the account menu (outside pointerdown,
 * Escape with focus return, close after navigating).
 *
 * The feed itself is unit-tested in `useUserNotifications.test.tsx`; here the
 * `NotificationsProvider` context hook is stubbed so the assertions stay
 * about rendering and interaction.
 *
 * Plain DOM matchers only — this project does not depend on jest-dom.
 */

type MarkReadFn = (id: string) => Promise<boolean>;
type MarkAllFn = () => Promise<number>;

interface BellStubState {
  unreadCount: number | null;
  notifications: UserNotificationRow[];
  realtimeState: 'connecting' | 'live' | 'offline';
  isLoading: boolean;
  isError: boolean;
  isMarking: boolean;
  markRead: Mock<MarkReadFn>;
  markAllRead: Mock<MarkAllFn>;
  refetch: Mock<() => void>;
}

const state = vi.hoisted((): BellStubState => ({
  unreadCount: 0,
  notifications: [],
  realtimeState: 'live',
  isLoading: false,
  isError: false,
  isMarking: false,
  markRead: vi.fn<MarkReadFn>(),
  markAllRead: vi.fn<MarkAllFn>(),
  refetch: vi.fn<() => void>(),
}));

vi.mock('@/components/layout/NotificationsProvider', () => ({
  useNotifications: (): UserNotificationsApi => ({
    notifications: state.notifications,
    unreadCount: state.unreadCount,
    isLoading: state.isLoading,
    isError: state.isError,
    realtimeState: state.realtimeState,
    markRead: state.markRead,
    markAllRead: state.markAllRead,
    isMarking: state.isMarking,
    refetch: state.refetch,
  }),
}));

function row(overrides: Partial<UserNotificationRow> = {}): UserNotificationRow {
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

const READ_ROW: Partial<UserNotificationRow> = {
  is_read: true,
  read_at: '2026-10-19T10:00:00.000Z',
};

function renderBell() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <NotificationBell className="size-9" />
      </MemoryRouter>
    </I18nProvider>,
  );
}

function bellButton(): HTMLElement {
  return screen.getByRole('button', { name: /التنبيهات/ });
}

function openBell() {
  fireEvent.click(bellButton());
  return screen.getByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  state.unreadCount = 0;
  state.notifications = [];
  state.realtimeState = 'live';
  state.isLoading = false;
  state.isError = false;
  state.isMarking = false;
  state.markRead = vi.fn<MarkReadFn>().mockResolvedValue(true);
  state.markAllRead = vi.fn<MarkAllFn>().mockResolvedValue(0);
  state.refetch = vi.fn<() => void>();
});

describe('NotificationBell', () => {
  it('renders the bell with an accessible unread count', () => {
    state.unreadCount = 3;
    renderBell();

    const bell = bellButton();
    expect(bell.getAttribute('aria-label')).toBe('التنبيهات (3 غير مقروء)');
    expect(bell.getAttribute('aria-expanded')).toBe('false');
    expect(bell.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('shows the badge with the unread count', () => {
    state.unreadCount = 7;
    renderBell();

    expect(screen.getByTestId('notification-badge').textContent).toBe('7');
  });

  it('hides the badge when nothing is unread', () => {
    state.unreadCount = 0;
    renderBell();

    expect(screen.queryByTestId('notification-badge')).toBe(null);
  });

  it('caps the badge at 99+', () => {
    state.unreadCount = 250;
    renderBell();

    expect(screen.getByTestId('notification-badge').textContent).toBe('99+');
  });
});

describe('NotificationBell dropdown', () => {
  it('refreshes the feed when the dropdown opens', () => {
    renderBell();
    openBell();

    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it('opens on click and closes on a second click', () => {
    state.unreadCount = 1;
    state.notifications = [row()];
    renderBell();

    const bell = bellButton();
    expect(screen.queryByRole('dialog')).toBe(null);

    fireEvent.click(bell);
    expect(screen.queryByRole('dialog')).not.toBe(null);
    expect(bell.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(bell);
    expect(screen.queryByRole('dialog')).toBe(null);
    expect(bell.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and returns focus to the bell', () => {
    state.notifications = [row()];
    renderBell();

    const bell = bellButton();
    fireEvent.click(bell);
    expect(screen.queryByRole('dialog')).not.toBe(null);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBe(null);
    expect(document.activeElement).toBe(bell);
  });

  it('closes on an outside pointerdown', () => {
    state.notifications = [row()];
    render(
      <I18nProvider>
        <MemoryRouter>
          <button type="button">outside</button>
          <NotificationBell className="size-9" />
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(bellButton());
    expect(screen.queryByRole('dialog')).not.toBe(null);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('dialog')).toBe(null);
  });

  it('translates the stored i18n keys and interpolates the masked params', () => {
    state.unreadCount = 1;
    state.notifications = [row()];
    renderBell();

    openBell();

    expect(screen.getByText('طلب اعتماد جديد')).not.toBe(null);
    expect(screen.getByText(/p\*\*\*@example\.invalid/)).not.toBe(null);
  });

  it('offers "mark all as read" and calls the mutation', async () => {
    state.unreadCount = 2;
    state.notifications = [row(), row({ id: 'n2' })];
    state.markAllRead = vi.fn<MarkAllFn>().mockResolvedValue(2);
    renderBell();

    openBell();

    const markAll = screen.getByRole('button', { name: 'تعليم الكل كمقروء' });
    await act(async () => {
      fireEvent.click(markAll);
      await Promise.resolve();
    });

    expect(state.markAllRead).toHaveBeenCalledTimes(1);
  });

  it('hides "mark all as read" when the feed is fully read', () => {
    state.unreadCount = 0;
    state.notifications = [row(READ_ROW)];
    renderBell();

    openBell();

    expect(screen.queryByRole('button', { name: 'تعليم الكل كمقروء' })).toBe(null);
  });

  it('marks an unread item read when it is opened', async () => {
    state.unreadCount = 1;
    state.notifications = [row()];
    state.markRead = vi.fn<MarkReadFn>().mockResolvedValue(true);
    renderBell();

    openBell();
    await act(async () => {
      fireEvent.click(screen.getByText('طلب اعتماد جديد'));
      await Promise.resolve();
    });

    expect(state.markRead).toHaveBeenCalledWith('n1');
  });

  it('does not re-mark an item that is already read', async () => {
    state.notifications = [row(READ_ROW)];
    state.markRead = vi.fn<MarkReadFn>().mockResolvedValue(false);
    renderBell();

    openBell();
    await act(async () => {
      fireEvent.click(screen.getByText('طلب اعتماد جديد'));
      await Promise.resolve();
    });

    expect(state.markRead).not.toHaveBeenCalled();
  });

  it('shows the empty state when there is nothing to show', () => {
    state.unreadCount = 0;
    state.notifications = [];
    renderBell();

    openBell();

    const empty = screen.getByTestId('notification-empty');
    expect(empty.getAttribute('role')).toBe('status');
    expect(within(empty).getByText('لا توجد إشعارات حالياً')).not.toBe(null);
    expect(within(empty).getByText('ستظهر هنا الإشعارات الجديدة بمجرد حدوثها')).not.toBe(null);
    // The muted Ban icon was replaced by the requested Bell, so assert the
    // glyph renders rather than an empty tile.
    expect(empty.querySelector('svg')).not.toBe(null);
    // The list is genuinely absent — no leftover rows or empty <ul>.
    expect(within(empty).queryAllByRole('listitem')).toHaveLength(0);
    expect(empty.querySelector('ul')).toBe(null);
  });

  it('swaps the empty state for the feed as soon as a row arrives', () => {
    state.notifications = [];
    renderBell();
    const bell = bellButton();
    fireEvent.click(bell);
    expect(screen.queryByTestId('notification-empty')).not.toBe(null);

    fireEvent.click(bell);
    state.notifications = [row()];
    fireEvent.click(bell);

    expect(screen.queryByTestId('notification-empty')).toBe(null);
    expect(screen.getByText('طلب اعتماد جديد')).not.toBe(null);
  });

  it('does not show the empty state while the first fetch is in flight', () => {
    state.notifications = [];
    state.isLoading = true;
    renderBell();

    openBell();

    expect(screen.queryByTestId('notification-empty')).toBe(null);
    expect(screen.getByText('جارٍ التحميل…')).not.toBe(null);
  });

  it('does not show the empty state when the fetch failed', () => {
    state.notifications = [];
    state.isError = true;
    renderBell();

    openBell();

    expect(screen.queryByTestId('notification-empty')).toBe(null);
    expect(screen.getByText('تعذّر تحميل التنبيهات.')).not.toBe(null);
  });

  it('warns when the live feed is degraded', () => {
    state.realtimeState = 'offline';
    state.notifications = [row()];
    renderBell();

    openBell();

    expect(screen.getByText(/التحديث الفوري غير متاح/)).not.toBe(null);
  });

  it('does not warn while the socket is live', () => {
    state.realtimeState = 'live';
    state.notifications = [row()];
    renderBell();

    openBell();

    expect(screen.queryByText(/التحديث الفوري غير متاح/)).toBe(null);
  });
});
