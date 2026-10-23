import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStatusUpdateBlocker,
  mapSupportPostgrestError,
  parseReplies,
  parseTickets,
  SUPPORT_TICKETS_QUERY_KEY,
  supportRepliesQueryKey,
  useSupportManagement,
  validateCreateTicketInput,
  validateReplyBody,
} from '@/hooks/useSupportManagement';

const { rpc, from, state, client, channelListeners } = vi.hoisted(() => {
  const rpc = vi.fn();
  const from = vi.fn();
  const state = { configured: true, actorId: 'actor-admin' };
  const channelListeners: Array<{ table: string; callback: () => void }> = [];
  const channel = {
    on: vi.fn((_type: string, filter: { table: string }, callback: () => void) => {
      channelListeners.push({ table: filter.table, callback });
      return channel;
    }),
    subscribe: vi.fn((cb?: (status: string) => void) => {
      cb?.('SUBSCRIBED');
      return channel;
    }),
  };
  const client = {
    from,
    rpc,
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return { rpc, from, state, client, channelListeners };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => (state.configured ? client : null),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    session: state.actorId ? { user: { id: state.actorId } } : null,
  }),
}));

const WIRE_TICKET = {
  id: '00000000-0000-4000-8000-000000000101',
  ticket_number: 1001,
  user_id: 'actor-admin',
  assigned_to: 'actor-admin',
  subject: 'Cannot export audit report',
  description: 'Exporting the monthly PDF fails with a timeout after 10 seconds.',
  status: 'opened',
  priority: 'high',
  last_activity_at: '2026-10-01T10:00:00Z',
  resolved_at: null,
  closed_at: null,
  created_at: '2026-10-01T09:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  profiles: {
    id: 'actor-admin',
    email: 'admin@example.invalid',
    full_name: 'Admin User',
    status: 'active',
    user_roles: [
      { roles: { slug: 'super_admin', name_ar: 'مدير النظام', name_en: 'Super Admin' } },
    ],
  },
};

const WIRE_REPLY = {
  id: '00000000-0000-4000-8000-000000000201',
  ticket_id: WIRE_TICKET.id,
  sender_id: 'actor-admin',
  is_support_reply: true,
  body: 'We are investigating the export worker logs now.',
  created_at: '2026-10-01T10:05:00Z',
  profiles: WIRE_TICKET.profiles,
};

function mountSupportHook() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    queryClient,
    ...renderHook(() => useSupportManagement(), { wrapper }),
  };
}

describe('useSupportManagement data & security contract', () => {
  beforeEach(() => {
    state.configured = true;
    state.actorId = 'actor-admin';
    channelListeners.length = 0;
    rpc.mockReset();

    from.mockReset().mockImplementation((table: string) => {
      if (table === 'tickets') {
        return {
          select: vi.fn(() => ({
            order: vi.fn(() => ({
              range: vi.fn().mockResolvedValue({ data: [WIRE_TICKET], error: null }),
            })),
          })),
        };
      }
      if (table === 'ticket_replies') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(() => ({
                range: vi.fn().mockResolvedValue({ data: [WIRE_REPLY], error: null }),
              })),
            })),
          })),
        };
      }
      if (table === 'profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: { status: 'active' }, error: null }),
            })),
          })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({
            data: [
              {
                roles: {
                  slug: 'super_admin',
                  role_permissions: [{ permissions: { slug: '*' } }],
                },
              },
            ],
            error: null,
          }),
        })),
      };
    });
  });

  it('fetches tickets with embedded profiles and roles in one round trip and loads thread replies', async () => {
    const { result } = mountSupportHook();
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    await waitFor(() => expect(result.current.isLoadingReplies).toBe(false));

    expect(result.current.tickets).toHaveLength(1);
    expect(result.current.selectedTicket?.ticketNumber).toBe(1001);
    expect(result.current.selectedTicket?.requester?.roles[0]?.slug).toBe('super_admin');
    expect(result.current.replies).toHaveLength(1);
    expect(result.current.replies[0]?.isSupportReply).toBe(true);
    expect(result.current.realtimeState).toBe('live');
  });

  it('creates tickets, adds replies, and updates status exclusively through guarded RPCs', async () => {
    rpc.mockImplementation((fnName: string) => {
      if (fnName === 'create_support_ticket') {
        return Promise.resolve({
          data: { id: WIRE_TICKET.id, ticket_number: 1002 },
          error: null,
        });
      }
      if (fnName === 'add_ticket_reply') {
        return Promise.resolve({
          data: { id: WIRE_REPLY.id },
          error: null,
        });
      }
      return Promise.resolve({
        data: { id: WIRE_TICKET.id, status: 'resolved', priority: 'medium' },
        error: null,
      });
    });

    const { result } = mountSupportHook();
    await waitFor(() => expect(result.current.actorIsSupportAgent).toBe(true));
    await waitFor(() => expect(result.current.tickets).toHaveLength(1));

    let created;
    await act(async () => {
      created = await result.current.createTicket({
        subject: 'Database connection spike',
        description: 'Pool utilization reached 92% during peak hours.',
        priority: 'high',
      });
    });
    expect(created).toEqual({ ok: true, ticketId: WIRE_TICKET.id, ticketNumber: 1002 });
    expect(rpc).toHaveBeenCalledWith('create_support_ticket', {
      p_subject: 'Database connection spike',
      p_description: 'Pool utilization reached 92% during peak hours.',
      p_priority: 'high',
    });

    let replied;
    await act(async () => {
      replied = await result.current.addReply(WIRE_TICKET.id, 'Scaling pool size now.');
    });
    expect(replied).toEqual({ ok: true, ticketId: WIRE_TICKET.id, replyId: WIRE_REPLY.id });
    expect(rpc).toHaveBeenCalledWith('add_ticket_reply', {
      p_ticket_id: WIRE_TICKET.id,
      p_body: 'Scaling pool size now.',
    });

    let statusUpdated;
    await act(async () => {
      statusUpdated = await result.current.updateTicketStatus(WIRE_TICKET.id, 'resolved', 'medium');
    });
    expect(statusUpdated).toEqual({
      ok: true,
      ticketId: WIRE_TICKET.id,
      status: 'resolved',
      priority: 'medium',
    });
    expect(rpc).toHaveBeenCalledWith('update_ticket_status', {
      p_ticket_id: WIRE_TICKET.id,
      p_status: 'resolved',
      p_priority: 'medium',
    });
  });

  it('blocks replies to closed tickets and invalid inputs before touching the network', () => {
    const parsedTickets = parseTickets([{ ...WIRE_TICKET, status: 'closed' }]);
    const closedTicket = parsedTickets[0];

    expect(validateReplyBody(closedTicket, 'Can I still reply?')).toBe('ticket-closed');
    expect(
      validateCreateTicketInput({ subject: 'abc', description: 'too short', priority: 'low' }),
    ).toBe('invalid-input');
    expect(
      getStatusUpdateBlocker({
        ticket: closedTicket,
        actorIsSupportAgent: false,
        nextStatus: 'in_progress',
        nextPriority: 'high',
      }),
    ).toBe('forbidden');
    expect(
      getStatusUpdateBlocker({
        ticket: closedTicket,
        actorIsSupportAgent: true,
        nextStatus: 'closed',
        nextPriority: 'high',
      }),
    ).toBe('noop');
  });

  it.each([
    [{ code: '42501', message: 'permission denied' }, 'forbidden'],
    [{ code: 'P0002', message: 'not found' }, 'not-found'],
    [{ code: 'SUP01', message: 'cannot reply to a closed ticket' }, 'ticket-closed'],
    [{ code: '22023', message: 'invalid parameter' }, 'invalid-input'],
    [{ code: 'PGRST202', message: 'function not found' }, 'unavailable'],
    [{ status: 429, message: 'rate limit exceeded' }, 'rate-limited'],
  ])('normalizes server error %o to %s', (rawError, expected) => {
    expect(mapSupportPostgrestError(rawError).code).toBe(expected);
  });

  it('treats Realtime events strictly as cache invalidation signals', async () => {
    const { result, queryClient } = mountSupportHook();
    await waitFor(() => expect(result.current.tickets).toHaveLength(1));

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const repliesListener = channelListeners.find((entry) => entry.table === 'ticket_replies');
    expect(repliesListener).toBeDefined();

    act(() => {
      repliesListener?.callback();
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: SUPPORT_TICKETS_QUERY_KEY });
    });
    expect(parseReplies([WIRE_REPLY])[0]?.id).toBe(WIRE_REPLY.id);
    expect(supportRepliesQueryKey(WIRE_TICKET.id)).toEqual([
      'support-ticket-replies',
      WIRE_TICKET.id,
    ]);
  });
});
