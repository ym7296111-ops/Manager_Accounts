/**
 * Mail-Gateway Fetch/Deno Worker (task 4.3: real SMTP adapter + bounded synchronous retry loop).
 *
 * Study references:
 * - §1.5 Path B: `MAIL_MASTER_KEY` stays in the worker environment; ciphertext is decrypted only
 *   immediately before handing the credential to the provider adapter.
 * - §1.6(C4/C5/C11): service-role-only reads, no credential logging, reject insecure production TLS.
 * - §2.4 / §2.6 / §2.7: use the server-side single-pass tokenizer and active template version.
 * - §2.5(د): deliverability-aware sending (structured From/Reply-To, fixed text→html parts) and
 *   precise `latency_ms` reporting from the provider adapter.
 * - §2.9: persist one `notification_deliveries` row per request key. A completed row is replayed
 *   without rendering or invoking the adapter again; pending/failed rows are never auto-retried.
 * - Task 4.3 retry policy: one synchronous loop around the SMTP adapter, capped by configurable
 *   max attempts (`MAIL_MAX_SEND_ATTEMPTS`) with exponential backoff (`MAIL_RETRY_BACKOFF_MS`).
 *   Only `shouldRetry`-approved transient classes are retried. There is still no external queue,
 *   cron, or cross-request scheduling: the Worker window owns the whole attempt sequence.
 *
 * This module is a Fetch handler and self-registers when run directly in a Deno Worker runtime. It
 * is deliberately not imported by the browser application; it reads only runtime secrets.
 */

import {
  sendSmtpMessage,
  SmtpSendError,
  smtpMessageId,
  type SmtpMessage,
  type SmtpSendResult,
  type SmtpTransportConfig,
} from './adapters/smtp.ts';
import { decryptSecret, MailCryptoError, type CipherSuite } from './crypto.ts';
import {
  renderNotificationTemplate,
  TemplateRenderError,
  type NotificationTemplateForRendering,
  type TemplateVariableDefinition,
  type TemplateVariableType,
} from './tokenizer.ts';

interface RuntimeEnvironment {
  readonly Deno?: {
    readonly env?: {
      get(name: string): string | undefined;
    };
    readonly serve?: (handler: (request: Request) => Response | Promise<Response>) => unknown;
  };
  readonly process?: {
    readonly env?: Readonly<Record<string, string | undefined>>;
  };
}

interface GatewayEnvironment {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
}

interface MailGatewayPayload {
  readonly request_key: string;
  readonly template_key: string;
  readonly locale: 'ar' | 'en';
  readonly recipient: string;
  readonly variables: Readonly<Record<string, string>>;
}

interface TransportRow extends SmtpTransportConfig {
  readonly id: string;
  readonly slug: string;
  readonly is_enabled: boolean;
  readonly is_default: boolean;
}

interface SecretRow {
  readonly cipher: string;
  readonly secret_ciphertext: string;
  readonly nonce: string;
  readonly tag: string | null;
  readonly kms_key_id: string | null;
}

interface TemplateRow {
  readonly subject: string;
  readonly body_text: string | null;
  readonly body_html: string | null;
  readonly variables: unknown;
  readonly status: string;
  readonly channel: string;
  readonly is_current: boolean;
}

interface GatewayOutcome {
  readonly status: number;
  readonly body: Readonly<Record<string, string | boolean>>;
  readonly latency_ms?: number;
}

type DeliveryStatus = 'pending' | 'completed' | 'failed';

interface DeliveryRow {
  readonly request_key: string;
  readonly template_key: string;
  readonly locale: 'ar' | 'en';
  readonly recipient_email: string;
  readonly status: DeliveryStatus;
  readonly content_hash: string | null;
  readonly error_class: string | null;
  readonly latency_ms: number | null;
}

class GatewayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    // Value-free by design: never include request fields, provider details or credential material.
    super(code);
    this.code = code;
    this.status = status;
    this.name = 'GatewayError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/;
const RECIPIENT_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const EMAIL_VARIABLE_TYPES = new Set<TemplateVariableType>([
  'text',
  'url',
  'email',
  'int',
  'money',
  'datetime',
  'bool',
]);
const MAX_REQUEST_BYTES = 64 * 1024;
const RETRYABLE_ERROR_CLASSES = new Set<string>([
  'MAIL03',
  'DATABASE_UNAVAILABLE',
  'NETWORK_ERROR',
  'CONNECTION_ERROR',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

/** Decides which transient classes the synchronous retry loop may re-attempt. */
export function shouldRetry(errorClass: string | null): boolean {
  return errorClass !== null && RETRYABLE_ERROR_CLASSES.has(errorClass);
}

const DEFAULT_MAX_SEND_ATTEMPTS = 3;
const MAX_SEND_ATTEMPTS_LIMIT = 5;
const DEFAULT_BACKOFF_BASE_MS = 250;
const MAX_BACKOFF_MS = 30_000;

interface SendRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Retry budget comes from the execution environment only; malformed values fall back safely. */
function loadSendRetryPolicy(): SendRetryPolicy {
  return {
    maxAttempts: parseBoundedInteger(
      getRuntimeEnvironmentValue('MAIL_MAX_SEND_ATTEMPTS'),
      DEFAULT_MAX_SEND_ATTEMPTS,
      1,
      MAX_SEND_ATTEMPTS_LIMIT,
    ),
    backoffBaseMs: parseBoundedInteger(
      getRuntimeEnvironmentValue('MAIL_RETRY_BACKOFF_MS'),
      DEFAULT_BACKOFF_BASE_MS,
      0,
      60_000,
    ),
  };
}

/**
 * Exponential backoff before retrying after the n-th failed attempt (1-based): base, 2·base,
 * 4·base, … capped at a fixed ceiling so a request can never outlive the Worker window.
 */
export function calculateBackoff(attempts: number, baseMs = DEFAULT_BACKOFF_BASE_MS): number {
  const safeBase = Number.isFinite(baseMs) && baseMs >= 0 ? baseMs : DEFAULT_BACKOFF_BASE_MS;
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  return Math.min(safeBase * 2 ** exponent, MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getRuntimeEnvironmentValue(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & RuntimeEnvironment;
  try {
    const denoValue = runtime.Deno?.env?.get(name);
    if (denoValue !== undefined) {
      return denoValue;
    }
  } catch {
    // Restricted Deno environment permissions are reported as missing configuration below.
  }
  return runtime.process?.env?.[name];
}

function loadEnvironment(): GatewayEnvironment {
  const rawUrl = getRuntimeEnvironmentValue('SUPABASE_URL')?.trim();
  const serviceRoleKey = getRuntimeEnvironmentValue('SUPABASE_SERVICE_ROLE_KEY')?.trim();
  if (!rawUrl || !serviceRoleKey) {
    throw new GatewayError('GATEWAY_NOT_CONFIGURED', 503);
  }

  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(rawUrl);
  } catch {
    throw new GatewayError('GATEWAY_NOT_CONFIGURED', 503);
  }
  if (
    supabaseUrl.protocol !== 'https:' &&
    supabaseUrl.hostname !== 'localhost' &&
    supabaseUrl.hostname !== '127.0.0.1'
  ) {
    throw new GatewayError('GATEWAY_NOT_CONFIGURED', 503);
  }

  return { supabaseUrl: supabaseUrl.toString().replace(/\/$/, ''), serviceRoleKey };
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isAuthorized(request: Request, serviceRoleKey: string): boolean {
  const authorization = request.headers.get('authorization');
  if (authorization === null) {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match !== null && constantTimeEqual(match[1] ?? '', serviceRoleKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControlCharacters(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function isValidLocale(value: unknown): value is 'ar' | 'en' {
  return value === 'ar' || value === 'en';
}

function parsePayload(value: unknown): MailGatewayPayload {
  if (!isRecord(value)) {
    throw new GatewayError('INVALID_REQUEST', 400);
  }

  const requestKey = typeof value.request_key === 'string' ? value.request_key.trim() : '';
  const templateKey = typeof value.template_key === 'string' ? value.template_key.trim() : '';
  const locale = value.locale;
  const recipient = typeof value.recipient === 'string' ? value.recipient.trim() : '';
  if (
    !UUID_PATTERN.test(requestKey) ||
    !TEMPLATE_KEY_PATTERN.test(templateKey) ||
    !isValidLocale(locale) ||
    recipient.length > 320 ||
    !RECIPIENT_PATTERN.test(recipient) ||
    containsControlCharacters(recipient) ||
    !isRecord(value.variables)
  ) {
    throw new GatewayError('INVALID_REQUEST', 400);
  }

  const variables = Object.create(null) as Record<string, string>;
  const entries = Object.entries(value.variables);
  if (entries.length > 40) {
    throw new GatewayError('INVALID_REQUEST', 400);
  }
  for (const [name, variableValue] of entries) {
    if (name.length > 64 || typeof variableValue !== 'string' || variableValue.length > 40960) {
      throw new GatewayError('INVALID_REQUEST', 400);
    }
    variables[name] = variableValue;
  }

  return {
    request_key: requestKey.toLowerCase(),
    template_key: templateKey,
    locale,
    recipient,
    variables,
  };
}

function response(body: Readonly<Record<string, string | boolean>>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function failure(error: unknown, requestKey?: string): GatewayOutcome {
  let status = 500;
  let code = 'DELIVERY_FAILED';
  if (error instanceof GatewayError) {
    status = error.status;
    code = error.code;
  } else if (error instanceof TemplateRenderError) {
    status = error.code === 'HASH_UNAVAILABLE' ? 503 : 422;
    code = error.code;
  } else if (error instanceof MailCryptoError) {
    status = 503;
    code = 'MAIL_CRYPTO_UNAVAILABLE';
  } else if (error instanceof SmtpSendError) {
    // Upstream SMTP failure after the retry budget is exhausted; only the safe class crosses the
    // boundary (MAIL03 transient/connection, MAIL04 authentication, DELIVERY_FAILED permanent).
    status = 502;
    code = error.code;
  }

  return {
    status,
    body: {
      ok: false,
      code,
      ...(requestKey ? { request_key: requestKey } : {}),
    },
  };
}

async function readJsonRequest(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new GatewayError('INVALID_CONTENT_TYPE', 415);
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_REQUEST_BYTES) {
    throw new GatewayError('REQUEST_TOO_LARGE', 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    throw new GatewayError('INVALID_REQUEST', 400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
    throw new GatewayError('REQUEST_TOO_LARGE', 413);
  }
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new GatewayError('INVALID_REQUEST', 400);
  }
}

async function selectRows<T>(
  environment: GatewayEnvironment,
  table:
    | 'notification_transports'
    | 'notification_transport_secrets'
    | 'notification_templates'
    | 'notification_deliveries',
  query: URLSearchParams,
): Promise<T[]> {
  const url = new URL(`${environment.supabaseUrl}/rest/v1/${table}`);
  url.search = query.toString();

  let result: Response;
  try {
    result = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: environment.serviceRoleKey,
        authorization: `Bearer ${environment.serviceRoleKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GatewayError('DATABASE_UNAVAILABLE', 503);
  }
  if (!result.ok) {
    // PostgREST bodies can contain schema/provider details; never reflect them to the caller.
    throw new GatewayError('DATABASE_READ_FAILED', 503);
  }

  let data: unknown;
  try {
    data = await result.json();
  } catch {
    throw new GatewayError('DATABASE_READ_FAILED', 503);
  }
  if (!Array.isArray(data)) {
    throw new GatewayError('DATABASE_READ_FAILED', 503);
  }
  return data as T[];
}

/** Read and validate the durable record before rendering, decrypting, or invoking the adapter. */
async function selectDeliveryRecord(
  environment: GatewayEnvironment,
  requestKey: string,
): Promise<DeliveryRow | undefined> {
  const query = new URLSearchParams({
    select:
      'request_key,template_key,locale,recipient_email,status,content_hash,error_class,latency_ms',
    request_key: `eq.${requestKey}`,
    limit: '1',
  });
  const rows = await selectRows<unknown>(environment, 'notification_deliveries', query);
  if (rows.length === 0) {
    return undefined;
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !isRecord(row) ||
    row.request_key !== requestKey ||
    typeof row.template_key !== 'string' ||
    !isValidLocale(row.locale) ||
    typeof row.recipient_email !== 'string' ||
    !['pending', 'completed', 'failed'].includes(String(row.status)) ||
    (row.content_hash !== null && typeof row.content_hash !== 'string') ||
    (row.error_class !== null && typeof row.error_class !== 'string') ||
    (row.latency_ms !== null &&
      (!Number.isInteger(row.latency_ms) || typeof row.latency_ms !== 'number'))
  ) {
    throw new GatewayError('DELIVERY_LOG_READ_FAILED', 503);
  }

  return {
    request_key: row.request_key,
    template_key: row.template_key,
    locale: row.locale,
    recipient_email: row.recipient_email,
    status: row.status as DeliveryStatus,
    content_hash: row.content_hash,
    error_class: row.error_class,
    latency_ms: row.latency_ms,
  };
}

/** Create the unique request-key claim before any operation that can send a message. */
async function insertPendingDelivery(
  environment: GatewayEnvironment,
  payload: MailGatewayPayload,
): Promise<boolean> {
  const url = new URL(`${environment.supabaseUrl}/rest/v1/notification_deliveries`);
  let result: Response;
  try {
    result = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: environment.serviceRoleKey,
        authorization: `Bearer ${environment.serviceRoleKey}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify({
        request_key: payload.request_key,
        template_key: payload.template_key,
        locale: payload.locale,
        recipient_email: payload.recipient,
        status: 'pending',
        content_hash: null,
        error_class: null,
        latency_ms: null,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GatewayError('DELIVERY_LOG_UNAVAILABLE', 503);
  }

  if (result.status === 409) {
    // A concurrent request may have won the UNIQUE(request_key) insert; read its row below.
    return false;
  }
  if (!result.ok) {
    throw new GatewayError('DELIVERY_LOG_WRITE_FAILED', 503);
  }
  return true;
}

async function updateDeliveryRecord(
  environment: GatewayEnvironment,
  requestKey: string,
  update: {
    readonly status: 'completed' | 'failed';
    readonly content_hash: string | null;
    readonly error_class: string | null;
    readonly latency_ms: number;
  },
): Promise<void> {
  const url = new URL(`${environment.supabaseUrl}/rest/v1/notification_deliveries`);
  url.search = new URLSearchParams({ request_key: `eq.${requestKey}` }).toString();

  let result: Response;
  try {
    result = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: environment.serviceRoleKey,
        authorization: `Bearer ${environment.serviceRoleKey}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify({
        ...update,
        updated_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GatewayError('DELIVERY_LOG_UNAVAILABLE', 503);
  }
  if (!result.ok) {
    throw new GatewayError('DELIVERY_LOG_WRITE_FAILED', 503);
  }

  let rows: unknown;
  try {
    rows = await result.json();
  } catch {
    throw new GatewayError('DELIVERY_LOG_WRITE_FAILED', 503);
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new GatewayError('DELIVERY_LOG_WRITE_FAILED', 503);
  }
}

/**
 * Completed responses can be reconstructed from the persisted content hash and the adapter's
 * deterministic Message-ID (derived from the request key). No template/secret lookup or SMTP
 * adapter call occurs on replay.
 */
function outcomeForExistingDelivery(record: DeliveryRow): GatewayOutcome {
  if (record.status === 'completed') {
    if (record.content_hash === null || !/^[0-9a-f]{64}$/.test(record.content_hash)) {
      throw new GatewayError('DELIVERY_LOG_READ_FAILED', 503);
    }
    return {
      status: 200,
      body: {
        ok: true,
        request_key: record.request_key,
        delivery_status: 'smtp',
        message_id: smtpMessageId(record.request_key),
        content_hash: record.content_hash,
      },
    };
  }

  if (record.status === 'pending') {
    return {
      status: 409,
      body: { ok: false, code: 'DELIVERY_IN_PROGRESS', request_key: record.request_key },
    };
  }

  // The synchronous retry loop already exhausted its budget inside the original request; a replay
  // of a failed row is never auto-retried. Report whether the class was transient (a future queue
  // could schedule it) without running any retry or enqueue here.
  return {
    status: 409,
    body: {
      ok: false,
      code: shouldRetry(record.error_class) ? 'RETRY_DEFERRED' : 'DELIVERY_ALREADY_FAILED',
      request_key: record.request_key,
    },
  };
}

function classifyDeliveryError(error: unknown): string {
  let errorClass: string;
  if (error instanceof TemplateRenderError) {
    errorClass = error.code;
  } else if (error instanceof MailCryptoError) {
    errorClass = error.code;
  } else if (error instanceof SmtpSendError) {
    // The adapter already collapsed provider/network failures into stable classes (MAIL03/MAIL04).
    errorClass = error.code;
  } else if (error instanceof GatewayError) {
    // Connection failures get the stable retryable class; other gateway codes are static categories.
    errorClass = error.code === 'DATABASE_UNAVAILABLE' ? 'MAIL03' : error.code;
  } else if (error instanceof Error) {
    const code = (error as Error & { readonly code?: unknown }).code;
    errorClass =
      typeof code === 'string' && RETRYABLE_ERROR_CLASSES.has(code) ? code : 'DELIVERY_FAILED';
  } else {
    errorClass = 'DELIVERY_FAILED';
  }

  // Persist only a class identifier. Never use the raw error message or provider/variable values.
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(errorClass) ? errorClass : 'DELIVERY_FAILED';
}

function parseTransport(row: TransportRow | undefined): TransportRow {
  if (
    row === undefined ||
    typeof row.id !== 'string' ||
    typeof row.slug !== 'string' ||
    typeof row.host !== 'string' ||
    !Number.isInteger(row.port) ||
    typeof row.tls_mode !== 'string' ||
    !['starttls', 'implicit_tls', 'none'].includes(row.tls_mode) ||
    typeof row.auth_mode !== 'string' ||
    typeof row.sender_name !== 'string' ||
    typeof row.sender_email !== 'string' ||
    (row.reply_to_email !== null && typeof row.reply_to_email !== 'string') ||
    (row.username !== null && typeof row.username !== 'string') ||
    row.is_enabled !== true ||
    row.is_default !== true
  ) {
    throw new GatewayError('TRANSPORT_UNAVAILABLE', 503);
  }

  const nodeEnvironment = getRuntimeEnvironmentValue('NODE_ENV')?.toLowerCase();
  const deploymentId = getRuntimeEnvironmentValue('DENO_DEPLOYMENT_ID');
  if (row.tls_mode === 'none' && (nodeEnvironment === 'production' || deploymentId !== undefined)) {
    throw new GatewayError('INSECURE_TRANSPORT_CONFIGURATION', 503);
  }
  return row;
}

function parseVariableDefinitions(raw: unknown): TemplateVariableDefinition[] {
  if (!Array.isArray(raw)) {
    throw new GatewayError('TEMPLATE_INVALID', 422);
  }

  return raw.map((item) => {
    if (!isRecord(item) || typeof item.name !== 'string') {
      throw new GatewayError('TEMPLATE_INVALID', 422);
    }
    const type = typeof item.type === 'string' ? item.type : 'text';
    if (!EMAIL_VARIABLE_TYPES.has(type as TemplateVariableType)) {
      throw new GatewayError('TEMPLATE_INVALID', 422);
    }
    const allowedHosts = Array.isArray(item.allowed_hosts)
      ? item.allowed_hosts.filter((host): host is string => typeof host === 'string')
      : undefined;

    return {
      name: item.name,
      type: type as TemplateVariableType,
      required: item.required === true,
      ...(typeof item.max_length === 'number' ? { max_length: item.max_length } : {}),
      ...(allowedHosts ? { allowed_hosts: allowedHosts } : {}),
    };
  });
}

function parseTemplate(row: TemplateRow | undefined): NotificationTemplateForRendering {
  if (
    row === undefined ||
    row.status !== 'active' ||
    row.channel !== 'email' ||
    row.is_current !== true ||
    typeof row.subject !== 'string' ||
    typeof row.body_text !== 'string' ||
    (row.body_html !== null && typeof row.body_html !== 'string')
  ) {
    throw new GatewayError('TEMPLATE_NOT_FOUND', 404);
  }

  return {
    subject: row.subject,
    body_text: row.body_text,
    body_html: row.body_html,
    variables: parseVariableDefinitions(row.variables),
  };
}

function byteaToBase64(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('\\x')) {
    throw new GatewayError('SECRET_UNAVAILABLE', 503);
  }
  const hex = value.slice(2);
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new GatewayError('SECRET_UNAVAILABLE', 503);
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const smtpAdapter = {
  send: sendSmtpMessage,
} as const;

async function invokeSmtpAdapter(input: {
  readonly request_key: string;
  readonly transport: SmtpTransportConfig;
  readonly suite: CipherSuite;
  readonly message: SmtpMessage;
}): Promise<SmtpSendResult> {
  // The immutable plaintext string exists only in this short-lived call frame and is never logged
  // or cached. JavaScript cannot zeroize string storage; the crypto module wipes mutable byte
  // buffers. Decryption happens once; only the send itself is retried below.
  const password = await decryptSecret(input.suite);
  const policy = loadSendRetryPolicy();
  const payload = {
    request_key: input.request_key,
    transport: input.transport,
    password,
    message: input.message,
  };

  let attempts = 0;
  let providerLatencyMs = 0;
  let lastError: unknown = null;

  while (attempts < policy.maxAttempts) {
    const attemptStartedAt = performance.now();
    try {
      const result = await smtpAdapter.send(payload);
      const attemptLatencyMs =
        result.latency_ms > 0
          ? result.latency_ms
          : Math.max(0, Math.round(performance.now() - attemptStartedAt));
      return {
        ...result,
        latency_ms: providerLatencyMs + attemptLatencyMs,
      };
    } catch (error) {
      const attemptLatencyMs =
        error instanceof SmtpSendError && error.latency_ms > 0
          ? error.latency_ms
          : Math.max(0, Math.round(performance.now() - attemptStartedAt));
      providerLatencyMs += attemptLatencyMs;
      lastError =
        error instanceof SmtpSendError ? new SmtpSendError(error.code, providerLatencyMs) : error;
      attempts += 1;
      const errorClass = classifyDeliveryError(error);
      if (!shouldRetry(errorClass) || attempts >= policy.maxAttempts) {
        break; // Non-transient class, or the retry budget is spent: no point in another attempt.
      }
      // Simple exponential backoff between attempts; the same Message-ID is reused each time.
      // Backoff sleep is deliberately excluded from provider latency_ms.
      await sleep(calculateBackoff(attempts, policy.backoffBaseMs));
    }
  }
  throw lastError; // Caught below and recorded as 'failed' in the delivery-record update step.
}

async function performDelivery(
  environment: GatewayEnvironment,
  payload: MailGatewayPayload,
): Promise<GatewayOutcome> {
  const transportQuery = new URLSearchParams({
    select:
      'id,slug,host,port,tls_mode,auth_mode,username,sender_name,sender_email,reply_to_email,is_enabled,is_default',
    is_enabled: 'eq.true',
    is_default: 'eq.true',
    limit: '1',
  });
  const transportRows = await selectRows<TransportRow>(
    environment,
    'notification_transports',
    transportQuery,
  );
  const transport = parseTransport(transportRows[0]);

  const secretQuery = new URLSearchParams({
    select: 'cipher,secret_ciphertext,nonce,tag,kms_key_id',
    transport_id: `eq.${transport.id}`,
    limit: '1',
  });
  const secretRows = await selectRows<SecretRow>(
    environment,
    'notification_transport_secrets',
    secretQuery,
  );
  const secret = secretRows[0];
  if (
    secret === undefined ||
    secret.cipher !== 'aes-256-gcm' ||
    typeof secret.secret_ciphertext !== 'string' ||
    typeof secret.nonce !== 'string' ||
    typeof secret.tag !== 'string'
  ) {
    throw new GatewayError('SECRET_UNAVAILABLE', 503);
  }

  const templateQuery = new URLSearchParams({
    select: 'subject,body_text,body_html,variables,status,channel,is_current',
    key: `eq.${payload.template_key}`,
    locale: `eq.${payload.locale}`,
    status: 'eq.active',
    channel: 'eq.email',
    is_current: 'eq.true',
    limit: '1',
  });
  const templateRows = await selectRows<TemplateRow>(
    environment,
    'notification_templates',
    templateQuery,
  );
  const template = parseTemplate(templateRows[0]);
  const rendered = await renderNotificationTemplate({ template, values: payload.variables });

  const suite: CipherSuite = {
    cipher: 'aes-256-gcm',
    ciphertext: byteaToBase64(secret.secret_ciphertext),
    nonce: byteaToBase64(secret.nonce),
    tag: byteaToBase64(secret.tag),
    ...(secret.kms_key_id ? { key_version: secret.kms_key_id } : {}),
  };

  const adapterResult = await invokeSmtpAdapter({
    request_key: payload.request_key,
    transport,
    suite,
    message: {
      recipient: payload.recipient,
      subject: rendered.subject,
      body_text: rendered.body_text ?? '',
      body_html: rendered.body_html,
    },
  });

  // Real SMTP send (task 4.3): this is a provider acknowledgement, with the deterministic
  // Message-ID the adapter used so idempotent replays can reconstruct the same response body.
  return {
    status: 200,
    latency_ms: adapterResult.latency_ms,
    body: {
      ok: adapterResult.ok,
      request_key: payload.request_key,
      delivery_status: adapterResult.mode,
      message_id: adapterResult.message_id,
      content_hash: rendered.content_hash,
    },
  };
}

/** Run steps 3–4: process the message, then persist only a safe result/class and provider latency. */
async function performAndRecordDelivery(
  environment: GatewayEnvironment,
  payload: MailGatewayPayload,
): Promise<GatewayOutcome> {
  let outcome: GatewayOutcome;
  let contentHash: string | null = null;
  let errorClass: string | null = null;
  let latencyMs: number;

  try {
    outcome = await performDelivery(environment, payload);
    const hash = outcome.body.content_hash;
    if (outcome.body.ok !== true || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new GatewayError('DELIVERY_RESULT_INVALID', 500);
    }
    contentHash = hash;
    latencyMs = outcome.latency_ms ?? 0;
  } catch (error) {
    outcome = failure(error, payload.request_key);
    errorClass = classifyDeliveryError(error);
    latencyMs = error instanceof SmtpSendError ? error.latency_ms : 0;
    // The synchronous retry loop already ran inside the adapter invocation; anything reaching
    // this catch is the final error after `shouldRetry` stopped being useful.
  }

  await updateDeliveryRecord(environment, payload.request_key, {
    status: outcome.body.ok === true ? 'completed' : 'failed',
    content_hash: contentHash,
    error_class: errorClass,
    latency_ms: Math.max(0, Math.round(latencyMs)),
  });
  return outcome;
}

/** Fetch-compatible endpoint handler. No raw database/provider/crypto errors cross this boundary. */
export async function handleMailGatewayRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return response({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
  }

  let environment: GatewayEnvironment;
  try {
    environment = loadEnvironment();
  } catch (error) {
    const result = failure(error);
    return response(result.body, result.status);
  }
  if (!isAuthorized(request, environment.serviceRoleKey)) {
    return response({ ok: false, code: 'UNAUTHORIZED' }, 401);
  }

  let payload: MailGatewayPayload;
  try {
    payload = parsePayload(await readJsonRequest(request));
  } catch (error) {
    const result = failure(error);
    return response(result.body, result.status);
  }

  try {
    // Step 1: hit the durable log first. A completed request replays the stored hash/result without
    // decrypting secrets, rendering a template, or calling the SMTP adapter again.
    const existing = await selectDeliveryRecord(environment, payload.request_key);
    if (existing !== undefined) {
      const result = outcomeForExistingDelivery(existing);
      return response(result.body, result.status);
    }

    // Step 2: claim the globally unique request key before processing. If another worker won the
    // insert race, read its row and return the corresponding completed/pending/failed outcome.
    const inserted = await insertPendingDelivery(environment, payload);
    if (!inserted) {
      const concurrent = await selectDeliveryRecord(environment, payload.request_key);
      if (concurrent === undefined) {
        throw new GatewayError('DELIVERY_LOG_CONFLICT', 503);
      }
      const result = outcomeForExistingDelivery(concurrent);
      return response(result.body, result.status);
    }

    // Steps 3–4: run the render/decrypt/SMTP path with its bounded synchronous retry loop, then
    // persist only status, content hash, safe error class and latency. No external queue or cron.
    const result = await performAndRecordDelivery(environment, payload);
    return response(result.body, result.status);
  } catch (error) {
    const result = failure(error, payload.request_key);
    return response(result.body, result.status);
  }
}

// A source-in-tree Worker equivalent avoids widening the existing typed ESLint project to
// generated/deployment files. When this module itself runs under Deno (for example via a worker
// entrypoint), it serves the Fetch handler; browser code never imports this server-only module.
const denoRuntime = (globalThis as typeof globalThis & RuntimeEnvironment).Deno;
if (typeof denoRuntime?.serve === 'function') {
  denoRuntime.serve(handleMailGatewayRequest);
}
