import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { createRealtimeClient } from '@/test/setup';
import {
  USER_NOTIFICATIONS_REALTIME_CHANNEL,
  useUserNotificationsRealtime,
} from '@/hooks/useUserNotificationsRealtime';

/**
 * Regression tests for the Realtime subscription contract of
 * `useUserNotificationsRealtime`.
 *
 * The shared double in `src/test/setup.ts` is deliberately faithful to
 * realtime-js: `channel(name)` reuses registered topics, and `.on()` throws
 * after subscribe. Every hook instance must therefore get a unique topic.
 */

const { client } = vi.hoisted(() => {
  const client = {
    channel: vi.fn() as unknown as (name: string) => unknown,
    removeChannel: vi.fn() as unknown as (channel: unknown) => void,
    realtime: { setAuth: vi.fn() },
  };
  return { client };
});

vi.mock('@/lib/supabase', () => ({ getSupabase: () => client }));

const actorId = 'actor-1';
const accessToken = 'verified-session-token';

let live: ReturnType<typeof createRealtimeClient>;
let setupOrder: string[];

beforeEach(() => {
  vi.clearAllMocks();
  live = createRealtimeClient();
  setupOrder = [];
  /* `restoreMocks: true` strips implementations after each test, so restore
     the client seams here. */
  client.channel = (name: string) => {
    setupOrder.push('channel');
    return live.channel(name);
  };
  client.removeChannel = live.removeChannel;
  client.realtime.setAuth = vi.fn(() => {
    setupOrder.push('setAuth');
    return Promise.resolve();
  });
});

/** Renders the hook's state as text, so an uncaught effect error would fail
    the render just as it would in the production subtree. */
function Probe({
  userId,
  token = accessToken,
  testId,
}: {
  userId: string | null;
  token?: string | null;
  testId: string;
}) {
  const { state } = useUserNotificationsRealtime({ userId, accessToken: token });
  return <output data-testid={testId}>{state}</output>;
}

describe('useUserNotificationsRealtime', () => {
  it('sets the session auth before registering the filtered channel', async () => {
    renderHook(() => useUserNotificationsRealtime({ userId: actorId, accessToken }));

    await waitFor(() => expect(live.channels).toHaveLength(1));

    const entry = live.channels[0];
    expect(entry?.name).toMatch(new RegExp(`^${USER_NOTIFICATIONS_REALTIME_CHANNEL}-`));
    expect(setupOrder.slice(0, 2)).toEqual(['setAuth', 'channel']);
    expect(client.realtime.setAuth).toHaveBeenCalledWith(accessToken);
    /* Handler registration remains before subscribe (a realtime-js contract). */
    expect(entry?.calls).toEqual(['on', 'subscribe']);
    expect(entry?.handlers[0]).toMatchObject({
      type: 'postgres_changes',
      filter: {
        event: '*',
        schema: 'public',
        table: 'user_notifications',
        filter: `user_id=eq.${actorId}`,
      },
    });
  });

  it('does not authenticate or open a socket without a signed-in user and token', () => {
    const { result } = renderHook(() =>
      useUserNotificationsRealtime({ userId: null, accessToken: null }),
    );

    expect(result.current.state).toBe('offline');
    expect(client.realtime.setAuth).not.toHaveBeenCalled();
    expect(live.channel).not.toHaveBeenCalled();
  });

  it('gives simultaneous hook instances distinct channels (defense in depth)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    /* The app now mounts exactly ONE instance (NotificationsProvider in
       Topbar), but the hook still guarantees that an accidental second
       mount degrades to a redundant socket instead of the production
       collision: instances share query cache keys, never a topic. */
    const { unmount } = render(
      <>
        <Probe userId={actorId} testId="probe-bell" />
        <Probe userId={actorId} testId="probe-dropdown" />
      </>,
    );

    await waitFor(() => expect(live.channels).toHaveLength(2));
    expect(screen.getByTestId('probe-bell')).not.toBe(null);
    expect(screen.getByTestId('probe-dropdown')).not.toBe(null);
    const names = live.channels.map((entry) => entry.name);
    expect(names.every((name) => name.startsWith(`${USER_NOTIFICATIONS_REALTIME_CHANNEL}-`))).toBe(
      true,
    );
    expect(new Set(names).size).toBe(2);

    act(() => {
      live.setStatus('SUBSCRIBED', 0);
      live.setStatus('SUBSCRIBED', 1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('probe-bell').textContent).toBe('live');
      expect(screen.getByTestId('probe-dropdown').textContent).toBe('live');
    });
    expect(errorSpy).not.toHaveBeenCalled();

    unmount();
    expect(live.channels.every((entry) => entry.removed)).toBe(true);
    errorSpy.mockRestore();
  });

  it('turns a 401 from setAuth into offline state without crashing the UI', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.realtime.setAuth = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

    render(
      <ErrorBoundary fallback={<output data-testid="boundary-fallback">failed</output>}>
        <Probe userId={actorId} testId="probe" />
      </ErrorBoundary>,
    );

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('offline'));
    expect(screen.queryByTestId('boundary-fallback')).toBe(null);
    expect(live.channel).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('contains a synchronous subscribe failure and reports offline for polling fallback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    live.failNextSubscribe(new Error('socket refused'));

    render(
      <ErrorBoundary fallback={<output data-testid="boundary-fallback">failed</output>}>
        <Probe userId={actorId} testId="probe" />
      </ErrorBoundary>,
    );

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('offline'));
    expect(screen.queryByTestId('boundary-fallback')).toBe(null);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(live.channels[0]?.removed).toBe(true);
    errorSpy.mockRestore();
  });

  it('deregisters the channel through the client on cleanup and uses a fresh topic on remount', async () => {
    const { unmount } = renderHook(() =>
      useUserNotificationsRealtime({ userId: actorId, accessToken }),
    );
    await waitFor(() => expect(live.channels).toHaveLength(1));

    unmount();

    expect(client.removeChannel).toHaveBeenCalledTimes(1);
    expect(live.channels[0]?.removed).toBe(true);

    const remounted = renderHook(() =>
      useUserNotificationsRealtime({ userId: actorId, accessToken }),
    );
    await waitFor(() => expect(live.channels).toHaveLength(2));
    expect(live.channels[1]?.name).not.toBe(live.channels[0]?.name);
    expect(live.channels[1]?.subscribed).toBe(true);
    remounted.unmount();
  });

  it('does not leak a channel during StrictMode double-mount', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <StrictMode>
        <Probe userId={actorId} testId="probe" />
      </StrictMode>,
    );

    /* The first async auth attempt is canceled before channel creation; only
       the surviving StrictMode effect is allowed to subscribe. */
    await waitFor(() => expect(live.channels).toHaveLength(1));
    expect(live.channels[0]?.removed).toBe(false);
    expect(live.channels[0]?.subscribed).toBe(true);

    act(() => live.setStatus('SUBSCRIBED'));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('live'));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
