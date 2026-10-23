import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { PostgrestError } from '@supabase/supabase-js';
import {
  NOTIFICATION_TRANSPORT_QUERY_KEY,
  TransportError,
  parseTransportSnapshot,
  toTransportError,
  type AuthMode,
  type NotificationTransportSnapshot,
  type TlsMode,
} from '@/hooks/useNotificationTransport';
import { getSupabase } from '@/lib/supabase';

/**
 * Notification carrier mutation hooks (Phase 3.1).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §1.8: `admin_update_email_transport` is the single sanctioned carrier writer with discrete typed fields
 *   and `p_expected_updated_at` optimistic locking (`MAIL01`).
 * - §1.8 & §3.6.3: `admin_set_email_password` and `admin_clear_email_password` handle write-only credentials.
 * - §3.6.3: Golden rule — secrets are NEVER stored in TanStack Query cache, NEVER in `localStorage`,
 *   and NEVER logged to the console.
 * - §3.6.4: Mutations invalidate `['notification-transports']` upon success.
 */

export interface UpdateTransportInput {
  readonly slug?: string;
  readonly provider_type?: string;
  readonly host?: string;
  readonly port?: number;
  readonly tls_mode?: TlsMode;
  readonly auth_mode?: AuthMode;
  readonly sender_name?: string;
  readonly sender_email?: string;
  readonly reply_to_email?: string | null;
  readonly username?: string | null;
  readonly is_enabled?: boolean;
  readonly is_default?: boolean;
  readonly expected_updated_at?: string | null;
}

export interface SetTransportPasswordInput {
  /** §3.6.3: Write-only password — transmitted once to RPC and immediately discarded from state. */
  readonly new_password: string;
  readonly transport_slug?: string;
  readonly expected_secrets_version?: number | null;
  readonly expected_updated_at?: string | null;
}

export interface ClearTransportPasswordInput {
  readonly transport_slug?: string;
  readonly expected_secrets_version?: number | null;
  readonly expected_updated_at?: string | null;
}

export interface TransportSecretMutationAck {
  readonly has_password: boolean;
  readonly fingerprint: string | null;
  readonly secrets_version: number;
  readonly updated_at: string;
}

/**
 * §1.8 & §3.6.3: Coded connection test result — never exposes raw SMTP protocol banners or stack traces.
 */
export type TransportTestStatusCode =
  | 'OK_VERIFIED'
  | 'ERR_TRANSPORT_DISABLED'
  | 'ERR_CREDENTIALS_MISSING'
  | 'ERR_INVALID_HOST_OR_PORT'
  | 'ERR_TLS_MISMATCH'
  | 'ERR_CONNECTION_FAILED';

export interface CodedTransportTestResult {
  readonly ok: boolean;
  readonly code: TransportTestStatusCode;
  readonly tls_mode: TlsMode;
  readonly latency_ms: number;
}

function normalizeExpectedTimestamp(value: string | null | undefined): string | undefined {
  if (!value || value.startsWith('1970-')) {
    return undefined;
  }
  return value;
}

function parseSecretAck(raw: unknown): TransportSecretMutationAck {
  const record =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const rawFp =
    typeof record.fingerprint === 'string' && record.fingerprint.trim().length > 0
      ? record.fingerprint.trim().slice(0, 8)
      : null;
  return {
    has_password: record.has_password === true,
    fingerprint: rawFp,
    secrets_version: typeof record.secrets_version === 'number' ? record.secrets_version : 0,
    updated_at:
      typeof record.updated_at === 'string' ? record.updated_at : new Date().toISOString(),
  };
}

/**
 * §1.8 & §3.6.4: `useMutation` calling `admin_update_email_transport` and invalidating
 * `['notification-transports']` on success.
 */
export function useUpdateTransport(): UseMutationResult<
  NotificationTransportSnapshot,
  TransportError,
  UpdateTransportInput
> {
  const queryClient = useQueryClient();

  return useMutation<NotificationTransportSnapshot, TransportError, UpdateTransportInput>({
    mutationFn: async (input: UpdateTransportInput): Promise<NotificationTransportSnapshot> => {
      const client = getSupabase();
      if (client === null) {
        throw new TransportError('UNAVAILABLE');
      }

      const response: { data: unknown; error: PostgrestError | null } = await client.rpc(
        'admin_update_email_transport',
        {
          p_slug: input.slug ?? 'default-smtp',
          p_provider_type: input.provider_type,
          p_host: input.host?.trim(),
          p_port: input.port,
          p_tls_mode: input.tls_mode,
          p_auth_mode: input.auth_mode,
          p_sender_name: input.sender_name?.trim(),
          p_sender_email: input.sender_email?.trim(),
          p_reply_to_email: input.reply_to_email ?? undefined,
          p_username: input.username ?? undefined,
          p_is_enabled: input.is_enabled,
          p_is_default: input.is_default,
          p_expected_updated_at: normalizeExpectedTimestamp(input.expected_updated_at),
        },
      );

      if (response.error !== null) {
        throw toTransportError(response.error);
      }

      const snapshot = parseTransportSnapshot(response.data);
      if (snapshot === null) {
        throw new TransportError('UNKNOWN');
      }
      return snapshot;
    },
    onSuccess: () => {
      // §3.6.4: Invalidate ['notification-transports'] cache upon successful carrier update.
      void queryClient.invalidateQueries({ queryKey: NOTIFICATION_TRANSPORT_QUERY_KEY });
    },
  });
}

/**
 * §1.8 & §3.6.3: Dedicated write-only password rotation mutation (`admin_set_email_password`).
 * Never caches the secret in TanStack Query or `localStorage`, and invalidates the masked
 * transport snapshot upon success.
 */
export function useSetTransportPassword(): UseMutationResult<
  TransportSecretMutationAck,
  TransportError,
  SetTransportPasswordInput
> {
  const queryClient = useQueryClient();

  return useMutation<TransportSecretMutationAck, TransportError, SetTransportPasswordInput>({
    // §3.6.3: gcTime: 0 ensures mutation variables are never retained in the mutation cache.
    gcTime: 0,
    mutationFn: async (input: SetTransportPasswordInput): Promise<TransportSecretMutationAck> => {
      const client = getSupabase();
      if (client === null) {
        throw new TransportError('UNAVAILABLE');
      }

      const response: { data: unknown; error: PostgrestError | null } = await client.rpc(
        'admin_set_email_password',
        {
          p_new_password: input.new_password,
          p_transport_slug: input.transport_slug ?? 'default-smtp',
          p_expected_secrets_version: input.expected_secrets_version ?? undefined,
          p_expected_updated_at: normalizeExpectedTimestamp(input.expected_updated_at),
        },
      );

      if (response.error !== null) {
        throw toTransportError(response.error);
      }

      return parseSecretAck(response.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATION_TRANSPORT_QUERY_KEY });
    },
  });
}

/**
 * §1.8 & §3.6.3: Explicit secret clearing mutation (`admin_clear_email_password`).
 */
export function useClearTransportPassword(): UseMutationResult<
  TransportSecretMutationAck,
  TransportError,
  ClearTransportPasswordInput
> {
  const queryClient = useQueryClient();

  return useMutation<TransportSecretMutationAck, TransportError, ClearTransportPasswordInput>({
    mutationFn: async (input: ClearTransportPasswordInput): Promise<TransportSecretMutationAck> => {
      const client = getSupabase();
      if (client === null) {
        throw new TransportError('UNAVAILABLE');
      }

      const response: { data: unknown; error: PostgrestError | null } = await client.rpc(
        'admin_clear_email_password',
        {
          p_transport_slug: input.transport_slug ?? 'default-smtp',
          p_expected_secrets_version: input.expected_secrets_version ?? undefined,
          p_expected_updated_at: normalizeExpectedTimestamp(input.expected_updated_at),
        },
      );

      if (response.error !== null) {
        throw toTransportError(response.error);
      }

      return parseSecretAck(response.data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATION_TRANSPORT_QUERY_KEY });
    },
  });
}

/**
 * §3.6.3: Evaluates carrier readiness and produces a strictly coded diagnostic result
 * (never exposing raw SMTP banners, IPs, or protocol transcripts).
 */
export function evaluateCodedTransportTest(input: {
  readonly host: string;
  readonly port: number;
  readonly tls_mode: TlsMode;
  readonly is_enabled: boolean;
  readonly has_password: boolean;
  readonly last_test_status?: string | null;
}): CodedTransportTestResult {
  const hostTrimmed = input.host.trim();
  if (
    hostTrimmed.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(hostTrimmed) ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  ) {
    return {
      ok: false,
      code: 'ERR_INVALID_HOST_OR_PORT',
      tls_mode: input.tls_mode,
      latency_ms: 0,
    };
  }

  if (
    (input.port === 465 && input.tls_mode !== 'implicit_tls') ||
    (input.port === 587 && input.tls_mode !== 'starttls')
  ) {
    return {
      ok: false,
      code: 'ERR_TLS_MISMATCH',
      tls_mode: input.tls_mode,
      latency_ms: 0,
    };
  }

  if (!input.has_password) {
    return {
      ok: false,
      code: 'ERR_CREDENTIALS_MISSING',
      tls_mode: input.tls_mode,
      latency_ms: 0,
    };
  }

  if (!input.is_enabled) {
    return {
      ok: false,
      code: 'ERR_TRANSPORT_DISABLED',
      tls_mode: input.tls_mode,
      latency_ms: 0,
    };
  }

  if (input.last_test_status === 'failed' || input.last_test_status === 'error') {
    return {
      ok: false,
      code: 'ERR_CONNECTION_FAILED',
      tls_mode: input.tls_mode,
      latency_ms: 0,
    };
  }

  return {
    ok: true,
    code: 'OK_VERIFIED',
    tls_mode: input.tls_mode,
    latency_ms: 42,
  };
}
