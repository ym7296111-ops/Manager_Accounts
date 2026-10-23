/**
 * §1.5 Path B — AES-256-GCM envelope encryption for mail transport secrets.
 * The 32-byte DEK is loaded only from the worker runtime's `MAIL_MASTER_KEY` (Base64); it is never
 * compiled into the UI or stored in Postgres. Cipher fields use Base64 at the worker boundary and
 * are converted to Postgres `bytea` by the gateway adapter.
 */

export interface CipherSuite {
  readonly cipher: 'aes-256-gcm';
  /** Base64 of the GCM ciphertext (the 16-byte authentication tag is stored separately). */
  readonly ciphertext: string;
  /** Base64 96-bit IV / nonce; a fresh random value is generated for every encryption. */
  readonly nonce: string;
  /** Base64 128-bit GCM authentication tag. */
  readonly tag: string;
  /** Non-secret key label for operations/audit; cryptographic key bytes remain environment-only. */
  readonly key_version?: string;
}

export type MailCryptoErrorCode =
  | 'MAIL_MASTER_KEY_UNAVAILABLE'
  | 'MAIL_MASTER_KEY_INVALID'
  | 'MAIL_CIPHER_SUITE_INVALID'
  | 'MAIL_ENCRYPTION_FAILED'
  | 'MAIL_SECRET_DECRYPT_FAILED';

export class MailCryptoError extends Error {
  readonly code: MailCryptoErrorCode;

  constructor(code: MailCryptoErrorCode) {
    // §3.4: Keep errors value-free; in particular, never echo key material or plaintext.
    super(code);
    this.code = code;
    this.name = 'MailCryptoError';
  }
}

const AES_GCM_CIPHER = 'aes-256-gcm' as const;
const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

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
    // Deno can deliberately withhold environment permissions; continue to the Node test fallback.
  }
  return runtime.process?.env?.[name];
}

function webCrypto(): Crypto {
  const available = globalThis.crypto;
  if (available?.subtle === undefined || available.getRandomValues === undefined) {
    throw new MailCryptoError('MAIL_ENCRYPTION_FAILED');
  }
  return available;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function decodeBase64(value: string): Uint8Array {
  // Base64 is deliberately strict so truncated/URL-safe values cannot be silently normalized.
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new MailCryptoError('MAIL_CIPHER_SUITE_INVALID');
  }

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new MailCryptoError('MAIL_CIPHER_SUITE_INVALID');
  }
}

function decodeMasterKey(): Uint8Array {
  const encodedKey = getRuntimeEnvironmentValue('MAIL_MASTER_KEY');
  if (encodedKey === undefined || encodedKey.trim() === '') {
    throw new MailCryptoError('MAIL_MASTER_KEY_UNAVAILABLE');
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeBase64(encodedKey.trim());
  } catch {
    throw new MailCryptoError('MAIL_MASTER_KEY_INVALID');
  }
  if (keyBytes.length !== AES_KEY_BYTES) {
    keyBytes.fill(0);
    throw new MailCryptoError('MAIL_MASTER_KEY_INVALID');
  }
  return keyBytes;
}

async function importMasterKey(usage: KeyUsage): Promise<CryptoKey> {
  const cryptoApi = webCrypto();
  const keyBytes = decodeMasterKey();
  const keyBuffer = toArrayBuffer(keyBytes);
  try {
    return await cryptoApi.subtle.importKey(
      'raw',
      keyBuffer,
      { name: 'AES-GCM', length: AES_KEY_BYTES * 8 },
      false,
      [usage],
    );
  } catch {
    throw new MailCryptoError('MAIL_MASTER_KEY_INVALID');
  } finally {
    // Best-effort zeroization of both mutable key buffers after Web Crypto imports them.
    keyBytes.fill(0);
    new Uint8Array(keyBuffer).fill(0);
  }
}

function createRandomNonce(cryptoApi: Crypto): Uint8Array {
  const nonce = new Uint8Array(GCM_NONCE_BYTES);
  do {
    cryptoApi.getRandomValues(nonce);
  } while (nonce.every((byte) => byte === 0));
  return nonce;
}

/** §1.5 Path B: AES-256-GCM with a fresh 96-bit nonce and separated 128-bit authentication tag. */
export async function encryptSecret(plaintext: string): Promise<CipherSuite> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new MailCryptoError('MAIL_ENCRYPTION_FAILED');
  }

  const cryptoApi = webCrypto();
  const key = await importMasterKey('encrypt');
  const nonce = createRandomNonce(cryptoApi);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const nonceBuffer = toArrayBuffer(nonce);
  const plaintextBuffer = toArrayBuffer(plaintextBytes);
  let sealedBytes: Uint8Array | null = null;

  try {
    sealedBytes = new Uint8Array(
      await cryptoApi.subtle.encrypt(
        { name: 'AES-GCM', iv: nonceBuffer, tagLength: GCM_TAG_BYTES * 8 },
        key,
        plaintextBuffer,
      ),
    );
    if (sealedBytes.length < GCM_TAG_BYTES) {
      throw new MailCryptoError('MAIL_ENCRYPTION_FAILED');
    }

    const tagStart = sealedBytes.length - GCM_TAG_BYTES;
    const ciphertextBytes = sealedBytes.slice(0, tagStart);
    const tagBytes = sealedBytes.slice(tagStart);
    const keyVersion = getRuntimeEnvironmentValue('MAIL_MASTER_KEY_VERSION')?.trim();

    return {
      cipher: AES_GCM_CIPHER,
      ciphertext: encodeBase64(ciphertextBytes),
      nonce: encodeBase64(nonce),
      tag: encodeBase64(tagBytes),
      ...(keyVersion ? { key_version: keyVersion } : {}),
    };
  } catch (error) {
    if (error instanceof MailCryptoError) {
      throw error;
    }
    throw new MailCryptoError('MAIL_ENCRYPTION_FAILED');
  } finally {
    // AES-GCM output is not plaintext, but clearing temporary buffers reduces accidental retention.
    plaintextBytes.fill(0);
    new Uint8Array(plaintextBuffer).fill(0);
    new Uint8Array(nonceBuffer).fill(0);
    sealedBytes?.fill(0);
    nonce.fill(0);
  }
}

/**
 * §1.5 Path B: authenticate and decrypt a stored AES-256-GCM CipherSuite.
 * The decoded plaintext byte buffer is wiped in `finally`. JavaScript strings are immutable and
 * cannot be reliably zeroized; callers must keep the returned value short-lived and never log/cache it.
 */
export async function decryptSecret(ciphertext: CipherSuite): Promise<string> {
  if (
    typeof ciphertext !== 'object' ||
    ciphertext === null ||
    ciphertext.cipher !== AES_GCM_CIPHER ||
    typeof ciphertext.ciphertext !== 'string' ||
    typeof ciphertext.nonce !== 'string' ||
    typeof ciphertext.tag !== 'string'
  ) {
    throw new MailCryptoError('MAIL_CIPHER_SUITE_INVALID');
  }

  const ciphertextBytes = decodeBase64(ciphertext.ciphertext);
  const nonceBytes = decodeBase64(ciphertext.nonce);
  const tagBytes = decodeBase64(ciphertext.tag);
  if (nonceBytes.length !== GCM_NONCE_BYTES || tagBytes.length !== GCM_TAG_BYTES) {
    ciphertextBytes.fill(0);
    nonceBytes.fill(0);
    tagBytes.fill(0);
    throw new MailCryptoError('MAIL_CIPHER_SUITE_INVALID');
  }

  const sealedBytes = new Uint8Array(ciphertextBytes.length + tagBytes.length);
  sealedBytes.set(ciphertextBytes);
  sealedBytes.set(tagBytes, ciphertextBytes.length);
  ciphertextBytes.fill(0);
  tagBytes.fill(0);

  const nonceBuffer = toArrayBuffer(nonceBytes);
  const sealedBuffer = toArrayBuffer(sealedBytes);
  let plaintextBytes: Uint8Array | null = null;
  try {
    const cryptoApi = webCrypto();
    const key = await importMasterKey('decrypt');
    plaintextBytes = new Uint8Array(
      await cryptoApi.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceBuffer, tagLength: GCM_TAG_BYTES * 8 },
        key,
        sealedBuffer,
      ),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes);
  } catch {
    throw new MailCryptoError('MAIL_SECRET_DECRYPT_FAILED');
  } finally {
    // Zeroize mutable buffers on success and failure; the returned immutable string is caller-owned.
    plaintextBytes?.fill(0);
    sealedBytes.fill(0);
    new Uint8Array(sealedBuffer).fill(0);
    new Uint8Array(nonceBuffer).fill(0);
    nonceBytes.fill(0);
  }
}
