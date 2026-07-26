/**
 * Shared Redis connection resolution from env — used by BOTH the cache store
 * (Keyv/@keyv/redis) and the BullMQ queue, so they read the same variables and
 * agree on whether Redis is configured.
 *
 * Config: `REDIS_URL` wins (full `redis[s]://user:pass@host:port`), else it's
 * assembled from `REDIS_HOST` / `REDIS_PORT` / `REDIS_USERNAME` /
 * `REDIS_PASSWORD`, with `REDIS_TLS=true` switching to `rediss://`. All return
 * null when nothing is set → callers fall back (in-memory cache / direct send).
 */

export type RedisGetter = (key: string) => string | undefined;

/** A getter backed by a plain env object (default: process.env). */
export function envGetter(env: NodeJS.ProcessEnv = process.env): RedisGetter {
  return (key) => env[key];
}

/** `redis[s]://user:pass@host:port` from env, or null when unconfigured. */
export function resolveRedisUrl(get: RedisGetter): string | null {
  const explicit = get('REDIS_URL');
  if (explicit) return explicit;

  const host = get('REDIS_HOST');
  if (!host) return null;

  const port = get('REDIS_PORT') || '6379';
  const username = get('REDIS_USERNAME');
  const password = get('REDIS_PASSWORD');
  const scheme =
    String(get('REDIS_TLS')).toLowerCase() === 'true' ? 'rediss' : 'redis';

  // Credentials are URL-encoded so passwords with @ : / etc. don't corrupt the URL.
  let auth = '';
  if (username || password) {
    auth = `${encodeURIComponent(username ?? '')}:${encodeURIComponent(
      password ?? '',
    )}@`;
  }
  return `${scheme}://${auth}${host}:${port}`;
}

/** ioredis-style connection options (what BullMQ's `connection` accepts). */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  // ioredis enables TLS when this key is present (empty object = default TLS).
  tls?: Record<string, never>;
  // BullMQ REQUIRES this for its blocking worker connections.
  maxRetriesPerRequest: null;
}

/**
 * Connection options for BullMQ, or null when Redis is unconfigured. Builds the
 * URL (covering both REDIS_URL and the discrete parts) then parses it, so the
 * two config styles resolve to one shape.
 */
export function resolveRedisConnection(
  get: RedisGetter,
): RedisConnectionOptions | null {
  const url = resolveRedisUrl(get);
  if (!url) return null;

  const u = new URL(url);
  const opts: RedisConnectionOptions = {
    host: u.hostname,
    port: Number(u.port) || 6379,
    maxRetriesPerRequest: null,
  };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.protocol === 'rediss:') opts.tls = {};
  return opts;
}
