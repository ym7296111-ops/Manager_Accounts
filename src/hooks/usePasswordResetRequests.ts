import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import type { PostgrestError } from '@supabase/supabase-js';
import type { TranslationKey } from '@/i18n/I18nContext';
import { getSupabase } from '@/lib/supabase';

/**
 * Password Reset Requests data layer (manual approval flow).
 *
 * * The queue is read only through `password_reset_requests_safe`, whose four
 *   columns exclude all credential data and whose predicate permits only
 *   owner/super_admin or `password_reset.manage` holders.
 * * Approve/reject go through `admin-reset-password`, which verifies the JWT
 *   and re-checks the capability in SQL. Approval generates a one-time
 *   temporary password server-side, writes it directly to GoTrue (neither the
 *   table nor an RPC receives it), and returns it exactly once for
 *   `PasswordRevealDialog`.
 * * Every failure is normalized to a locale-independent code that maps onto
 *   the bilingual dictionary; nothing here returns prose.
 */

/* ------------------------------------------------------------------ types */

/** Mirrors `password_reset_requests.status`. */
export type PasswordResetRequestStatus =
  'awaiting_password' | 'pending_approval' | 'approved' | 'rejected';

/** Queue filter of the screen (pending is the actionable default). */
export type PasswordResetFilter = 'pending' | 'processed' | 'all';

/** Domain view model for one queue row. */
export interface PasswordResetRequestRow {
  readonly id: string;
  readonly email: string;
  readonly status: PasswordResetRequestStatus;
  readonly createdAt: string;
}

/** Normalized, locale-independent failure codes for the whole screen. */
export type PasswordResetErrorCode =
  | 'unavailable'
  | 'not-deployed'
  | 'forbidden'
  | 'not-found'
  | 'user-not-found'
  | 'invalid-transition'
  | 'password-rejected'
  | 'update-failed'
  | 'in-flight'
  | 'rate-limited'
  | 'network'
  | 'unknown';

/**
 * Result of `approveRequest` / `rejectRequest` — a discriminated union;
 * nothing is thrown.
 */
export type ProcessPasswordResetResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly status: PasswordResetRequestStatus;
      /** One-time generated password (approve only). In memory only: hand it
       *  to `PasswordRevealDialog` and drop it; never cached or persisted. */
      readonly tempPassword?: string;
    }
  | { readonly ok: false; readonly requestId: string; readonly code: PasswordResetErrorCode };

/* -------------------------------------------------------- dictionary keys */

/** Every failure code → its bilingual dictionary key. */
export const PASSWORD_RESET_ERROR_KEYS: Record<PasswordResetErrorCode, TranslationKey> = {
  unavailable: 'passwordResets.error.unavailable',
  'not-deployed': 'passwordResets.error.notDeployed',
  forbidden: 'passwordResets.error.forbidden',
  'not-found': 'passwordResets.error.notFound',
  'user-not-found': 'passwordResets.error.userNotFound',
  'invalid-transition': 'passwordResets.error.invalidTransition',
  'password-rejected': 'passwordResets.error.passwordRejected',
  'update-failed': 'passwordResets.error.updateFailed',
  'in-flight': 'passwordResets.error.inFlight',
  'rate-limited': 'passwordResets.error.rateLimited',
  network: 'passwordResets.error.network',
  unknown: 'passwordResets.error.unknown',
};

/* ------------------------------------------------------------- constants */

/** The single cache key prefix for the screen. */
export const PASSWORD_RESETS_QUERY_KEY = ['password-reset-requests'] as const;

/** The cap matches PostgREST's default max-rows; the queue is short-lived. */
const REQUESTS_MAX_ROWS = 1000;

/** The safe view is the only queue read surface; it exposes four fields. */
const REQUEST_COLUMNS = 'id, email, status, created_at';

const EMPTY_REQUESTS: readonly PasswordResetRequestRow[] = [];

/* ------------------------------------------------------------ error model */

/** Internal error carrying a normalized code; raw Supabase errors never leave this module. */
export class PasswordResetError extends Error {
  readonly code: PasswordResetErrorCode;

  constructor(code: PasswordResetErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PasswordResetError';
    this.code = code;
  }
}

function mapPostgrestError(error: {
  readonly code: string;
  readonly message: string;
}): PasswordResetError {
  const message = error.message.toLowerCase();

  if (error.code === '42501' || error.code === 'PGRST301' || message.includes('jwt')) {
    return new PasswordResetError('forbidden');
  }
  if (
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    message.includes('schema cache') ||
    message.includes('could not find the table')
  ) {
    return new PasswordResetError('not-deployed');
  }
  if (message.includes('rate limit') || message.includes('too many')) {
    return new PasswordResetError('rate-limited');
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return new PasswordResetError('network');
  }
  return new PasswordResetError('unknown');
}

function toErrorCode(caught: unknown): PasswordResetErrorCode {
  if (caught instanceof PasswordResetError) {
    return caught.code;
  }
  if (caught instanceof TypeError) {
    return 'network';
  }
  return 'unknown';
}

/**
 * The Edge Function answers failures as a machine code in the response body
 * (`{ error: 'permission_denied' }`), not as PostgREST errors:
 *
 * | wire code              | code               |
 * | ---------------------- | ------------------ |
 * | permission_denied      | forbidden          |
 * | not_found              | not-found          |
 * | user_not_found         | user-not-found     |
 * | invalid_transition     | invalid-transition |
 * | password_rejected      | password-rejected  |
 * | password_update_failed | update-failed      |
 * | claim_invalid          | update-failed      |
 * | invalid_action/unknown | unknown            |
 *
 * A 404 without a JSON body means the function itself is not deployed yet
 * (`Function not found`) — an operator problem, mapped to `not-deployed`.
 */
const INVOKE_WIRE_CODES: Readonly<Record<string, PasswordResetErrorCode>> = {
  permission_denied: 'forbidden',
  owner_protection: 'forbidden',
  not_found: 'not-found',
  user_not_found: 'user-not-found',
  invalid_transition: 'invalid-transition',
  password_rejected: 'password-rejected',
  password_update_failed: 'update-failed',
  claim_invalid: 'update-failed',
  invalid_action: 'unknown',
  unknown: 'unknown',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Best-effort read of the Edge Function's failure body + HTTP status. */
async function readInvokeFailure(
  caught: unknown,
): Promise<{ readonly status: number | null; readonly code: string; readonly message: string }> {
  const context: unknown = isRecord(caught) ? caught['context'] : undefined;
  if (!isRecord(context)) {
    return { status: null, code: '', message: '' };
  }
  const status = typeof context['status'] === 'number' ? context['status'] : null;
  const json: unknown = context['json'];
  if (typeof json !== 'function') {
    return { status, code: '', message: '' };
  }
  try {
    const body: unknown = await (json as () => Promise<unknown>).call(context);
    if (!isRecord(body)) {
      return { status, code: '', message: '' };
    }
    const rawError: unknown = body['error'];
    const code: string =
      typeof rawError === 'string'
        ? rawError
        : isRecord(rawError) && typeof rawError['code'] === 'string'
          ? rawError['code']
          : typeof body['code'] === 'string'
            ? body['code']
            : '';
    const message: string = typeof body['message'] === 'string' ? body['message'] : code;
    return { status, code, message };
  } catch {
    return { status, code: '', message: '' };
  }
}

/** Classify an `admin-reset-password` invoke failure. */
async function mapInvokeError(caught: unknown): Promise<PasswordResetErrorCode> {
  const parsed = await readInvokeFailure(caught);
  const wire = INVOKE_WIRE_CODES[parsed.code];
  if (wire !== undefined) {
    return wire;
  }
  if (parsed.status === 404) {
    return 'not-deployed';
  }
  if (parsed.code !== '' || parsed.message !== '') {
    return mapPostgrestError({ code: parsed.code, message: parsed.message }).code;
  }
  /* supabase-js throws typed errors before/around the HTTP exchange:
     FunctionsFetchError = the call never reached the edge,
     FunctionsRelayError = the relay refused it (rate limits included). */
  const name = caught instanceof Error ? caught.name : '';
  if (name === 'FunctionsFetchError') {
    return 'network';
  }
  if (name === 'FunctionsRelayError') {
    const message = caught instanceof Error ? caught.message.toLowerCase() : '';
    return message.includes('rate limit') || message.includes('too many')
      ? 'rate-limited'
      : 'network';
  }
  return toErrorCode(caught);
}

/* ------------------------------------------------------- runtime parsing */

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function parseRow(value: unknown): PasswordResetRequestRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const rawStatus = value['status'];
  const status: PasswordResetRequestStatus =
    rawStatus === 'awaiting_password' || rawStatus === 'approved' || rawStatus === 'rejected'
      ? rawStatus
      : 'pending_approval';
  return {
    id: asString(value['id']),
    email: asString(value['email']),
    status,
    createdAt: asString(value['created_at']),
  };
}

function parseRows(data: unknown): PasswordResetRequestRow[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const rows: PasswordResetRequestRow[] = [];
  for (const entry of data) {
    const row = parseRow(entry);
    if (row !== null && row.id !== '') {
      rows.push(row);
    }
  }
  /* Deterministic order (newest first, id as tie-breaker) keeps refetches
     from re-shuffling the queue the admin is already reading. */
  rows.sort((a, b) => {
    const byDate = b.createdAt.localeCompare(a.createdAt);
    return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
  });
  return rows;
}

/* ---------------------------------------------------------------- fetch */

interface QueryResult {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

async function fetchRequests(filter: PasswordResetFilter): Promise<PasswordResetRequestRow[]> {
  const client = getSupabase();
  if (client === null) {
    throw new PasswordResetError('unavailable');
  }

  try {
    /* The safe view is the only authenticated read surface. */
    let request = client.from('password_reset_requests_safe').select(REQUEST_COLUMNS);
    if (filter === 'pending') {
      request = request.in('status', ['pending_approval', 'awaiting_password']);
    } else if (filter === 'processed') {
      request = request.in('status', ['approved', 'rejected']);
    }
    const { data, error } = (await request
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(0, REQUESTS_MAX_ROWS - 1)) as QueryResult;

    if (error !== null) {
      throw mapPostgrestError(error);
    }
    return parseRows(data);
  } catch (caught) {
    if (caught instanceof PasswordResetError) {
      throw caught;
    }
    throw new PasswordResetError(toErrorCode(caught));
  }
}

/* ----------------------------------------------------------------- hook */

export interface PasswordResetRequestsApi {
  readonly requests: readonly PasswordResetRequestRow[];
  readonly statusFilter: PasswordResetFilter;
  readonly setStatusFilter: (value: PasswordResetFilter) => void;
  /** Approve: the Edge Function generates the one-time password and returns
   *  it once on the success result (`tempPassword`). */
  readonly approveRequest: (requestId: string) => Promise<ProcessPasswordResetResult>;
  /** Reject a pending request: no password is read or written. */
  readonly rejectRequest: (requestId: string) => Promise<ProcessPasswordResetResult>;
  readonly pendingRequestId: string | null;
  readonly isInitialLoading: boolean;
  readonly isRefreshing: boolean;
  readonly fetchError: PasswordResetErrorCode | null;
  readonly lastSyncedAt: number | null;
  readonly refresh: () => void;
}

export function usePasswordResetRequests(): PasswordResetRequestsApi {
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<PasswordResetFilter>('pending');
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const inFlightRef = useRef<Set<string>>(new Set());

  const query = useQuery({
    queryKey: [...PASSWORD_RESETS_QUERY_KEY, statusFilter],
    queryFn: () => fetchRequests(statusFilter),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    /* Auto-retry with backoff for transient network failures only. */
    retry: (failureCount, error) =>
      error instanceof PasswordResetError && error.code === 'network' && failureCount < 2,
  });

  const requests = query.data ?? EMPTY_REQUESTS;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: PASSWORD_RESETS_QUERY_KEY });
  }, [queryClient]);

  const processRequest = useCallback(
    async (
      requestId: string,
      action: 'approve' | 'reject',
    ): Promise<ProcessPasswordResetResult> => {
      const client = getSupabase();
      if (client === null) {
        return { ok: false, requestId, code: 'unavailable' };
      }
      if (inFlightRef.current.has(requestId)) {
        return { ok: false, requestId, code: 'in-flight' };
      }

      inFlightRef.current.add(requestId);
      setPendingRequestId(requestId);
      try {
        /* The Edge Function re-verifies the JWT and capability, generates the
           password itself, and returns it once. No password is sent from here. */
        const body: Record<string, unknown> = { requestId, action };
        const response: { data?: unknown; error: unknown } = await client.functions.invoke(
          'admin-reset-password',
          { body },
        );
        if (response.error) {
          return { ok: false, requestId, code: await mapInvokeError(response.error) };
        }

        /* Server always wins: refetch the authoritative rows. */
        await queryClient.invalidateQueries({ queryKey: PASSWORD_RESETS_QUERY_KEY });
        const tempPassword =
          action === 'approve' && isRecord(response.data)
            ? asString(response.data['tempPassword'])
            : '';
        return {
          ok: true,
          requestId,
          status: action === 'approve' ? 'approved' : 'rejected',
          ...(tempPassword !== '' ? { tempPassword } : {}),
        };
      } catch (caught) {
        return { ok: false, requestId, code: await mapInvokeError(caught) };
      } finally {
        inFlightRef.current.delete(requestId);
        setPendingRequestId(null);
      }
    },
    [queryClient],
  );

  const approveRequest = useCallback(
    (requestId: string) => processRequest(requestId, 'approve'),
    [processRequest],
  );
  const rejectRequest = useCallback(
    (requestId: string) => processRequest(requestId, 'reject'),
    [processRequest],
  );

  return {
    requests,
    statusFilter,
    setStatusFilter,
    approveRequest,
    rejectRequest,
    pendingRequestId,
    isInitialLoading: query.isPending,
    isRefreshing: query.isFetching && !query.isPending,
    fetchError:
      query.error === null
        ? null
        : query.error instanceof PasswordResetError
          ? query.error.code
          : 'unknown',
    lastSyncedAt: query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null,
    refresh,
  };
}
