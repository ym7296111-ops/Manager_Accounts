import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom does not implement `matchMedia`. Provide a minimal, side-effect free
 * stub so the theme system's "system mode" listener can attach cleanly.
 */
if (typeof URL !== 'undefined' && typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:mock-branding';
  URL.revokeObjectURL = () => undefined;
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  cleanup();
});

/* ------------------------------------------------------------------------- *
 * Shared Supabase Realtime test double
 * ------------------------------------------------------------------------- *
 *
 * Every screen that subscribes to `postgres_changes` follows the same house
 * contract (see useUsersManagement / useNotificationRealtime): the socket is a
 * cache-INVALIDATION signal, never a content channel. Tests therefore need to
 * drive two things and nothing else:
 *
 *   1. the channel STATUS callback  -> 'SUBSCRIBED' | 'CLOSED' | ...
 *   2. the postgres_changes callback -> fires the invalidation
 *
 * `createRealtimeClient()` returns a stub shaped like the part of
 * `SupabaseClient` these hooks touch, plus handles to drive it. Filters are
 * captured so a test can assert the subscription is scoped (for example
 * `user_id=eq.<uid>`) instead of listening to the whole table.
 *
 * The double is deliberately faithful to realtime-js where it matters:
 *
 *   - `channel(name)` REUSES a registered channel by topic instead of
 *     building a second one (realtime-js `RealtimeClient.channel`).
 *   - `.on('postgres_changes', …)` THROWS once the channel has subscribed
 *     (realtime-js `RealtimeChannel.on`: "cannot add `postgres_changes`
 *     callbacks for realtime:<topic> after `subscribe()`").
 *   - `removeChannel(channel)` DEREGISTERS the topic, so the next
 *     `channel(name)` builds a fresh channel.
 *
 * An earlier revision of this double created a fresh stub per `channel()`
 * call and let `.on()` succeed at any time — which is why the
 * bell-plus-dropdown double subscription shipped green locally and only
 * exploded in production. Tests that rely on the old, permissive shape
 * will fail loudly here; that is the point.
 */

export interface RealtimeChannelStub {
  on: (
    type: string,
    filter: Record<string, unknown> | undefined,
    cb: () => void,
  ) => RealtimeChannelStub;
  subscribe: (cb: (status: string) => void) => RealtimeChannelStub;
}

export interface RealtimeChannelEntry {
  readonly name: string;
  readonly handlers: Array<{
    type: string;
    filter: Record<string, unknown> | undefined;
    cb: () => void;
  }>;
  readonly statusCallbacks: Array<(status: string) => void>;
  /** Method names in invocation order — `['on', 'subscribe']` when healthy. */
  readonly calls: string[];
  /** True once `subscribe()` ran — mirrors realtime-js's joined/joining state. */
  readonly subscribed: boolean;
  /** True once `removeChannel()` deregistered the topic. */
  readonly removed: boolean;
}

export interface RealtimeClientStub {
  channel: (name: string) => RealtimeChannelStub;
  removeChannel: (channel: unknown) => void;
  /** Every channel created, in order, with its registered handlers. */
  readonly channels: RealtimeChannelEntry[];
  /** Drive a channel status (`SUBSCRIBED`, `CLOSED`, `CHANNEL_ERROR`, ...). */
  setStatus: (status: string, channelIndex?: number) => void;
  /** Fire the postgres_changes handlers of a channel. */
  emitChange: (channelIndex?: number) => void;
  /** All captured `filter` objects, flattened — for scoping assertions. */
  readonly filters: Array<Record<string, unknown> | undefined>;
  /** Make the next `subscribe()` call throw — resilience test knob. */
  failNextSubscribe: (error: Error) => void;
}

interface ChannelRecord {
  readonly name: string;
  readonly handlers: RealtimeChannelEntry['handlers'];
  readonly statusCallbacks: RealtimeChannelEntry['statusCallbacks'];
  readonly calls: string[];
  subscribed: boolean;
  removed: boolean;
}

export function createRealtimeClient(): RealtimeClientStub {
  const channels: ChannelRecord[] = [];
  /** Topic -> live stub, mirroring realtime-js's per-topic channel reuse. */
  const byName = new Map<string, RealtimeChannelStub>();
  /** Stub -> record, so `removeChannel` can find what to deregister. */
  const records = new Map<RealtimeChannelStub, ChannelRecord>();
  let pendingSubscribeError: Error | null = null;

  const channel = vi.fn((name: string): RealtimeChannelStub => {
    /* realtime-js returns the EXISTING channel for a known topic — it
       never builds a second one. This is what makes two subscribers
       on one channel name collide, exactly as in production. */
    const existing = byName.get(name);
    if (existing !== undefined) {
      return existing;
    }

    const record: ChannelRecord = {
      name,
      handlers: [],
      statusCallbacks: [],
      calls: [],
      subscribed: false,
      removed: false,
    };
    channels.push(record);

    const on = vi.fn(
      (
        type: string,
        filter: Record<string, unknown> | undefined,
        cb: () => void,
      ): RealtimeChannelStub => {
        record.calls.push('on');
        /* realtime-js refuses handlers registered after the channel
           joined — the production failure this double must surface,
           not swallow. Broadcast listeners stay permitted, as in the
           real client. */
        if (record.subscribed && (type === 'postgres_changes' || type === 'presence')) {
          throw new Error(
            `cannot add \`${type}\` callbacks for realtime:${name} after \`subscribe()\`.`,
          );
        }
        record.handlers.push({ type, filter, cb });
        return stub;
      },
    );
    const subscribe = vi.fn((cb: (status: string) => void): RealtimeChannelStub => {
      record.calls.push('subscribe');
      if (pendingSubscribeError !== null) {
        const error = pendingSubscribeError;
        pendingSubscribeError = null;
        throw error;
      }
      record.subscribed = true;
      record.statusCallbacks.push(cb);
      return stub;
    });
    const stub: RealtimeChannelStub = { on, subscribe };

    byName.set(name, stub);
    records.set(stub, record);
    return stub;
  });

  const removeChannel = vi.fn((target: unknown): void => {
    const record = records.get(target as RealtimeChannelStub);
    if (record === undefined) {
      return;
    }
    /* Deregister the topic so the next `channel(name)` builds a FRESH
       channel — this is what makes unmount/remount (StrictMode) safe. */
    byName.delete(record.name);
    record.removed = true;
  });

  return {
    channel,
    removeChannel,
    channels,
    failNextSubscribe: (error: Error) => {
      pendingSubscribeError = error;
    },
    setStatus: (status: string, channelIndex = 0) => {
      for (const cb of channels[channelIndex]?.statusCallbacks ?? []) {
        cb(status);
      }
    },
    emitChange: (channelIndex = 0) => {
      for (const handler of channels[channelIndex]?.handlers ?? []) {
        handler.cb();
      }
    },
    get filters() {
      return channels.flatMap((entry) => entry.handlers.map((handler) => handler.filter));
    },
  };
}
