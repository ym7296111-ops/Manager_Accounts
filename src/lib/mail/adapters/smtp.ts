/**
 * §1.6(C4) / §2.5(د): Real SMTP provider adapter (task 4.3).
 *
 * Task 4.3 turns the 4.1 mock-only skeleton into a real sender built on `nodemailer` (loaded
 * lazily so browser bundles and importOriginal() test hooks never pull in the SMTP stack).
 *
 * Hard rules preserved from the study:
 * - C4: `tls_mode: 'none'` is refused whenever the runtime is production (`NODE_ENV=production`
 *   or a Deno Deploy deployment id); local dev/test sinks (Mailpit/Mailhog) remain possible.
 * - C7: errors carry no values. Every failure is collapsed into a `SmtpSendError` whose message is
 *   exactly its class identifier (`MAIL03` connection/transient, `MAIL04` authentication,
 *   `DELIVERY_FAILED` permanent rejection). SMTP server responses, hostnames and credentials are
 *   never echoed, logged, or retained on the error object.
 * - The immutable SMTP password exists only for the duration of one `sendSmtpMessage` call frame.
 * - `latency_ms` is measured precisely around the provider call (`performance.now()`), excluding
 *   local validation and any caller-side retry backoff.
 */

export interface SmtpTransportConfig {
  readonly host: string;
  readonly port: number;
  readonly tls_mode: 'starttls' | 'implicit_tls' | 'none';
  readonly auth_mode: string;
  readonly username: string | null;
  readonly sender_name: string;
  readonly sender_email: string;
  readonly reply_to_email: string | null;
}

export interface SmtpMessage {
  readonly recipient: string;
  readonly subject: string;
  readonly body_text: string;
  readonly body_html: string | null;
}

export interface SmtpSendInput {
  readonly request_key: string;
  readonly transport: SmtpTransportConfig;
  readonly password: string;
  readonly message: SmtpMessage;
}

export interface SmtpSendResult {
  readonly ok: true;
  readonly mode: 'smtp';
  readonly message_id: string;
  readonly latency_ms: number;
}

/**
 * Stable error classes for the delivery log (`notification_deliveries.error_class`):
 * - `MAIL03`: connection/DNS/socket failures and SMTP 4xx transient rejections (retryable).
 * - `MAIL04`: authentication/authorization failures (never retried).
 * - `DELIVERY_FAILED`: permanent provider rejection or unexpected failure (never retried).
 */
export type SmtpSendErrorCode = 'MAIL03' | 'MAIL04' | 'DELIVERY_FAILED';

/** Value-free provider error (§3.4): `message` is always just the class identifier. */
export class SmtpSendError extends Error {
  readonly code: SmtpSendErrorCode;
  readonly latency_ms: number;

  constructor(code: SmtpSendErrorCode, latencyMs = 0) {
    super(code);
    this.code = code;
    this.latency_ms = Math.max(0, Math.round(latencyMs));
    this.name = 'SmtpSendError';
  }
}

/**
 * Stable synthetic right-hand side so the Message-ID can be reconstructed from the request key
 * alone during idempotent replays (the delivery log has no message-id column, and DMARC aligns on
 * the From domain, not the Message-ID domain).
 */
const MESSAGE_ID_DOMAIN = 'mail-gateway.internal';

/** Deterministic RFC 5322 Message-ID for one request key; reused across retry attempts. */
export function smtpMessageId(requestKey: string): string {
  return `<${requestKey}@${MESSAGE_ID_DOMAIN}>`;
}

interface RuntimeEnvironment {
  readonly Deno?: {
    readonly env?: {
      get(name: string): string | undefined;
    };
  };
  readonly process?: {
    readonly env?: Readonly<Record<string, string | undefined>>;
  };
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

function isProductionRuntime(): boolean {
  // Same deployment probe as the gateway: Deno Deploy always counts as production (§1.6 C4).
  return (
    getRuntimeEnvironmentValue('NODE_ENV')?.toLowerCase() === 'production' ||
    getRuntimeEnvironmentValue('DENO_DEPLOYMENT_ID') !== undefined
  );
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

interface SmtpEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * Execution-environment overrides (`SMTP_HOST` / `SMTP_PORT`) redirect the worker's egress to a
 * dev sink (Mailpit/Mailhog) or a corporate relay. They never override TLS mode, identity, or
 * credentials: those stay owned by the `notification_transports` row and its encrypted secret.
 */
function resolveSmtpEndpoint(transport: SmtpTransportConfig): SmtpEndpoint {
  const hostOverride = getRuntimeEnvironmentValue('SMTP_HOST')?.trim();
  const portOverride = getRuntimeEnvironmentValue('SMTP_PORT')?.trim();

  const host = hostOverride !== undefined && hostOverride !== '' ? hostOverride : transport.host;
  let port = transport.port;
  if (portOverride !== undefined && portOverride !== '') {
    const parsed = Number(portOverride);
    if (!Number.isInteger(parsed)) {
      throw new SmtpSendError('MAIL03');
    }
    port = parsed;
  }
  if (port < 1 || port > 65535) {
    throw new SmtpSendError('MAIL03');
  }
  return { host, port };
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

/** Reject header-injection material before nodemailer ever assembles an envelope. */
function validateAddressField(value: string): void {
  if (
    value === '' ||
    containsControlCharacters(value) ||
    value.includes('<') ||
    value.includes('>')
  ) {
    throw new SmtpSendError('DELIVERY_FAILED');
  }
}

interface NodemailerSendInfo {
  readonly messageId?: string;
}

interface SmtpAddress {
  readonly name?: string;
  readonly address: string;
}

interface SmtpMessageOptions {
  readonly from: SmtpAddress;
  readonly to: SmtpAddress;
  readonly replyTo?: SmtpAddress;
  readonly messageId: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

interface NodemailerTransport {
  sendMail(options: SmtpMessageOptions): Promise<NodemailerSendInfo>;
}

interface NodemailerModule {
  createTransport(options: SmtpTransportOptions): NodemailerTransport;
}

/**
 * Minimal surface of `nodemailer` used by this adapter. The package is imported lazily (bare
 * specifier resolves through npm compat in Deno and through node_modules in Node) so browser
 * graphs, Deno cold starts, and `vi.mock('nodemailer')` test hooks all stay independent of the
 * SMTP stack.
 */
async function loadNodemailer(): Promise<NodemailerModule> {
  const loaded = (await import('nodemailer')) as unknown as {
    readonly default?: NodemailerModule;
  } & NodemailerModule;
  const api = loaded.default ?? loaded;
  if (typeof api.createTransport !== 'function') {
    throw new SmtpSendError('DELIVERY_FAILED');
  }
  return api;
}

interface ProviderFailure {
  readonly code?: unknown;
  readonly responseCode?: unknown;
}

const NETWORK_FAILURE_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDNS',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ESOCKET',
  'ETIMEDOUT',
  'ETLS',
  'ESTARTTLS',
  'CONNECTION_ERROR',
  'NETWORK_ERROR',
]);

const AUTH_FAILURE_RESPONSE_CODES = new Set([530, 534, 535, 538]);

/**
 * Collapse a provider/network failure into a stable class. SMTP 4xy replies are transient
 * (`MAIL03`, retryable); authentication failures are `MAIL04`; everything else is permanent.
 */
function classifySmtpFailure(error: unknown): SmtpSendErrorCode {
  const failure = (error ?? {}) as ProviderFailure;
  const code = typeof failure.code === 'string' ? failure.code : undefined;
  const responseCode =
    typeof failure.responseCode === 'number' && Number.isInteger(failure.responseCode)
      ? failure.responseCode
      : undefined;

  if (
    code === 'EAUTH' ||
    (responseCode !== undefined && AUTH_FAILURE_RESPONSE_CODES.has(responseCode))
  ) {
    return 'MAIL04';
  }
  if (
    (code !== undefined && NETWORK_FAILURE_CODES.has(code)) ||
    (responseCode !== undefined && responseCode >= 400 && responseCode < 500)
  ) {
    return 'MAIL03';
  }
  return 'DELIVERY_FAILED';
}

interface SmtpTransportOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTLS: boolean;
  readonly ignoreTLS: boolean;
  readonly tls: { readonly minVersion: 'TLSv1.2'; readonly servername: string };
  readonly auth?: { readonly user: string; readonly pass: string };
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
  readonly logger: false;
  readonly debug: false;
}

function buildTransportOptions(
  endpoint: SmtpEndpoint,
  transport: SmtpTransportConfig,
  password: string,
): SmtpTransportOptions {
  const timeoutMs = parseBoundedInteger(
    getRuntimeEnvironmentValue('SMTP_TIMEOUT_MS'),
    10_000,
    250,
    60_000,
  );

  const options: SmtpTransportOptions = {
    host: endpoint.host,
    port: endpoint.port,
    // implicit_tls = TLS from the first byte (port 465); starttls = plaintext greeting upgraded
    // with requireTLS so a stripped downgrade is refused; 'none' is dev-sink only.
    secure: transport.tls_mode === 'implicit_tls',
    requireTLS: transport.tls_mode === 'starttls',
    ignoreTLS: transport.tls_mode === 'none',
    tls: { minVersion: 'TLSv1.2', servername: endpoint.host },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    // C7: never enable nodemailer's logger/debug — SMTP banners can carry identifiers.
    logger: false,
    debug: false,
    ...(transport.auth_mode !== 'none' && transport.username !== null
      ? { auth: { user: transport.username, pass: password } }
      : {}),
  };
  return options;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/**
 * Send one rendered message through the configured SMTP transport. The caller (gateway) owns
 * idempotency and retries; this function performs exactly one send attempt and reports its
 * precise provider latency.
 */
export async function sendSmtpMessage(input: SmtpSendInput): Promise<SmtpSendResult> {
  const transport = input.transport;

  // §1.6 C4 startup refusal: never transmit credentials or content over plaintext SMTP in
  // production. This is a static configuration error; no connection is attempted (MAIL03 per the
  // task 4.3 contract).
  if (transport.tls_mode === 'none' && isProductionRuntime()) {
    throw new SmtpSendError('MAIL03');
  }

  validateAddressField(transport.sender_email);
  validateAddressField(transport.sender_name);
  if (transport.reply_to_email !== null) {
    validateAddressField(transport.reply_to_email);
  }
  validateAddressField(input.message.recipient);
  if (transport.auth_mode !== 'none' && transport.username !== null && input.password === '') {
    // Credential material is missing; retrying cannot help (MAIL04).
    throw new SmtpSendError('MAIL04');
  }

  const endpoint = resolveSmtpEndpoint(transport);
  const options = buildTransportOptions(endpoint, transport, input.password);
  const messageId = smtpMessageId(input.request_key);
  const nodemailer = await loadNodemailer();

  const startedAt = performance.now();
  try {
    const client = nodemailer.createTransport(options);
    // Structured address objects (never string-concatenated) so names cannot break out of headers.
    await client.sendMail({
      from: { name: transport.sender_name, address: transport.sender_email },
      to: { address: input.message.recipient },
      ...(transport.reply_to_email !== null
        ? { replyTo: { address: transport.reply_to_email } }
        : {}),
      // Same Message-ID across retry attempts keeps provider-side threading/dedup stable.
      messageId,
      subject: input.message.subject,
      text: input.message.body_text,
      ...(input.message.body_html !== null ? { html: input.message.body_html } : {}),
    });
  } catch (error) {
    if (error instanceof SmtpSendError) {
      throw error;
    }
    throw new SmtpSendError(classifySmtpFailure(error), elapsedMs(startedAt));
  }

  return {
    ok: true,
    mode: 'smtp',
    message_id: messageId,
    latency_ms: elapsedMs(startedAt),
  };
}

/** Provider adapter facade exposing the single-attempt `send` method used by the gateway. */
export const smtpAdapter = {
  send: sendSmtpMessage,
} as const;
