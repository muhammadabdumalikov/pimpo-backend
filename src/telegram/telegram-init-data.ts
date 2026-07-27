import {createHmac, timingSafeEqual} from 'crypto';

/**
 * Telegram Mini App launch-payload verification.
 *
 * When the storefront runs inside Telegram it receives a signed `initData`
 * string. Anyone can POST an arbitrary one, so it is only ever trusted after
 * the HMAC below checks out against the bot token — that signature is what
 * turns "some visitor" into a known Telegram user id, with no password, OTP or
 * session of our own.
 *
 * Pure function, no DI: the store module uses it on public endpoints.
 */

export interface VerifiedTelegramUser {
  /** Telegram user id (numeric, kept as a string — it exceeds 2^32). */
  id: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  /** Unix seconds the payload was signed at. */
  authDate: number;
}

/** Launch payloads older than this are rejected as replays. */
const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

interface InitDataUser {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

/**
 * Verify a raw `initData` query string against the bot token.
 * Returns the signed-for user, or null when anything fails (bad signature,
 * stale payload, missing user) — callers treat null as "anonymous", never as
 * an error worth leaking details about.
 */
export function verifyTelegramInitData(
  initData: string | null | undefined,
  botToken: string | undefined,
  maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
): VerifiedTelegramUser | null {
  if (!initData || !botToken) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const hash = params.get('hash');
  if (!hash) return null;

  // Every field except `hash` and `signature` (the latter belongs to Telegram's
  // separate third-party Ed25519 scheme), sorted BY KEY, one `key=value` per
  // line. Sorting the joined strings instead would order differently whenever
  // one key is a prefix of another.
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash' && key !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const expected = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const received = Buffer.from(hash, 'hex');
  const computed = Buffer.from(expected, 'hex');
  if (
    received.length !== computed.length ||
    !timingSafeEqual(received, computed)
  ) {
    return null;
  }

  // A valid signature is forever valid, so freshness is what stops a leaked
  // payload from being replayed months later.
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds) return null;

  const rawUser = params.get('user');
  if (!rawUser) return null;
  let user: InitDataUser;
  try {
    user = JSON.parse(rawUser) as InitDataUser;
  } catch {
    return null;
  }
  if (!user.id || !Number.isFinite(user.id)) return null;

  return {
    id: String(user.id),
    firstName: user.first_name ?? null,
    lastName: user.last_name ?? null,
    username: user.username ?? null,
    languageCode: user.language_code ?? null,
    authDate,
  };
}

/** Display name for a verified user ("Ali Valiyev" / "@ali" / null). */
export function telegramDisplayName(user: VerifiedTelegramUser): string | null {
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  return user.username ? `@${user.username}` : null;
}
