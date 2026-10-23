import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PostgrestError } from '@supabase/supabase-js';
import { useAuth } from '@/context/AuthContext';
import { useAuthCapabilities, WILDCARD_CAPABILITY } from '@/hooks/useAuthCapabilities';
import type { TranslationKey } from '@/i18n/I18nContext';
import { getSupabase } from '@/lib/supabase';

/**
 * Support & Maintenance data layer (screen 4 of the settings screens).
 *
 * * Fetches tickets in ONE PostgREST round trip with `profiles` and
 *   `user_roles!user_id(roles(...))` embedded so requester identity and role
 *   badges never trigger N+1 queries. The `!user_id` FK hint is REQUIRED —
 *   see `TICKET_COLUMNS` below and the PGRST201 regression tests.
 * * Fetches the selected ticket's conversation thread (`ticket_replies`) with
 *   sender `profiles` and `user_roles!user_id(roles(...))` embedded in ONE
 *   round trip.
 * * Supabase Realtime on `public.tickets` and `public.ticket_replies` is used
 *   strictly as a cache invalidation signal (`invalidateQueries`), never
 *   mutating client cache directly from raw socket payloads.
 * * All mutations go through guarded `SECURITY DEFINER` RPCs:
 *     - `create_support_ticket(p_subject, p_description, p_priority)`
 *     - `add_ticket_reply(p_ticket_id, p_body)`
 *     - `update_ticket_status(p_ticket_id, p_status, p_priority)`
 */

/* ------------------------------------------------------------------ types */

/** Lifecycle states of a support ticket. Mirrors `public.ticket_status`. */
export type TicketStatus = 'opened' | 'in_progress' | 'resolved' | 'closed';

/** Priority levels of a support ticket. Mirrors `public.ticket_priority`. */
export type TicketPriority = 'low' | 'medium' | 'high';

/** A role badge attached to a ticket requester or reply sender. */
export interface SupportRoleItem {
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string;
}

/** Embedded profile + roles for a ticket owner or reply author. */
export interface SupportActorProfile {
  readonly id: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly status: 'invited' | 'active' | 'suspended';
  readonly roles: readonly SupportRoleItem[];
}

/** Domain view model for a row in `public.tickets`. */
export interface SupportTicket {
  readonly id: string;
  readonly ticketNumber: number;
  readonly userId: string;
  readonly assignedTo: string | null;
  readonly subject: string;
  readonly description: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly lastActivityAt: string;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requester: SupportActorProfile | null;
}

/** Domain view model for a chronological reply in `public.ticket_replies`. */
export interface SupportTicketReply {
  readonly id: string;
  readonly ticketId: string;
  readonly senderId: string;
  readonly isSupportReply: boolean;
  readonly body: string;
  readonly createdAt: string;
  readonly sender: SupportActorProfile | null;
}

/** Normalized, locale-independent failure codes for the support screen. */
export type SupportErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'not-found'
  | 'ticket-closed'
  | 'invalid-input'
  | 'noop'
  | 'in-flight'
  | 'rate-limited'
  | 'network'
  | 'unknown';

/** Health of the Supabase Realtime invalidation channel. */
export type RealtimeState = 'connecting' | 'live' | 'offline';

/** Input payload for creating a new support ticket. */
export interface CreateTicketInput {
  readonly subject: string;
  readonly description: string;
  readonly priority: TicketPriority;
}

/** Result of `createTicket` — a discriminated union; nothing is thrown to the UI. */
export type CreateTicketResult =
  | {
      readonly ok: true;
      readonly ticketId: string;
      readonly ticketNumber: number;
    }
  | {
      readonly ok: false;
      readonly code: SupportErrorCode;
    };

/** Result of `addReply` — a discriminated union; nothing is thrown to the UI. */
export type AddReplyResult =
  | {
      readonly ok: true;
      readonly ticketId: string;
      readonly replyId: string;
    }
  | {
      readonly ok: false;
      readonly ticketId: string;
      readonly code: SupportErrorCode;
    };

/** Result of `updateTicketStatus` — a discriminated union; nothing is thrown to the UI. */
export type UpdateTicketStatusResult =
  | {
      readonly ok: true;
      readonly ticketId: string;
      readonly status: TicketStatus;
      readonly priority: TicketPriority;
    }
  | {
      readonly ok: false;
      readonly ticketId: string;
      readonly code: SupportErrorCode;
    };

/**
 * Actor authorization snapshot for the support screen (Phase 3A).
 *
 * The FIRST source is the server-resolved capability channel
 * (`useAuthCapabilities` → `get_my_capabilities()`): the UI reads capability
 * slugs (`support.manage`, `*`) and NEVER role names. This snapshot is the
 * fail-soft FALLBACK, consulted only while the channel is silent — it speaks
 * exactly the same capability-slug language as `hasCapability()`.
 */
export interface SupportActorAccess {
  readonly isActive: boolean;
  readonly isSupportAgent: boolean;
  readonly isSuperAdmin: boolean;
}

/** Capability slug that opens the agent toolbox (wildcard holds it too). */
export const SUPPORT_MANAGE_CAPABILITY = 'support.manage';

/* -------------------------------------------------------- dictionary keys */

/** Every normalized error code → its bilingual dictionary key. */
export const SUPPORT_ERROR_KEYS: Record<SupportErrorCode, TranslationKey> = {
  unavailable: 'support.error.unavailable',
  forbidden: 'support.error.forbidden',
  'not-found': 'support.error.notFound',
  'ticket-closed': 'support.error.ticketClosed',
  'invalid-input': 'support.error.invalidInput',
  noop: 'support.error.noop',
  'in-flight': 'support.error.inFlight',
  'rate-limited': 'support.error.rateLimited',
  network: 'support.error.network',
  unknown: 'support.error.unknown',
};

/* ------------------------------------------------------------- constants */

export const SUPPORT_TICKETS_QUERY_KEY = ['support-tickets'] as const;
export const SUPPORT_REPLIES_QUERY_PREFIX = ['support-ticket-replies'] as const;
export const SUPPORT_ACCESS_QUERY_PREFIX = ['support-actor-access'] as const;

export function supportRepliesQueryKey(ticketId: string | null) {
  return [...SUPPORT_REPLIES_QUERY_PREFIX, ticketId ?? 'none'] as const;
}

const TICKETS_MAX_ROWS = 500;
const REPLIES_MAX_ROWS = 1000;
const REALTIME_CHANNEL = 'support-management-live';
const REALTIME_COALESCE_MS = 200;

/**
 * Single-round-trip column projections: embeds `profiles` and
 * `user_roles!user_id(roles(slug, name_ar, name_en))` so no N+1 queries ever
 * occur.
 *
 * The `!user_id` relationship hint is REQUIRED on every `user_roles` embed:
 * `user_roles` carries TWO foreign keys to `profiles` (`user_id` and
 * `granted_by`), and PostgREST refuses to guess between them (HTTP 300 /
 * `PGRST201`), which would fail the whole request. The `profiles` embed on
 * `tickets` is NOT ambiguous — `tickets.assigned_to` references `auth.users`,
 * so `user_id` is the only FK path to `profiles` there.
 */
export const TICKET_COLUMNS =
  'id, ticket_number, user_id, assigned_to, subject, description, status, priority, last_activity_at, resolved_at, closed_at, created_at, updated_at, profiles(id, email, full_name, status, user_roles!user_id(roles(slug, name_ar, name_en)))';

export const REPLY_COLUMNS =
  'id, ticket_id, sender_id, is_support_reply, body, created_at, profiles(id, email, full_name, status, user_roles!user_id(roles(slug, name_ar, name_en)))';

const EMPTY_TICKETS: readonly SupportTicket[] = [];
const EMPTY_REPLIES: readonly SupportTicketReply[] = [];

/* ------------------------------------------------------------ error model */

export class SupportManagementError extends Error {
  readonly code: SupportErrorCode;

  constructor(code: SupportErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SupportManagementError';
    this.code = code;
  }
}

export function mapSupportPostgrestError(
  error: Partial<PostgrestError> & { status?: number; message?: string },
): SupportManagementError {
  const message = (error.message ?? '').toLowerCase();

  if (error.code === '42501' || error.code === 'PGRST301' || message.includes('jwt')) {
    return new SupportManagementError('forbidden');
  }
  if (error.code === 'P0002' || error.code === 'PGRST116' || error.status === 404) {
    return new SupportManagementError('not-found');
  }
  if (
    error.code === 'SUP01' ||
    message.includes('closed ticket') ||
    message.includes('ticket is closed')
  ) {
    return new SupportManagementError('ticket-closed');
  }
  if (error.code === '22023' || error.code === '23514') {
    return new SupportManagementError('invalid-input');
  }
  if (error.code === 'PGRST202' || error.code === 'PGRST205') {
    return new SupportManagementError('unavailable');
  }
  if (error.status === 429 || message.includes('rate limit') || message.includes('too many')) {
    return new SupportManagementError('rate-limited');
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return new SupportManagementError('network');
  }
  return new SupportManagementError('unknown');
}

function toSupportErrorCode(caught: unknown): SupportErrorCode {
  if (caught instanceof SupportManagementError) {
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
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return fallback;
}

export function parseTicketStatus(value: unknown): TicketStatus {
  switch (value) {
    case 'opened':
    case 'in_progress':
    case 'resolved':
    case 'closed':
      return value;
    default:
      return 'opened';
  }
}

export function parseTicketPriority(value: unknown): TicketPriority {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
      return value;
    default:
      return 'medium';
  }
}

function parseUserStatus(value: unknown): 'invited' | 'active' | 'suspended' {
  switch (value) {
    case 'invited':
    case 'active':
    case 'suspended':
      return value;
    default:
      return 'active';
  }
}

function parseRole(value: unknown): SupportRoleItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const slug = asString(value['slug']);
  if (slug === '') {
    return null;
  }
  return {
    slug,
    nameAr: asString(value['name_ar']),
    nameEn: asString(value['name_en']),
  };
}

function parseEmbeddedProfile(value: unknown): SupportActorProfile | null {
  const raw: unknown = Array.isArray(value) ? (value as readonly unknown[])[0] : value;
  if (!isRecord(raw)) {
    return null;
  }
  const id = asString(raw['id']);
  if (id === '') {
    return null;
  }

  const roles: SupportRoleItem[] = [];
  const wireRoles = raw['user_roles'];
  if (Array.isArray(wireRoles)) {
    for (const entry of wireRoles) {
      if (!isRecord(entry)) {
        continue;
      }
      const nested = entry['roles'];
      const rawRole: unknown = Array.isArray(nested) ? (nested as readonly unknown[])[0] : nested;
      const parsed = parseRole(rawRole);
      if (parsed !== null) {
        roles.push(parsed);
      }
    }
  }

  return {
    id,
    email: asString(raw['email']),
    fullName: asNullableString(raw['full_name']),
    status: parseUserStatus(raw['status']),
    roles,
  };
}

export function parseTicketRow(value: unknown): SupportTicket | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value['id']);
  if (id === '') {
    return null;
  }

  return {
    id,
    ticketNumber: asNumber(value['ticket_number'], 0),
    userId: asString(value['user_id']),
    assignedTo: asNullableString(value['assigned_to']),
    subject: asString(value['subject']),
    description: asString(value['description']),
    status: parseTicketStatus(value['status']),
    priority: parseTicketPriority(value['priority']),
    lastActivityAt: asString(value['last_activity_at']),
    resolvedAt: asNullableString(value['resolved_at']),
    closedAt: asNullableString(value['closed_at']),
    createdAt: asString(value['created_at']),
    updatedAt: asString(value['updated_at']),
    requester: parseEmbeddedProfile(value['profiles']),
  };
}

export function parseTickets(data: unknown): SupportTicket[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const tickets: SupportTicket[] = [];
  for (const row of data) {
    const parsed = parseTicketRow(row);
    if (parsed !== null) {
      tickets.push(parsed);
    }
  }
  /* Deterministic ordering: most recently active first, tie-broken by ticketNumber desc. */
  tickets.sort((a, b) => {
    const byActivity = b.lastActivityAt.localeCompare(a.lastActivityAt);
    return byActivity !== 0 ? byActivity : b.ticketNumber - a.ticketNumber;
  });
  return tickets;
}

export function parseReplyRow(value: unknown): SupportTicketReply | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value['id']);
  if (id === '') {
    return null;
  }

  return {
    id,
    ticketId: asString(value['ticket_id']),
    senderId: asString(value['sender_id']),
    isSupportReply: value['is_support_reply'] === true,
    body: asString(value['body']),
    createdAt: asString(value['created_at']),
    sender: parseEmbeddedProfile(value['profiles']),
  };
}

export function parseReplies(data: unknown): SupportTicketReply[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const replies: SupportTicketReply[] = [];
  for (const row of data) {
    const parsed = parseReplyRow(row);
    if (parsed !== null) {
      replies.push(parsed);
    }
  }
  /* Chronological order (oldest to newest) for natural thread reading. */
  replies.sort((a, b) => {
    const byCreated = a.createdAt.localeCompare(b.createdAt);
    return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
  });
  return replies;
}

/* ---------------------------------------------------------- pure guards */

export function validateCreateTicketInput(input: CreateTicketInput): SupportErrorCode | null {
  const subject = input.subject.trim();
  const description = input.description.trim();
  if (subject.length < 5 || subject.length > 200) {
    return 'invalid-input';
  }
  if (description.length < 10 || description.length > 5000) {
    return 'invalid-input';
  }
  if (input.priority !== 'low' && input.priority !== 'medium' && input.priority !== 'high') {
    return 'invalid-input';
  }
  return null;
}

export function validateReplyBody(
  ticket: SupportTicket | null | undefined,
  body: string,
): SupportErrorCode | null {
  if (!ticket) {
    return 'not-found';
  }
  if (ticket.status === 'closed') {
    return 'ticket-closed';
  }
  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > 5000) {
    return 'invalid-input';
  }
  return null;
}

export function getStatusUpdateBlocker(params: {
  readonly ticket: SupportTicket | null | undefined;
  readonly actorIsSupportAgent: boolean;
  readonly nextStatus: TicketStatus;
  readonly nextPriority: TicketPriority;
}): SupportErrorCode | null {
  const { ticket, actorIsSupportAgent, nextStatus, nextPriority } = params;
  if (!ticket) {
    return 'not-found';
  }
  if (!actorIsSupportAgent) {
    return 'forbidden';
  }
  if (ticket.status === nextStatus && ticket.priority === nextPriority) {
    return 'noop';
  }
  return null;
}

/* ---------------------------------------------------------------- fetch */

interface QueryResult {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

interface RpcResult {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

async function fetchTickets(): Promise<SupportTicket[]> {
  const client = getSupabase();
  if (client === null) {
    throw new SupportManagementError('unavailable');
  }

  try {
    const { data, error } = (await client
      .from('tickets')
      .select(TICKET_COLUMNS)
      .order('last_activity_at', { ascending: false })
      .range(0, TICKETS_MAX_ROWS - 1)) as QueryResult;

    if (error !== null) {
      throw mapSupportPostgrestError(error);
    }
    return parseTickets(data);
  } catch (caught) {
    if (caught instanceof SupportManagementError) {
      throw caught;
    }
    throw new SupportManagementError(toSupportErrorCode(caught));
  }
}

async function fetchTicketReplies(ticketId: string): Promise<SupportTicketReply[]> {
  const client = getSupabase();
  if (client === null) {
    throw new SupportManagementError('unavailable');
  }

  try {
    const { data, error } = (await client
      .from('ticket_replies')
      .select(REPLY_COLUMNS)
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true })
      .range(0, REPLIES_MAX_ROWS - 1)) as QueryResult;

    if (error !== null) {
      throw mapSupportPostgrestError(error);
    }
    return parseReplies(data);
  } catch (caught) {
    if (caught instanceof SupportManagementError) {
      throw caught;
    }
    throw new SupportManagementError(toSupportErrorCode(caught));
  }
}

async function fetchActorAccess(actorId: string): Promise<SupportActorAccess> {
  const client = getSupabase();
  if (client === null) {
    return { isActive: false, isSupportAgent: false, isSuperAdmin: false };
  }

  /* Fail-soft fallback for the capability channel (Phase 3A): resolve the
     actor's effective capability slugs from the held role rows. ONLY the
     capability slugs (`*`, `support.manage`) are consulted — role NAMES are
     never read — so this path answers exactly what `hasCapability()` would
     answer if `get_my_capabilities()` were reachable. Runs only while the
     capability channel is silent. */
  const [profileResult, roleResult] = await Promise.all([
    client.from('profiles').select('status').eq('id', actorId).maybeSingle(),
    client
      .from('user_roles')
      .select('roles(role_permissions(permissions(slug)))')
      .eq('user_id', actorId),
  ]);

  const isActive = profileResult.data?.status === 'active';
  const rawRoles = Array.isArray(roleResult.data) ? (roleResult.data as readonly unknown[]) : [];

  const heldCapabilities = new Set<string>();

  for (const entry of rawRoles) {
    if (!isRecord(entry)) {
      continue;
    }
    const nestedRole = entry['roles'];
    const roleObj: unknown = Array.isArray(nestedRole)
      ? (nestedRole as readonly unknown[])[0]
      : nestedRole;
    if (!isRecord(roleObj)) {
      continue;
    }
    const rolePerms = roleObj['role_permissions'];
    if (Array.isArray(rolePerms)) {
      for (const rp of rolePerms) {
        if (!isRecord(rp)) {
          continue;
        }
        const permObj = rp['permissions'];
        const permRecord: unknown = Array.isArray(permObj)
          ? (permObj as readonly unknown[])[0]
          : permObj;
        if (isRecord(permRecord)) {
          const permSlug = asString(permRecord['slug']);
          if (permSlug !== '') {
            heldCapabilities.add(permSlug);
          }
        }
      }
    }
  }

  /* Mirrors `hasCapability`: the wildcard capability holds every door. */
  const isSuperAdmin = heldCapabilities.has(WILDCARD_CAPABILITY);
  const hasSupportPermission = isSuperAdmin || heldCapabilities.has(SUPPORT_MANAGE_CAPABILITY);

  return {
    isActive,
    isSupportAgent: isActive && hasSupportPermission,
    isSuperAdmin: isActive && isSuperAdmin,
  };
}

/** Profile status only — a session fact, never a capability or role name. */
async function fetchActorActive(actorId: string): Promise<boolean> {
  const client = getSupabase();
  if (client === null) {
    return false;
  }
  const profileResult = await client
    .from('profiles')
    .select('status')
    .eq('id', actorId)
    .maybeSingle();
  return profileResult.data?.status === 'active';
}

/* ----------------------------------------------------------------- hook */

export interface SupportManagementApi {
  readonly tickets: readonly SupportTicket[];
  readonly replies: readonly SupportTicketReply[];
  readonly selectedTicket: SupportTicket | null;
  readonly selectTicket: (ticketId: string | null) => void;
  readonly actorId: string | null;
  /** TRUE when the actor's profile is active (a session fact). */
  readonly actorIsActive: boolean;
  /**
   * TRUE when the actor may use the agent toolbox. Resolved from the
   * capability channel first (`hasCapability('support.manage')`), falling
   * back to the wire snapshot only while the channel is silent.
   */
  readonly actorIsSupportAgent: boolean;
  /**
   * TRUE when the actor holds the wildcard capability (`hasCapability('*')`)
   * — never derived from a role name. Same capability-first fallback chain.
   */
  readonly actorIsSuperAdmin: boolean;
  readonly isInitialLoading: boolean;
  readonly isRefreshing: boolean;
  readonly isLoadingReplies: boolean;
  readonly fetchError: SupportErrorCode | null;
  readonly repliesError: SupportErrorCode | null;
  readonly lastSyncedAt: number | null;
  readonly realtimeState: RealtimeState;
  readonly isCreatingTicket: boolean;
  readonly isSendingReply: boolean;
  readonly isUpdatingStatus: boolean;
  readonly refresh: () => void;
  readonly createTicket: (input: CreateTicketInput) => Promise<CreateTicketResult>;
  readonly addReply: (ticketId: string, body: string) => Promise<AddReplyResult>;
  readonly updateTicketStatus: (
    ticketId: string,
    status: TicketStatus,
    priority?: TicketPriority,
  ) => Promise<UpdateTicketStatusResult>;
}

export function useSupportManagement(): SupportManagementApi {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const actorId = session?.user.id ?? null;

  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [realtimeState, setRealtimeState] = useState<RealtimeState>('connecting');
  const [isCreatingTicket, setIsCreatingTicket] = useState(false);
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  const inFlightRef = useRef<Set<string>>(new Set());
  const realtimeStateRef = useRef<RealtimeState>('connecting');

  /* Phase 3A — the capability channel is the FIRST authority for the agent
     toolbox and the admin flag: `hasCapability('support.manage')` and
     `hasCapability('*')` (the wildcard holds every door). Role names never
     leave the wire. While the channel is silent (loading / unconfigured /
     refused / malformed) the wire fallback below resolves the same facts. */
  const capabilitiesChannel = useAuthCapabilities();
  const viaCapabilities = capabilitiesChannel.isAuthoritative
    ? {
        isSupportAgent: capabilitiesChannel.hasCapability(SUPPORT_MANAGE_CAPABILITY),
        isSuperAdmin: capabilitiesChannel.hasCapability(WILDCARD_CAPABILITY),
      }
    : null;
  const needsServerGate = viaCapabilities === null && !capabilitiesChannel.isLoading;

  /* Session fact (active profile), independent of any capability. */
  const statusQuery = useQuery({
    queryKey: [...SUPPORT_ACCESS_QUERY_PREFIX, 'status', actorId] as const,
    enabled: actorId !== null,
    queryFn: () => fetchActorActive(actorId ?? ''),
    staleTime: 60_000,
  });

  /* Fail-soft fallback — consulted ONLY while the capability channel is
     silent (the `useNotificationAccess` pattern generalised). */
  const accessQuery = useQuery({
    queryKey: [...SUPPORT_ACCESS_QUERY_PREFIX, actorId] as const,
    enabled: needsServerGate && actorId !== null,
    queryFn: () => fetchActorAccess(actorId ?? ''),
    staleTime: 60_000,
  });

  const ticketsQuery = useQuery({
    queryKey: SUPPORT_TICKETS_QUERY_KEY,
    queryFn: fetchTickets,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    retry: (failureCount, error) =>
      error instanceof SupportManagementError && error.code === 'network' && failureCount < 2,
  });

  const tickets = ticketsQuery.data ?? EMPTY_TICKETS;

  const selectedTicket = useMemo(() => {
    if (tickets.length === 0) {
      return null;
    }
    if (selectedTicketId !== null) {
      const match = tickets.find((ticket) => ticket.id === selectedTicketId);
      if (match !== undefined) {
        return match;
      }
    }
    return tickets[0] ?? null;
  }, [tickets, selectedTicketId]);

  const activeTicketId = selectedTicket?.id ?? null;

  const repliesQuery = useQuery({
    queryKey: supportRepliesQueryKey(activeTicketId),
    enabled: activeTicketId !== null,
    queryFn: () => fetchTicketReplies(activeTicketId ?? ''),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    retry: (failureCount, error) =>
      error instanceof SupportManagementError && error.code === 'network' && failureCount < 2,
  });

  const replies = activeTicketId !== null ? (repliesQuery.data ?? EMPTY_REPLIES) : EMPTY_REPLIES;

  const actorIsActive = statusQuery.data ?? (actorId !== null ? true : false);
  const actorIsSupportAgent =
    viaCapabilities?.isSupportAgent ?? accessQuery.data?.isSupportAgent ?? false;
  const actorIsSuperAdmin =
    viaCapabilities?.isSuperAdmin ?? accessQuery.data?.isSuperAdmin ?? false;

  /* Realtime subscription: pure cache-invalidation signal for both tables. */
  useEffect(() => {
    const client = getSupabase();
    if (client === null) {
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let invalidateTicketsPending = false;
    let invalidateRepliesPending = false;

    const flushInvalidations = () => {
      timer = null;
      if (disposed) {
        return;
      }
      if (invalidateTicketsPending) {
        invalidateTicketsPending = false;
        void queryClient.invalidateQueries({ queryKey: SUPPORT_TICKETS_QUERY_KEY });
      }
      if (invalidateRepliesPending) {
        invalidateRepliesPending = false;
        void queryClient.invalidateQueries({ queryKey: SUPPORT_REPLIES_QUERY_PREFIX });
      }
    };

    const scheduleInvalidation = (target: 'tickets' | 'replies') => {
      if (disposed) {
        return;
      }
      invalidateTicketsPending = true;
      if (target === 'replies') {
        invalidateRepliesPending = true;
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(flushInvalidations, REALTIME_COALESCE_MS);
    };

    const channel = client
      .channel(REALTIME_CHANNEL)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, () =>
        scheduleInvalidation('tickets'),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ticket_replies' }, () =>
        scheduleInvalidation('replies'),
      )
      .subscribe((status) => {
        if (disposed) {
          return;
        }
        const channelStatus = String(status);
        const next: RealtimeState =
          channelStatus === 'SUBSCRIBED'
            ? 'live'
            : channelStatus === 'TIMED_OUT' ||
                channelStatus === 'CHANNEL_ERROR' ||
                channelStatus === 'CLOSED'
              ? 'offline'
              : 'connecting';
        realtimeStateRef.current = next;
        setRealtimeState(next);
      });

    return () => {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      void client.removeChannel(channel);
    };
  }, [queryClient]);

  /* Fallback when returning to tab while live socket is offline. */
  useEffect(() => {
    const client = getSupabase();
    if (client === null || typeof document === 'undefined') {
      return;
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && realtimeStateRef.current !== 'live') {
        void queryClient.invalidateQueries({ queryKey: SUPPORT_TICKETS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: SUPPORT_REPLIES_QUERY_PREFIX });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [queryClient]);

  const selectTicket = useCallback((ticketId: string | null) => {
    setSelectedTicketId(ticketId);
  }, []);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: SUPPORT_TICKETS_QUERY_KEY });
    if (activeTicketId !== null) {
      void queryClient.invalidateQueries({ queryKey: supportRepliesQueryKey(activeTicketId) });
    }
  }, [queryClient, activeTicketId]);

  const createTicket = useCallback(
    async (input: CreateTicketInput): Promise<CreateTicketResult> => {
      const client = getSupabase();
      if (client === null) {
        return { ok: false, code: 'unavailable' };
      }
      if (!actorIsActive) {
        return { ok: false, code: 'forbidden' };
      }

      const validationError = validateCreateTicketInput(input);
      if (validationError !== null) {
        return { ok: false, code: validationError };
      }

      const lockKey = 'create-ticket';
      if (inFlightRef.current.has(lockKey)) {
        return { ok: false, code: 'in-flight' };
      }

      inFlightRef.current.add(lockKey);
      setIsCreatingTicket(true);
      try {
        const { data, error } = (await client.rpc('create_support_ticket', {
          p_subject: input.subject.trim(),
          p_description: input.description.trim(),
          p_priority: input.priority,
        })) as RpcResult;

        if (error !== null) {
          return { ok: false, code: mapSupportPostgrestError(error).code };
        }

        const ticketId = isRecord(data) ? asString(data['id']) : '';
        const ticketNumber = isRecord(data) ? asNumber(data['ticket_number'], 0) : 0;

        await queryClient.invalidateQueries({ queryKey: SUPPORT_TICKETS_QUERY_KEY });
        if (ticketId !== '') {
          setSelectedTicketId(ticketId);
        }

        return { ok: true, ticketId, ticketNumber };
      } catch (caught) {
        return { ok: false, code: toSupportErrorCode(caught) };
      } finally {
        inFlightRef.current.delete(lockKey);
        setIsCreatingTicket(false);
      }
    },
    [actorIsActive, queryClient],
  );

  const addReply = useCallback(
    async (ticketId: string, body: string): Promise<AddReplyResult> => {
      const client = getSupabase();
      if (client === null) {
        return { ok: false, ticketId, code: 'unavailable' };
      }
      if (!actorIsActive) {
        return { ok: false, ticketId, code: 'forbidden' };
      }

      const cachedTickets =
        queryClient.getQueryData<SupportTicket[]>(SUPPORT_TICKETS_QUERY_KEY) ?? tickets;
      const targetTicket = cachedTickets.find((entry) => entry.id === ticketId);
      const validationError = validateReplyBody(targetTicket, body);
      if (validationError !== null) {
        return { ok: false, ticketId, code: validationError };
      }

      const lockKey = `reply:${ticketId}`;
      if (inFlightRef.current.has(lockKey)) {
        return { ok: false, ticketId, code: 'in-flight' };
      }

      inFlightRef.current.add(lockKey);
      setIsSendingReply(true);
      try {
        const { data, error } = (await client.rpc('add_ticket_reply', {
          p_ticket_id: ticketId,
          p_body: body.trim(),
        })) as RpcResult;

        if (error !== null) {
          return { ok: false, ticketId, code: mapSupportPostgrestError(error).code };
        }

        const replyId = isRecord(data) ? asString(data['id']) : '';

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: SUPPORT_TICKETS_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: supportRepliesQueryKey(ticketId) }),
        ]);

        return { ok: true, ticketId, replyId };
      } catch (caught) {
        return { ok: false, ticketId, code: toSupportErrorCode(caught) };
      } finally {
        inFlightRef.current.delete(lockKey);
        setIsSendingReply(false);
      }
    },
    [actorIsActive, queryClient, tickets],
  );

  const updateTicketStatus = useCallback(
    async (
      ticketId: string,
      status: TicketStatus,
      priority?: TicketPriority,
    ): Promise<UpdateTicketStatusResult> => {
      const client = getSupabase();
      if (client === null) {
        return { ok: false, ticketId, code: 'unavailable' };
      }

      const cachedTickets =
        queryClient.getQueryData<SupportTicket[]>(SUPPORT_TICKETS_QUERY_KEY) ?? tickets;
      const targetTicket = cachedTickets.find((entry) => entry.id === ticketId);
      const effectivePriority = priority ?? targetTicket?.priority ?? 'medium';

      const blocker = getStatusUpdateBlocker({
        ticket: targetTicket,
        actorIsSupportAgent,
        nextStatus: status,
        nextPriority: effectivePriority,
      });
      if (blocker !== null) {
        return { ok: false, ticketId, code: blocker };
      }

      const lockKey = `status:${ticketId}`;
      if (inFlightRef.current.has(lockKey)) {
        return { ok: false, ticketId, code: 'in-flight' };
      }

      inFlightRef.current.add(lockKey);
      setIsUpdatingStatus(true);
      try {
        const { error } = (await client.rpc('update_ticket_status', {
          p_ticket_id: ticketId,
          p_status: status,
          p_priority: effectivePriority,
        })) as RpcResult;

        if (error !== null) {
          return { ok: false, ticketId, code: mapSupportPostgrestError(error).code };
        }

        await queryClient.invalidateQueries({ queryKey: SUPPORT_TICKETS_QUERY_KEY });
        return {
          ok: true,
          ticketId,
          status,
          priority: effectivePriority,
        };
      } catch (caught) {
        return { ok: false, ticketId, code: toSupportErrorCode(caught) };
      } finally {
        inFlightRef.current.delete(lockKey);
        setIsUpdatingStatus(false);
      }
    },
    [actorIsSupportAgent, queryClient, tickets],
  );

  return {
    tickets,
    replies,
    selectedTicket,
    selectTicket,
    actorId,
    actorIsActive,
    actorIsSupportAgent,
    actorIsSuperAdmin,
    isInitialLoading: ticketsQuery.isPending,
    isRefreshing: ticketsQuery.isFetching && !ticketsQuery.isPending,
    isLoadingReplies: activeTicketId !== null && repliesQuery.isPending,
    fetchError:
      ticketsQuery.error === null
        ? null
        : ticketsQuery.error instanceof SupportManagementError
          ? ticketsQuery.error.code
          : 'unknown',
    repliesError:
      repliesQuery.error === null
        ? null
        : repliesQuery.error instanceof SupportManagementError
          ? repliesQuery.error.code
          : 'unknown',
    lastSyncedAt: ticketsQuery.dataUpdatedAt > 0 ? ticketsQuery.dataUpdatedAt : null,
    realtimeState,
    isCreatingTicket,
    isSendingReply,
    isUpdatingStatus,
    refresh,
    createTicket,
    addReply,
    updateTicketStatus,
  };
}
