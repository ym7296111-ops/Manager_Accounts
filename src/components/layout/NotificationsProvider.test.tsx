import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsProvider, useNotifications } from '@/components/layout/NotificationsProvider';
import type { UserNotificationsApi } from '@/hooks/useUserNotifications';

/**
 * `NotificationsProvider` topology: one provider mount runs the feed hook
 * exactly once (hence exactly one Realtime subscription), and every consumer
 * receives that same instance. The hook is stubbed here — its own behavior is
 * covered by `useUserNotifications.test.tsx`, and the end-to-end
 * single-subscription assertion against a real backend double lives in
 * `NotificationDropdown.test.tsx`.
 *
 * Plain DOM matchers only — this project does not depend on jest-dom.
 */

const { feedHook } = vi.hoisted(() => ({ feedHook: vi.fn() }));

vi.mock('@/hooks/useUserNotifications', () => ({
  useUserNotifications: feedHook,
}));

const SENTINEL = { unreadCount: 7 } as unknown as UserNotificationsApi;

function Probe({ testId }: { testId: string }) {
  const api = useNotifications();
  return <output data-testid={testId}>{api === SENTINEL ? 'shared' : 'different'}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  /* `restoreMocks: true` strips implementations after each test. */
  feedHook.mockReturnValue(SENTINEL);
});

describe('NotificationsProvider', () => {
  it('runs the feed hook once and shares that instance with every consumer', () => {
    render(
      <NotificationsProvider>
        <Probe testId="probe-bell" />
        <Probe testId="probe-dropdown" />
      </NotificationsProvider>,
    );

    expect(feedHook).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('probe-bell').textContent).toBe('shared');
    expect(screen.getByTestId('probe-dropdown').textContent).toBe('shared');
  });

  it('fails loudly when a consumer renders outside the provider', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Probe testId="probe-orphan" />)).toThrow(/NotificationsProvider/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
