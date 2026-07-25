/**
 * Builds the cache store(s) for the global CacheModule.
 *
 * Migrated from in-memory to Redis so cached data (subscription/limits, A-group
 * lists, aggregations, the stock-take + open-shift locks) is SHARED across
 * backend instances and SURVIVES deploys — an in-memory cache is per-process, so
 * a write-invalidation on one instance never reaches another instance's copy,
 * and every restart cold-starts the cache. See [[pimpo-backend-caching]].
 *
 * Redis is used only when it's configured (REDIS_URL or REDIS_HOST). With no
 * Redis env set we fall back to the in-memory store, so local dev / tests keep
 * working with zero infra.
 *
 * Resilience: Keyv's `throwOnErrors` defaults to false, so a Redis error is a
 * silent cache miss and `cache.wrap()` falls through to the DB. But a *failed
 * error* isn't the only failure mode — while Redis is unreachable, node-redis
 * keeps retrying to (re)connect and a command issued in the meantime HANGS
 * across those retries. So every store op is additionally bounded by a timeout
 * (REDIS_OP_TIMEOUT_MS, default 1s): a slow/unreachable Redis becomes a fast
 * miss → DB read, and the API never freezes. node-redis keeps reconnecting in
 * the background, so the cache recovers automatically once Redis is back.
 */
import {Logger} from '@nestjs/common';
import type {ConfigService} from '@nestjs/config';
import Keyv from 'keyv';
import KeyvRedis from '@keyv/redis';

/** Prefix for every key this app writes, so it can safely share a Redis DB. */
const NAMESPACE = 'pimpo';

const logger = new Logger('CacheStore');

/**
 * Date-preserving (de)serializer.
 *
 * The in-memory store kept values by reference, so cached Drizzle rows carried
 * real `Date` objects. Redis stores strings, and the default JSON serializer
 * turns Dates into ISO strings — which would silently break internal consumers
 * that call Date methods on cached values (e.g. subscription tier-gating does
 * `endDate.getTime()`). Marking Dates on write and reviving them on read keeps
 * Redis behaviour identical to the old in-memory store.
 *
 * The replacer uses `this[key]` (the holder) to see the RAW value before Date's
 * own `toJSON()` has already turned it into a string.
 */
const DATE_MARK = '__pimpo_date';

function serialize(data: unknown): string {
  return JSON.stringify(data, function (this: Record<string, unknown>, key, value) {
    const raw = this[key];
    return raw instanceof Date ? {[DATE_MARK]: raw.toISOString()} : value;
  });
}

function deserialize<T>(text: string): T {
  return JSON.parse(text, (_key, value) => {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>)[DATE_MARK] === 'string'
    ) {
      return new Date((value as Record<string, string>)[DATE_MARK]);
    }
    return value;
  }) as T;
}

/**
 * Race a store operation against a timeout so a slow/unreachable Redis can't
 * stall a request. On timeout (or rejection) we resolve `fallback` — for `get`
 * that's `undefined` (a cache miss → DB), for `set`/`delete` a no-op success.
 * The underlying redis command is left to settle and be ignored.
 */
function withOpTimeout<T>(
  run: () => Promise<T>,
  ms: number,
  fallback: T,
  op: string,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      logger.warn(`Redis ${op} exceeded ${ms}ms — treating as cache miss.`);
      done(fallback);
    }, ms);
    run().then(done, () => done(fallback));
  });
}

/**
 * Wrap the get/set/delete/clear methods cache-manager calls on the Keyv store so
 * each is bounded by `timeoutMs`. Keyv's own methods don't call one another, so
 * overriding them in place is safe.
 */
function boundStoreOps(keyv: Keyv, timeoutMs: number): void {
  // These are overloaded methods; wrap them generically (any[] args) and cast
  // back through `unknown` since a single arrow can't restate every overload.
  const wrap =
    <T>(raw: (...a: any[]) => Promise<T>, fallback: T, op: string) =>
    (...args: any[]) =>
      withOpTimeout(() => raw(...args), timeoutMs, fallback, op);

  keyv.get = wrap(keyv.get.bind(keyv), undefined, 'get') as unknown as Keyv['get'];
  keyv.set = wrap(keyv.set.bind(keyv), true, 'set') as unknown as Keyv['set'];
  keyv.delete = wrap(keyv.delete.bind(keyv), true, 'delete') as unknown as Keyv['delete'];
  keyv.clear = wrap(keyv.clear.bind(keyv), undefined, 'clear') as unknown as Keyv['clear'];
}

/**
 * Resolve the Redis connection string from env.
 * - REDIS_URL wins if set (full `redis[s]://user:pass@host:port` from a provider).
 * - Otherwise assembled from REDIS_HOST / REDIS_PORT / REDIS_USERNAME /
 *   REDIS_PASSWORD, with REDIS_TLS=true switching the scheme to `rediss://`.
 * Returns null when no Redis is configured (→ in-memory fallback).
 */
function resolveRedisUrl(config: ConfigService): string | null {
  const explicit = config.get<string>('REDIS_URL');
  if (explicit) return explicit;

  const host = config.get<string>('REDIS_HOST');
  if (!host) return null;

  const port = config.get<string>('REDIS_PORT');
  const username = config.get<string>('REDIS_USERNAME');
  const password = config.get<string>('REDIS_PASSWORD');
  const scheme =
    String(config.get('REDIS_TLS')).toLowerCase() === 'true' ? 'rediss' : 'redis';

  // Credentials are URL-encoded so passwords with @ : / etc. don't corrupt the URL.
  let auth = '';
  if (username || password) {
    auth = `${encodeURIComponent(username ?? '')}:${encodeURIComponent(
      password ?? '',
    )}@`;
  }
  return `${scheme}://${auth}${host}:${port}`;
}

/**
 * Options for `CacheModule.registerAsync`. Returns a Redis-backed Keyv store
 * when configured, else `undefined` stores (cache-manager's default in-memory).
 */
export function buildCacheOptions(config: ConfigService): {
  stores?: Keyv[];
  ttl: number;
} {
  // Fallback default TTL (ms); every call site passes an explicit TTL to wrap().
  const ttl = 60_000;

  const url = resolveRedisUrl(config);
  if (!url) {
    logger.warn('No REDIS_URL/REDIS_HOST set — using in-memory cache (per-process).');
    return {ttl};
  }

  const adapter = new KeyvRedis(
    {
      url,
      // Bound the initial connect so requests can't hang forever if Redis is down.
      socket: {connectTimeout: 10_000},
      // Keep the offline queue ENABLED: node-redis connects lazily on the first
      // command, so with it disabled that first request (and every command during
      // a reconnect window) fails "The client is offline". Queuing lets those wait
      // for the socket instead; the per-op timeout below still caps any real
      // outage to a fast DB fallback, so nothing can hang.
    },
    {namespace: NAMESPACE},
  );
  adapter.namespace = NAMESPACE;

  const keyv = new Keyv(adapter, {
    namespace: NAMESPACE,
    // KeyvRedis owns the namespace prefix; don't let Keyv double-prefix keys.
    useKeyPrefix: false,
    serialize,
    deserialize,
  });

  // Never let a Redis connection error become an unhandled rejection; it's
  // already handled as a cache miss (throwOnErrors=false → DB fallback). While
  // Redis is unreachable this fires on EVERY command, so throttle to one log per
  // 30s (with a suppressed-count) instead of flooding the console.
  let lastErrLogAt = 0;
  let suppressed = 0;
  keyv.on('error', (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    if (now - lastErrLogAt >= 30_000) {
      const extra = suppressed > 0 ? ` (+${suppressed} similar suppressed)` : '';
      logger.warn(`Redis cache unavailable — serving from DB. ${msg}${extra}`);
      lastErrLogAt = now;
      suppressed = 0;
    } else {
      suppressed += 1;
    }
  });

  // Bound every op so an unreachable/slow Redis degrades to a DB read instead of
  // hanging the request. Default 1s; tune via REDIS_OP_TIMEOUT_MS.
  const opTimeout = Number(config.get('REDIS_OP_TIMEOUT_MS')) || 1000;
  boundStoreOps(keyv, opTimeout);

  const safeHost = url.replace(/\/\/[^@]*@/, '//');
  logger.log(`Using Redis cache at ${safeHost} (namespace "${NAMESPACE}").`);

  // Warm the (lazy) connection at boot so the first user request doesn't pay the
  // connect latency — and so a bad config surfaces now, not on first traffic.
  void keyv
    .get('__warmup__')
    .then(() => logger.log('Redis connection established.'))
    .catch(() => {
      /* handled by the throttled error listener above */
    });

  return {stores: [keyv], ttl};
}
