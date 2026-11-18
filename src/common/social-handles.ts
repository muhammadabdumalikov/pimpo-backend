/**
 * Instagram and Telegram usernames, as an owner pastes them into the store
 * settings: "@zarastyle", "zarastyle", "https://instagram.com/zarastyle/",
 * "instagram.com/zarastyle?igsh=…", "t.me/zarastyle" all mean the same
 * account. Stored bare (no "@", no URL) so the storefront builds its own links.
 */

/**
 * Instagram: 1-30 letters, digits, periods and underscores; no period at
 * either end and never two in a row. Case-insensitive, shown lowercase.
 */
const INSTAGRAM_RE = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/;

/**
 * Telegram: 5-32 letters, digits and underscores, starting with a letter and
 * not ending with an underscore. Case-insensitive, but shown as typed.
 */
const TELEGRAM_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;

const INSTAGRAM_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
]);
const TELEGRAM_HOSTS = new Set([
  't.me',
  'www.t.me',
  'telegram.me',
  'www.telegram.me',
  'telegram.dog',
]);

// Instagram paths that are not a profile (a post, a reel, the explore page…).
const INSTAGRAM_NON_PROFILE = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'explore',
  'accounts',
  'direct',
  'about',
  'legal',
]);

// t.me paths that are not a user or channel (invites, sticker packs, shares…).
const TELEGRAM_NON_PROFILE = new Set([
  'joinchat',
  'addstickers',
  'addemoji',
  'addlist',
  'share',
  'proxy',
  'socks',
  'iv',
]);

/**
 * The handle inside whatever was pasted: the first path segment of a link to
 * one of `hosts`, or the text itself with a leading "@" dropped. Null for a
 * link to some other site. Path segments are returned whole, so a caller can
 * skip non-profile prefixes.
 */
function extract(raw: string, hosts: Set<string>): string[] | null {
  const text = raw.trim();
  // A bare "instagram.com" is the site, not an account named after it.
  if (hosts.has(text.toLowerCase())) return null;
  const looksLikeLink =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.includes('/');
  if (!looksLikeLink) return [text.replace(/^@/, '')];
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
    );
  } catch {
    return null;
  }
  if (!hosts.has(url.hostname.toLowerCase())) return null;
  // The username alphabets need no escaping, so a segment is taken as is; a
  // percent-encoded one can only fail the shape check later.
  return url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/^@/, ''));
}

/**
 * Canonical Instagram username (lowercase), or null when what was pasted is
 * not one: a link to another site, a post rather than a profile, or a name
 * Instagram would not allow.
 */
export function normalizeInstagram(
  raw: string | null | undefined,
): string | null {
  if (!raw?.trim()) return null;
  const parts = extract(raw, INSTAGRAM_HOSTS);
  if (!parts?.length) return null;
  // instagram.com/stories/<name>/… is still that profile.
  const name = parts[0].toLowerCase() === 'stories' ? parts[1] : parts[0];
  if (!name || INSTAGRAM_NON_PROFILE.has(name.toLowerCase())) return null;
  const handle = name.toLowerCase();
  return INSTAGRAM_RE.test(handle) ? handle : null;
}

/**
 * Canonical Telegram username (as typed), or null when what was pasted is not
 * one: a link to another site, a private invite ("t.me/+…", "t.me/joinchat/…")
 * or a name Telegram would not allow.
 */
export function normalizeTelegram(
  raw: string | null | undefined,
): string | null {
  if (!raw?.trim()) return null;
  const parts = extract(raw, TELEGRAM_HOSTS);
  if (!parts?.length) return null;
  // t.me/s/<channel> is the channel's web preview.
  const name = parts[0] === 's' ? parts[1] : parts[0];
  if (!name || TELEGRAM_NON_PROFILE.has(name.toLowerCase())) return null;
  return TELEGRAM_RE.test(name) ? name : null;
}
