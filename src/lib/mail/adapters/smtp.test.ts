// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SendMailFn = (options: Record<string, unknown>) => Promise<{ readonly messageId?: string }>;
type CreateTransportFn = (options: Record<string, unknown>) => { readonly sendMail: SendMailFn };

const { mockCreateTransport, mockSendMail } = vi.hoisted(() => {
  const mockSendMail = vi.fn<SendMailFn>();
  const mockCreateTransport = vi.fn<CreateTransportFn>();
  return { mockCreateTransport, mockSendMail };
});

// The provider stack is mocked wholesale: automated tests must never talk to a real SMTP server
// or send mail to external addresses (task 4.3 scope guard).
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));

import {
  sendSmtpMessage,
  smtpAdapter,
  SmtpSendError,
  smtpMessageId,
  type SmtpMessage,
  type SmtpSendInput,
  type SmtpTransportConfig,
} from './smtp.ts';

const REQUEST_KEY = 'a0b1c2d3-e4f5-4678-9012-abcdef123456';
const TEST_PASSWORD = `smtp-test-${randomUUID()}`;

const baseTransport: SmtpTransportConfig = {
  host: 'smtp.example.test',
  port: 587,
  tls_mode: 'starttls',
  auth_mode: 'password',
  username: 'mailer@example.test',
  sender_name: 'Admin System',
  sender_email: 'no-reply@example.test',
  reply_to_email: null,
};

const baseMessage: SmtpMessage = {
  recipient: 'user@example.com',
  subject: 'Hello',
  body_text: 'Welcome, user',
  body_html: null,
};

function makeInput(
  transport: SmtpTransportConfig = baseTransport,
  message: SmtpMessage = baseMessage,
): SmtpSendInput {
  return {
    request_key: REQUEST_KEY,
    transport,
    password: TEST_PASSWORD,
    message,
  };
}

function providerError(code: string, responseCode?: number): Error {
  return Object.assign(new Error('provider failure'), {
    code,
    ...(responseCode !== undefined ? { responseCode } : {}),
  });
}

describe('real SMTP adapter (task 4.3)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    // Neutralise any ambient worker overrides so unit tests see the transport row as-is.
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_PORT', '');
    mockCreateTransport.mockReset();
    mockSendMail.mockReset();
    mockCreateTransport.mockImplementation(() => ({ sendMail: mockSendMail }));
    mockSendMail.mockImplementation(() => Promise.resolve({}));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends over STARTTLS with an encrypted channel requirement and structured addresses', async () => {
    const result = await sendSmtpMessage(makeInput());

    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        requireTLS: true,
        ignoreTLS: false,
        auth: { user: 'mailer@example.test', pass: TEST_PASSWORD },
        logger: false,
        debug: false,
      }),
    );
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { name: 'Admin System', address: 'no-reply@example.test' },
        to: { address: 'user@example.com' },
        subject: 'Hello',
        text: 'Welcome, user',
        messageId: smtpMessageId(REQUEST_KEY),
      }),
    );
    expect(result).toEqual({
      ok: true,
      mode: 'smtp',
      message_id: smtpMessageId(REQUEST_KEY),
      latency_ms: expect.any(Number) as number,
    });
  });

  it('sends multipart/alternative with the fixed text-then-html part order', async () => {
    await sendSmtpMessage(
      makeInput(baseTransport, { ...baseMessage, body_html: '<p>Welcome, user</p>' }),
    );

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Welcome, user',
        html: '<p>Welcome, user</p>',
      }),
    );
  });

  it('uses implicit TLS (port 465) without requiring a STARTTLS upgrade', async () => {
    await sendSmtpMessage(makeInput({ ...baseTransport, port: 465, tls_mode: 'implicit_tls' }));

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, requireTLS: false }),
    );
  });

  it('includes Reply-To only when the transport configures one', async () => {
    await sendSmtpMessage(makeInput({ ...baseTransport, reply_to_email: 'support@example.test' }));
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ replyTo: { address: 'support@example.test' } }),
    );

    mockSendMail.mockClear();
    await sendSmtpMessage(makeInput());
    expect(mockSendMail.mock.calls[0]?.[0]).not.toHaveProperty('replyTo');
  });

  it('refuses tls_mode=none with MAIL03 when NODE_ENV=production, before any connection', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const attempt = sendSmtpMessage(makeInput({ ...baseTransport, tls_mode: 'none' }));
    await expect(attempt).rejects.toBeInstanceOf(SmtpSendError);
    await expect(
      sendSmtpMessage(makeInput({ ...baseTransport, tls_mode: 'none' })),
    ).rejects.toEqual(expect.objectContaining({ code: 'MAIL03', message: 'MAIL03' }));
    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('treats a Deno Deploy runtime as production for the tls_mode=none refusal (§1.6 C4)', async () => {
    vi.stubEnv('DENO_DEPLOYMENT_ID', 'deployment-123');

    await expect(
      sendSmtpMessage(makeInput({ ...baseTransport, tls_mode: 'none' })),
    ).rejects.toEqual(expect.objectContaining({ code: 'MAIL03' }));
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it('allows tls_mode=none for local dev/test sinks such as Mailpit', async () => {
    const result = await smtpAdapter.send(
      makeInput({ ...baseTransport, tls_mode: 'none', auth_mode: 'none', username: null }),
    );

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: false, ignoreTLS: true }),
    );
    expect(mockCreateTransport.mock.calls[0]?.[0]).not.toHaveProperty('auth');
    expect(result.mode).toBe('smtp');
  });

  it('classifies authentication failures as MAIL04 without echoing the SMTP response or credentials', async () => {
    const rawServerBanner = '535-5.7.8 Username and Password not accepted for mailer@example.test';
    mockSendMail.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error(rawServerBanner), { code: 'EAUTH', responseCode: 535 }),
      ),
    );

    await expect(sendSmtpMessage(makeInput())).rejects.toEqual(
      expect.objectContaining({ code: 'MAIL04', message: 'MAIL04' }),
    );
    const error = await sendSmtpMessage(makeInput()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SmtpSendError);
    expect((error as SmtpSendError).message).toBe('MAIL04');
    expect(String(error)).not.toContain('535');
    expect(JSON.stringify(error)).not.toContain(rawServerBanner);
    expect(JSON.stringify(error)).not.toContain(TEST_PASSWORD);
  });

  it('classifies connection/DNS/socket failures as retryable MAIL03', async () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']) {
      mockSendMail.mockImplementation(() => Promise.reject(providerError(code)));
      await expect(sendSmtpMessage(makeInput())).rejects.toEqual(
        expect.objectContaining({ code: 'MAIL03', message: 'MAIL03' }),
      );
    }
  });

  it('treats SMTP 4xx replies as transient MAIL03 and 5xx envelope rejections as permanent', async () => {
    mockSendMail.mockImplementation(() => Promise.reject(providerError('EENVELOPE', 451)));
    await expect(sendSmtpMessage(makeInput())).rejects.toEqual(
      expect.objectContaining({ code: 'MAIL03' }),
    );

    mockSendMail.mockImplementation(() => Promise.reject(providerError('EENVELOPE', 550)));
    await expect(sendSmtpMessage(makeInput())).rejects.toEqual(
      expect.objectContaining({ code: 'DELIVERY_FAILED' }),
    );
  });

  it('rejects missing credential material as MAIL04 before dialing', async () => {
    await expect(sendSmtpMessage({ ...makeInput(), password: '' })).rejects.toEqual(
      expect.objectContaining({ code: 'MAIL04' }),
    );
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it('rejects control-character header material before assembling an envelope', async () => {
    const attempt = sendSmtpMessage(
      makeInput({ ...baseTransport, sender_name: 'Admin\r\nBcc: leak@example.com' }),
    );
    await expect(attempt).rejects.toEqual(expect.objectContaining({ code: 'DELIVERY_FAILED' }));
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it('honours execution-only SMTP_HOST/SMTP_PORT overrides (dev sink or corporate relay)', async () => {
    vi.stubEnv('SMTP_HOST', 'mailpit.internal');
    vi.stubEnv('SMTP_PORT', '1025');

    await sendSmtpMessage(makeInput());

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'mailpit.internal', port: 1025 }),
    );
  });

  it('refuses a malformed SMTP_PORT override with MAIL03', async () => {
    vi.stubEnv('SMTP_PORT', 'not-a-port');

    await expect(sendSmtpMessage(makeInput())).rejects.toEqual(
      expect.objectContaining({ code: 'MAIL03' }),
    );
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it('measures provider latency precisely on success and on failure', async () => {
    mockSendMail.mockImplementation(() => {
      return new Promise<{ messageId?: string }>((resolve) => {
        setTimeout(() => resolve({}), 30);
      });
    });
    const result = await sendSmtpMessage(makeInput());
    expect(result.latency_ms).toBeGreaterThanOrEqual(25);
    expect(result.latency_ms).toBeLessThan(5_000);

    mockSendMail.mockImplementation(() => {
      return new Promise<{ messageId?: string }>((_resolve, reject) => {
        setTimeout(() => reject(providerError('ECONNRESET')), 30);
      });
    });
    const error = await sendSmtpMessage(makeInput()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SmtpSendError);
    expect((error as SmtpSendError).latency_ms).toBeGreaterThanOrEqual(25);
  });

  it('reuses one deterministic Message-ID per request key (idempotent across attempts)', () => {
    const first = smtpMessageId(REQUEST_KEY);
    expect(first).toBe(smtpMessageId(REQUEST_KEY));
    expect(first).toContain(REQUEST_KEY);
    expect(first).not.toBe(smtpMessageId('b1c2d3e4-f5a6-4789-0123-abcdef123456'));
  });

  it('performs exactly one send attempt per call (retries belong to the gateway loop)', async () => {
    mockSendMail.mockImplementation(() => Promise.reject(providerError('ECONNRESET')));

    await expect(sendSmtpMessage(makeInput())).rejects.toEqual(
      expect.objectContaining({ code: 'MAIL03' }),
    );
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});
