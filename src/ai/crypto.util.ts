import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Symmetric encryption for BYOK provider keys at rest.
 *
 * A shop owner's Anthropic/OpenAI/Gemini key is a real credential we are only
 * holding on their behalf, so it never lands in the database as plaintext and
 * is never echoed back by the API — the UI shows `apiKeyLast4` instead.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently yielding garbage that we'd then send to a provider.
 *
 * Format: `v1:<iv_b64>:<tag_b64>:<cipher_b64>`. The `v1` prefix exists so a
 * future key rotation or algorithm change can be detected per row.
 */

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;

// Fixed salt: the secret is already high-entropy (an operator-generated env
// var), and a per-row salt would mean storing it alongside the ciphertext for
// no gain here. scrypt is used to stretch an arbitrary-length secret to 32 bytes.
const SALT = 'pimpo.ai.key.v1';

let cachedKey: Buffer | null = null;

/**
 * Resolves the master key from `AI_KEY_ENCRYPTION_SECRET`.
 *
 * Throws when unset — callers must treat that as "the AI feature is not
 * configured" and fail closed. We deliberately do NOT fall back to JWT_SECRET
 * or any other existing secret: reusing one secret for two purposes means
 * rotating either one silently breaks the other.
 */
function masterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const secret = process.env.AI_KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'AI_KEY_ENCRYPTION_SECRET is unset or shorter than 16 characters. ' +
        'Generate one with `openssl rand -base64 32`.',
    );
  }

  cachedKey = scryptSync(secret, SALT, KEY_BYTES);
  return cachedKey;
}

/** True when a master key is configured, without throwing. */
export function isEncryptionConfigured(): boolean {
  const secret = process.env.AI_KEY_ENCRYPTION_SECRET;
  return Boolean(secret && secret.length >= 16);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored key is not in the expected v1 envelope format.');
  }

  const [, ivB64, tagB64, cipherB64] = parts;
  const decipher = createDecipheriv(
    ALGO,
    masterKey(),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(cipherB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Display suffix for a raw key, e.g. `sk-ant-…9f2c` → `9f2c`. */
export function keyLast4(rawKey: string): string {
  return rawKey.trim().slice(-4);
}

/**
 * Constant-time compare, for the rare case we need to check whether an
 * incoming key equals the stored one without leaking length via timing.
 */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
