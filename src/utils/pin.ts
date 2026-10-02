import {randomBytes, scrypt, timingSafeEqual, type ScryptOptions} from 'crypto';

/**
 * Till PINs are 4–6 digits, so the whole space is at most a million guesses.
 * Unlike passwords (utils/password.ts, one salted SHA-256), a PIN hash is
 * shipped to the bound desktop so cashiers can sign in offline — a fast hash
 * would hand anyone holding that file every PIN in seconds. scrypt makes each
 * guess cost real memory and time, and needs nothing beyond Node's crypto, so
 * the desktop app verifies the same string without extra dependencies.
 *
 * Async on purpose: one scrypt is tens of milliseconds of CPU, which the sync
 * variant would spend blocking every other request on the server.
 *
 * Format: `scrypt$N$r$p$saltHex$hashHex`.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;

export const PIN_PATTERN = /^\d{4,6}$/;

function derive(
  pin: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pin, salt, keyLen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(pin, salt, KEY_LEN, {N, r: R, p: P});
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await derive(
    pin,
    Buffer.from(saltHex, 'hex'),
    expected.length,
    {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    },
  );
  return timingSafeEqual(actual, expected);
}
