import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { PostgrestError } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';

/**
 * Notification carrier read hook (Phase 3.1).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §1.2.1: Typed carrier columns (`host`, `port`, `tls_mode`, `sender_name`, `sender_email`, `username`, `is_enabled`).
 * - §1.3 & §1.8: `admin_get_email_transport` returns a MASKED snapshot only (`has_password` boolean + 8-char `fingerprint`).
 * - §3.4: Value-free normalized error codes (`42501`, `22023`, `MAIL01..MAIL04`, `SEC01`).
 * - §3.6.3: Password is write-only; plaintext and ciphertext never enter the client or TanStack Query cache.
 * - §3.6.4: Query key `['notification-transports']` with non-zero `staleTime` to avoid settings flicker.
 */

export const NOTIFICATION_TRANSPORT_QUERY_KEY = ['notification-transports'] as const;

export type TlsMode = 'starttls' | 'implicit_tls' | 'none';
export type AuthMode = 'login' | 'plain' | 'xoauth2' | 'none';

export type TransportErrorCode =
  | 'UNAVAILABLE'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'MAIL01'
  | 'MAIL02'
  | 'MAIL03'
  | 'MAIL04'
  | 'SEC01'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'UNKNOWN';

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly field: string | null;

  constructor(code: TransportErrorCode, field: string | null = null) {
    // §3.4: Never include raw user input or database constraint values in error messages.
    super(code);
    this.code = code;
    this.field = field;
    this.name = 'TransportError';
  }
}

/**
 * §1.8 & §3.6.3: Masked carrier snapshot returned by `admin_get_email_transport`.
 * Secrets are strictly write-only: only `has_password`, an 8-char `fingerprint`,
 * `secrets_version`, and `updated_at` are exposed to the client.
 */
export interface NotificationTransportSnapshot {
  readonly id: string;
  readonly slug: string;
  readonly provider_type: string;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly sender_email: string;
  readonly sender_name: string;
  readonly reply_to_email: string | null;
  readonly tls_mode: TlsMode;
  readonly auth_mode: AuthMode;
  readonly is_enabled: boolean;
  readonly is_default: boolean;
  readonly max_recipients_per_message: number;
  readonly daily_quota: number;
  readonly throttle_per_minute: number;
  readonly timeout_ms: number;
  readonly retry_max_attempts: number;
  readonly retry_backoff_ms: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly last_test_status: string | null;
  readonly last_test_at: string | null;
  readonly last_test_detail: string | null;
  readonly secrets_version: number;
  // §3.6.3: Write-only secret metadata — never plaintext or ciphertext.
  readonly has_password: boolean;
  readonly fingerprint: string | null;
  readonly key_version: number | null;
  readonly key_source: string | null;
  readonly tls_insecure: boolean;
  readonly warnings: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTlsMode(value: unknown): value is TlsMode {
  return value === 'starttls' || value === 'implicit_tls' || value === 'none';
}

function isAuthMode(value: unknown): value is AuthMode {
  return value === 'login' || value === 'plain' || value === 'xoauth2' || value === 'none';
}

/**
 * §1.8 & §3.6.3: Sanitize and parse the masked snapshot from `admin_get_email_transport`.
 * Ensures no secret field can ever leak into the returned object and caps `fingerprint`
 * to its first 8 hex characters.
 */
export function parseTransportSnapshot(raw: unknown): NotificationTransportSnapshot | null {
  if (!isRecord(raw)) {
    return null;
  }

  const host = typeof raw.host === 'string' ? raw.host : null;
  const senderEmail = typeof raw.sender_email === 'string' ? raw.sender_email : null;
  const senderName = typeof raw.sender_name === 'string' ? raw.sender_name : null;

  if (host === null || senderEmail === null || senderName === null) {
    return null;
  }

  const rawFingerprint =
    typeof raw.fingerprint === 'string' && raw.fingerprint.trim().length > 0
      ? raw.fingerprint.trim().slice(0, 8)
      : null;

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    id: typeof raw.id === 'string' ? raw.id : 'default-smtp',
    slug: typeof raw.slug === 'string' ? raw.slug : 'default-smtp',
    provider_type: typeof raw.provider_type === 'string' ? raw.provider_type : 'smtp_generic',
    host,
    port: typeof raw.port === 'number' && Number.isFinite(raw.port) ? raw.port : 587,
    username: typeof raw.username === 'string' ? raw.username : null,
    sender_email: senderEmail,
    sender_name: senderName,
    reply_to_email: typeof raw.reply_to_email === 'string' ? raw.reply_to_email : null,
    tls_mode: isTlsMode(raw.tls_mode) ? raw.tls_mode : 'starttls',
    auth_mode: isAuthMode(raw.auth_mode) ? raw.auth_mode : 'login',
    is_enabled: raw.is_enabled === true,
    is_default: raw.is_default !== false,
    max_recipients_per_message:
      typeof raw.max_recipients_per_message === 'number' ? raw.max_recipients_per_message : 50,
    daily_quota: typeof raw.daily_quota === 'number' ? raw.daily_quota : 200,
    throttle_per_minute: typeof raw.throttle_per_minute === 'number' ? raw.throttle_per_minute : 30,
    timeout_ms: typeof raw.timeout_ms === 'number' ? raw.timeout_ms : 10000,
    retry_max_attempts: typeof raw.retry_max_attempts === 'number' ? raw.retry_max_attempts : 3,
    retry_backoff_ms: typeof raw.retry_backoff_ms === 'number' ? raw.retry_backoff_ms : 5000,
    config: isRecord(raw.config) ? raw.config : {},
    last_test_status: typeof raw.last_test_status === 'string' ? raw.last_test_status : null,
    last_test_at: typeof raw.last_test_at === 'string' ? raw.last_test_at : null,
    last_test_detail: typeof raw.last_test_detail === 'string' ? raw.last_test_detail : null,
    secrets_version: typeof raw.secrets_version === 'number' ? raw.secrets_version : 0,
    has_password: raw.has_password === true,
    fingerprint: rawFingerprint,
    key_version: typeof raw.key_version === 'number' ? raw.key_version : null,
    key_source: typeof raw.key_source === 'string' ? raw.key_source : null,
    tls_insecure: raw.tls_insecure === true || raw.tls_mode === 'none',
    warnings,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '1970-01-01T00:00:00Z',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '1970-01-01T00:00:00Z',
  };
}

export function fallbackTransportSnapshot(): NotificationTransportSnapshot {
  return {
    id: 'default-smtp',
    slug: 'default-smtp',
    provider_type: 'smtp_generic',
    host: 'localhost',
    port: 587,
    username: null,
    sender_email: 'no-reply@example.invalid',
    sender_name: 'نظام الإدارة',
    reply_to_email: null,
    tls_mode: 'starttls',
    auth_mode: 'login',
    is_enabled: false,
    is_default: true,
    max_recipients_per_message: 50,
    daily_quota: 200,
    throttle_per_minute: 30,
    timeout_ms: 10000,
    retry_max_attempts: 3,
    retry_backoff_ms: 5000,
    config: {},
    last_test_status: null,
    last_test_at: null,
    last_test_detail: null,
    secrets_version: 0,
    has_password: false,
    fingerprint: null,
    key_version: 1,
    key_source: null,
    tls_insecure: false,
    warnings: ['disabled'],
    created_at: '1970-01-01T00:00:00Z',
    updated_at: '1970-01-01T00:00:00Z',
  };
}

/**
 * §3.4: Map PostgREST / PostgreSQL error codes into normalized, value-free codes.
 */
export function toTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const pg = error as Partial<PostgrestError> & { status?: number; message?: string };
  const code = pg.code ?? '';
  const message = pg.message ?? '';
  const detail = pg.details ?? '';
  const fieldMatch = /field:\s*([a-z0-9_]+)/i.exec(detail);
  const field = fieldMatch?.[1] ?? null;

  if (code === '42501') {
    return new TransportError('FORBIDDEN', field);
  }
  if (code === '22023') {
    return new TransportError('VALIDATION', field);
  }
  if (code === 'MAIL1' || message.includes('MAIL01')) {
    return new TransportError('MAIL01', field);
  }
  if (code === 'MAIL2' || message.includes('MAIL02')) {
    return new TransportError('MAIL02', field);
  }
  if (code === 'MAIL3' || message.includes('MAIL03')) {
    return new TransportError('MAIL03', field);
  }
  if (code === 'MAIL4' || message.includes('MAIL04')) {
    return new TransportError('MAIL04', field);
  }
  if (code === 'SEC01' || message.includes('SEC01')) {
    return new TransportError('SEC01', field);
  }
  if (code === 'P0002' || code === 'PGRST116' || pg.status === 404) {
    return new TransportError('NOT_FOUND', field);
  }
  if (
    error instanceof TypeError ||
    message.toLowerCase().includes('fetch') ||
    message.toLowerCase().includes('network')
  ) {
    return new TransportError('NETWORK', field);
  }
  return new TransportError('UNKNOWN', field);
}

export interface UseNotificationTransportOptions {
  readonly enabled?: boolean;
}

export type UseNotificationTransportResult = UseQueryResult<
  NotificationTransportSnapshot,
  TransportError
> & {
  readonly transport: NotificationTransportSnapshot | null;
};

/**
 * §1.8 & §3.6.4: Queries `admin_get_email_transport` to retrieve the masked carrier snapshot.
 */
export function useNotificationTransport(
  options?: UseNotificationTransportOptions,
): UseNotificationTransportResult {
  const query = useQuery<NotificationTransportSnapshot, TransportError>({
    queryKey: NOTIFICATION_TRANSPORT_QUERY_KEY,
    enabled: options?.enabled ?? true,
    // §3.6.4: Never use staleTime: 0 on settings tables (prevents redundant fetches and UI flicker).
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<NotificationTransportSnapshot> => {
      const client = getSupabase();
      if (client === null) {
        throw new TransportError('UNAVAILABLE');
      }
      const response: { data: unknown; error: PostgrestError | null } = await client.rpc(
        'admin_get_email_transport',
      );
      if (response.error !== null) {
        throw toTransportError(response.error);
      }
      const parsed = parseTransportSnapshot(response.data);
      if (parsed === null) {
        throw new TransportError('UNKNOWN');
      }
      return parsed;
    },
  });

  return {
    ...query,
    transport: query.data ?? null,
  };
}
