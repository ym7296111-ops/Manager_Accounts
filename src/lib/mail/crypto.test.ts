// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret } from '@/lib/mail/crypto';
import type { MailCryptoError } from '@/lib/mail/crypto';

const MASTER_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

describe('mail secret envelope encryption (§1.5 Path B)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trips a secret with AES-256-GCM', async () => {
    vi.stubEnv('MAIL_MASTER_KEY', MASTER_KEY);
    vi.stubEnv('MAIL_MASTER_KEY_VERSION', 'test-key-v1');

    const plaintext = 'Smtp-secret-بريد-秘密';
    const suite = await encryptSecret(plaintext);

    expect(suite.cipher).toBe('aes-256-gcm');
    expect(suite.key_version).toBe('test-key-v1');
    expect(await decryptSecret(suite)).toBe(plaintext);
  });

  it('generates a new random nonce for each encryption of the same secret', async () => {
    vi.stubEnv('MAIL_MASTER_KEY', MASTER_KEY);

    const first = await encryptSecret('same secret');
    const second = await encryptSecret('same secret');

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects an altered authentication tag without exposing plaintext', async () => {
    vi.stubEnv('MAIL_MASTER_KEY', MASTER_KEY);
    const suite = await encryptSecret('authenticated data');
    const altered: typeof suite = {
      ...suite,
      tag: `${suite.tag[0] === 'A' ? 'B' : 'A'}${suite.tag.slice(1)}`,
    };

    await expect(decryptSecret(altered)).rejects.toMatchObject<Partial<MailCryptoError>>({
      code: 'MAIL_SECRET_DECRYPT_FAILED',
    });
  });
});
