// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmtpSendInput, SmtpSendResult } from './adapters/smtp.ts';

type SendSmtpMessage = (input: SmtpSendInput) => Promise<SmtpSendResult>;

const { mockSendSmtpMessage } = vi.hoisted(() => ({
  mockSendSmtpMessage: vi.fn<SendSmtpMessage>(),
}));

// Keep the real error class and Message-ID helper; only the network send is mocked so automated
// tests never contact a real SMTP server or mail external addresses (task 4.3 scope guard).
vi.mock(import('./adapters/smtp.ts'), async (importOriginal) => ({
  ...(await importOriginal()),
  sendSmtpMessage: mockSendSmtpMessage,
}));

import { SmtpSendError, smtpMessageId } from './adapters/smtp.ts';
import { encryptSecret } from './crypto.ts';
import { calculateBackoff, handleMailGatewayRequest, shouldRetry } from './gateway.ts';

const MASTER_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const SERVICE_ROLE_KEY = 'test-service-role-key';
const REQUEST_KEY = 'a0b1c2d3-e4f5-4678-9012-abcdef123456';
const TEST_PASSWORD = `smtp-test-${randomUUID()}`;
const transportId = 'f00d0000-0000-4000-8000-000000000001';

interface MemoryDatabase {
  readonly deliveries: Map<string, Record<string, unknown>>;
  readonly transport: Record<string, unknown>;
  readonly secret: Record<string, unknown>;
  template: Record<string, unknown>;
}

let database: MemoryDatabase;

function bytesToBytea(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `\\x${hex}`;
}

function getUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(input);
}

function parseJsonRecord(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') {
    throw new Error('test request body must be JSON text');
  }
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('test request body must be an object');
  }
  return parsed as Record<string, unknown>;
}

function jsonResponse(body: unknown, init?: ResponseInit): Promise<Response> {
  return Promise.resolve(Response.json(body, init));
}

function createMemoryFetch(): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = getUrl(input);
    const table = url.pathname.split('/').at(-1);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (table === 'notification_deliveries' && method === 'GET') {
      const requestKey = url.searchParams.get('request_key')?.replace(/^eq\./, '');
      const row = requestKey ? database.deliveries.get(requestKey) : undefined;
      return jsonResponse(row ? [row] : []);
    }

    if (table === 'notification_deliveries' && method === 'POST') {
      const record = parseJsonRecord(init?.body);
      const requestKey = String(record.request_key);
      if (database.deliveries.has(requestKey)) {
        return jsonResponse({ code: '23505' }, { status: 409 });
      }
      const now = new Date().toISOString();
      database.deliveries.set(requestKey, {
        id: 'd3110000-0000-4000-8000-000000000001',
        ...record,
        created_at: now,
        updated_at: now,
      });
      return Promise.resolve(new Response(null, { status: 201 }));
    }

    if (table === 'notification_deliveries' && method === 'PATCH') {
      const requestKey = url.searchParams.get('request_key')?.replace(/^eq\./, '');
      const row = requestKey ? database.deliveries.get(requestKey) : undefined;
      if (!row) {
        return jsonResponse([]);
      }
      const update = parseJsonRecord(init?.body);
      Object.assign(row, update);
      return jsonResponse([row]);
    }

    if (table === 'notification_transports' && method === 'GET') {
      return jsonResponse([database.transport]);
    }
    if (table === 'notification_transport_secrets' && method === 'GET') {
      return jsonResponse([database.secret]);
    }
    if (table === 'notification_templates' && method === 'GET') {
      return jsonResponse([database.template]);
    }

    return jsonResponse({ code: 'unexpected_test_request' }, { status: 404 });
  };
}

function makeRequest(
  requestKey = REQUEST_KEY,
  variables: Readonly<Record<string, string>> = { user_name: 'Lina' },
): Request {
  return new Request('https://mail-gateway.test/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      request_key: requestKey,
      template_key: 'security.suspension_alert',
      locale: 'en',
      recipient: 'user@example.com',
      variables,
    }),
  });
}

beforeEach(async () => {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubEnv('MAIL_MASTER_KEY', MASTER_KEY);
  // Backoff sleeps collapse to zero so retry-loop tests stay instant; the math itself is
  // asserted separately in the `calculateBackoff` unit test below.
  vi.stubEnv('MAIL_RETRY_BACKOFF_MS', '0');
  mockSendSmtpMessage.mockReset();
  mockSendSmtpMessage.mockImplementation((input) =>
    Promise.resolve({
      ok: true,
      mode: 'smtp',
      message_id: smtpMessageId(input.request_key),
      latency_ms: 1,
    }),
  );

  const suite = await encryptSecret(TEST_PASSWORD);
  database = {
    deliveries: new Map(),
    transport: {
      id: transportId,
      slug: 'default-smtp',
      host: 'smtp.example.test',
      port: 587,
      tls_mode: 'starttls',
      auth_mode: 'password',
      username: 'mailer@example.test',
      sender_name: 'Admin System',
      sender_email: 'no-reply@example.test',
      reply_to_email: null,
      is_enabled: true,
      is_default: true,
    },
    secret: {
      cipher: 'aes-256-gcm',
      secret_ciphertext: bytesToBytea(suite.ciphertext),
      nonce: bytesToBytea(suite.nonce),
      tag: bytesToBytea(suite.tag),
      kms_key_id: null,
    },
    template: {
      subject: 'Hello {{user_name}}',
      body_text: 'Welcome, {{user_name}}',
      body_html: null,
      variables: [{ name: 'user_name', type: 'text', required: true }],
      status: 'active',
      channel: 'email',
      is_current: true,
    },
  };
  vi.stubGlobal('fetch', createMemoryFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('mail gateway durable idempotency and delivery log (§2.4 / §2.9)', () => {
  it('replays a completed request key without calling the SMTP adapter a second time', async () => {
    const firstResponse = await handleMailGatewayRequest(makeRequest());
    const firstBody = (await firstResponse.json()) as unknown;
    const secondResponse = await handleMailGatewayRequest(makeRequest());
    const secondBody = (await secondResponse.json()) as unknown;

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondBody).toEqual(firstBody);
    expect(mockSendSmtpMessage).toHaveBeenCalledTimes(1);
    const completed = database.deliveries.get(REQUEST_KEY);
    expect(completed?.status).toBe('completed');
    expect(completed?.error_class).toBeNull();
    expect(typeof completed?.latency_ms).toBe('number');
    expect(completed?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores only a stable error class when template content fails', async () => {
    const sensitiveValue = 'sensitive-variable-must-never-be-logged';
    database.template = {
      ...database.template,
      subject: 'Hello {{private_name}}',
      body_text: 'Body {{private_name}}',
      variables: [],
    };

    const response = await handleMailGatewayRequest(
      makeRequest(REQUEST_KEY, { untrusted_value: sensitiveValue }),
    );
    const responseBody: unknown = await response.json();
    const row = database.deliveries.get(REQUEST_KEY);

    expect(response.status).toBe(422);
    expect(responseBody).toMatchObject({ ok: false, code: 'TPL01' });
    expect(row).toMatchObject({ status: 'failed', error_class: 'TPL01' });
    expect(JSON.stringify(row)).not.toContain(sensitiveValue);
    expect(JSON.stringify(responseBody)).not.toContain(sensitiveValue);
    expect(mockSendSmtpMessage).not.toHaveBeenCalled();
  });

  it('classifies only known transient network errors as retryable', () => {
    expect(shouldRetry('MAIL03')).toBe(true);
    expect(shouldRetry('ECONNRESET')).toBe(true);
    expect(shouldRetry('MAIL04')).toBe(false);
    expect(shouldRetry('TPL01')).toBe(false);
    expect(shouldRetry('TPL04')).toBe(false);
    expect(shouldRetry(null)).toBe(false);
  });
});

describe('mail gateway synchronous SMTP retry loop (task 4.3)', () => {
  it('retries a transient MAIL03 failure, completes on the second attempt, and excludes backoff sleep from latency_ms', async () => {
    vi.stubEnv('MAIL_RETRY_BACKOFF_MS', '40');
    let calls = 0;
    mockSendSmtpMessage.mockImplementation((input) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new SmtpSendError('MAIL03', 4));
      }
      return Promise.resolve({
        ok: true,
        mode: 'smtp',
        message_id: smtpMessageId(input.request_key),
        latency_ms: 6,
      });
    });

    const response = await handleMailGatewayRequest(makeRequest());
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      delivery_status: 'smtp',
      message_id: smtpMessageId(REQUEST_KEY),
    });
    expect(mockSendSmtpMessage).toHaveBeenCalledTimes(2);
    const deliveryRow = database.deliveries.get(REQUEST_KEY);
    expect(deliveryRow?.status).toBe('completed');
    // Provider calls took 4ms + 6ms = 10ms; the 40ms backoff sleep between attempts is excluded.
    expect(deliveryRow?.latency_ms).toBe(10);
  });

  it('never retries authentication failures (MAIL04) and records the safe class', async () => {
    mockSendSmtpMessage.mockImplementation(() => Promise.reject(new SmtpSendError('MAIL04')));

    const response = await handleMailGatewayRequest(makeRequest());
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ ok: false, code: 'MAIL04', request_key: REQUEST_KEY });
    expect(mockSendSmtpMessage).toHaveBeenCalledTimes(1);
    expect(database.deliveries.get(REQUEST_KEY)).toMatchObject({
      status: 'failed',
      error_class: 'MAIL04',
    });
  });

  it('stops after MAIL_MAX_SEND_ATTEMPTS transient failures and never auto-retries on replay', async () => {
    vi.stubEnv('MAIL_MAX_SEND_ATTEMPTS', '2');
    mockSendSmtpMessage.mockImplementation(() => Promise.reject(new SmtpSendError('MAIL03')));

    const response = await handleMailGatewayRequest(makeRequest());

    expect(response.status).toBe(502);
    expect(mockSendSmtpMessage).toHaveBeenCalledTimes(2);
    expect(database.deliveries.get(REQUEST_KEY)).toMatchObject({
      status: 'failed',
      error_class: 'MAIL03',
      latency_ms: expect.any(Number) as number,
    });

    // Replaying the failed row reports that a future queue could reschedule it, but this worker
    // never re-runs the adapter for an existing request key.
    const replay = await handleMailGatewayRequest(makeRequest());
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ ok: false, code: 'RETRY_DEFERRED' });
    expect(mockSendSmtpMessage).toHaveBeenCalledTimes(2);
  });

  it('honours MAIL_MAX_SEND_ATTEMPTS=1 as a strict single-attempt budget', async () => {
    vi.stubEnv('MAIL_MAX_SEND_ATTEMPTS', '1');
    mockSendSmtpMessage.mockImplementation(() => Promise.reject(new SmtpSendError('MAIL03')));

    const response = await handleMailGatewayRequest(makeRequest());

    expect(response.status).toBe(502);
    expect(mockSendSmtpMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects non-retryable provider outcomes (DELIVERY_FAILED) after a single attempt', async () => {
    mockSendSmtpMessage.mockImplementation(() =>
      Promise.reject(new SmtpSendError('DELIVERY_FAILED')),
    );

    const response = await handleMailGatewayRequest(makeRequest());

    expect(response.status).toBe(502);
    expect(mockSendSmtpMessage).toHaveBeenCalledTimes(1);
    expect(database.deliveries.get(REQUEST_KEY)).toMatchObject({
      status: 'failed',
      error_class: 'DELIVERY_FAILED',
    });
    expect(JSON.stringify(database.deliveries.get(REQUEST_KEY))).not.toContain(TEST_PASSWORD);
  });

  it('grows the backoff exponentially per attempt and caps it at a fixed ceiling', () => {
    expect(calculateBackoff(1, 100)).toBe(100);
    expect(calculateBackoff(2, 100)).toBe(200);
    expect(calculateBackoff(3, 100)).toBe(400);
    expect(calculateBackoff(1, 0)).toBe(0);
    expect(calculateBackoff(20, 10_000)).toBe(30_000);
    expect(calculateBackoff(1)).toBe(250);
  });
});
