import {Injectable, Logger} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';

const DEFAULT_BASE_URL = 'https://api-admin.billz.ai';

// Throttle: minimum gap between the *start* of consecutive requests. 800ms base
// plus 100-300ms random jitter → 900-1100ms apart ≈ 0.9-1.1 req/s, comfortably
// under BiLLZ's documented 2 req/s hard limit (MIGRATSIYA.md §3/§3.1).
const MIN_GAP_MS = 800;
const JITTER_MIN_MS = 100;
const JITTER_MAX_MS = 300;

// Retry budgets. A 429 is retried more aggressively than a transient
// network/5xx failure because it is an explicit "slow down" rather than an
// outage. Exhausting either budget surfaces as BILLZ_UNAVAILABLE.
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_ERROR_RETRIES = 3;

// Exponential backoff 1s → 2s → 4s → 8s → … capped at 60s.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

// Per-request timeout (AbortController).
const REQUEST_TIMEOUT_MS = 15_000;

/** Parsed response handed back to callers: HTTP status + best-effort JSON body. */
export interface BillzResponse<T = unknown> {
  status: number;
  body: T | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rate-limited HTTP client for the BiLLZ 2.0 admin API (api-admin.billz.ai).
 *
 * Guarantees required by MIGRATSIYA.md §3.1 (mandatory to avoid the heuristic
 * black-list):
 *  - concurrency = 1: a promise-chain queue serializes every request so calls
 *    never overlap (no burst that looks like a bot/DDoS).
 *  - throttle: ~800ms + jitter between request starts (≤ ~1.1 req/s).
 *  - 429 → honor Retry-After, else exponential backoff, retry up to 5×.
 *  - network error / 5xx → exponential backoff, retry up to 3×.
 *  - per-request 15s timeout.
 *
 * 2xx and 4xx responses are returned to the caller untouched (a 4xx such as a
 * rejected secret_token is a normal outcome the caller interprets — never a
 * retry). Only exhausted retries / persistent outages throw BILLZ_UNAVAILABLE.
 */
@Injectable()
export class BillzClientService {
  private readonly logger = new Logger(BillzClientService.name);

  // Serial queue tail: every request chains onto this promise so at most one
  // request is ever in flight (concurrency = 1).
  private queue: Promise<unknown> = Promise.resolve();
  // Epoch ms at which the last request was allowed to start (for throttling).
  private lastStartAt = 0;

  private get baseUrl(): string {
    return (process.env.BILLZ_API_BASE || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /** POST a JSON body and return the raw status + parsed JSON body. */
  postJson<T = unknown>(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<BillzResponse<T>> {
    return this.request<T>(path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Queue a request behind all prior ones, throttle it, then run it through the
   * retry loop. The chain is kept alive across failures so one error can never
   * wedge the queue.
   */
  request<T = unknown>(
    path: string,
    init: RequestInit,
  ): Promise<BillzResponse<T>> {
    const run = this.queue.then(async () => {
      await this.throttle();
      return this.executeWithRetry<T>(path, init);
    });
    // Swallow the result/error on the queue tail only — callers still get `run`.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Sleep just long enough to keep consecutive request starts ≥ MIN_GAP+jitter. */
  private async throttle(): Promise<void> {
    const jitter =
      JITTER_MIN_MS +
      Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1));
    const gap = MIN_GAP_MS + jitter;
    const wait = this.lastStartAt + gap - Date.now();
    if (wait > 0) {
      await delay(wait);
    }
    this.lastStartAt = Date.now();
  }

  private async executeWithRetry<T>(
    path: string,
    init: RequestInit,
  ): Promise<BillzResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    let rateLimitRetries = 0;
    let errorRetries = 0;

    for (;;) {
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, init);
      } catch (e) {
        // Network failure or timeout (AbortError) — retry with backoff.
        errorRetries += 1;
        if (errorRetries > MAX_ERROR_RETRIES) {
          this.logger.warn(
            `BiLLZ request failed after ${MAX_ERROR_RETRIES} retries: ${
              (e as Error).message
            }`,
          );
          throw new AppException(ErrorCode.BILLZ_UNAVAILABLE);
        }
        await delay(this.backoff(errorRetries));
        continue;
      }

      if (res.status === 429) {
        rateLimitRetries += 1;
        if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
          this.logger.warn(
            `BiLLZ rate limit not clearing after ${MAX_RATE_LIMIT_RETRIES} retries`,
          );
          throw new AppException(ErrorCode.BILLZ_UNAVAILABLE);
        }
        const retryAfter = this.parseRetryAfter(res.headers.get('retry-after'));
        await delay(retryAfter ?? this.backoff(rateLimitRetries));
        continue;
      }

      if (res.status >= 500) {
        errorRetries += 1;
        if (errorRetries > MAX_ERROR_RETRIES) {
          this.logger.warn(
            `BiLLZ returned ${res.status} after ${MAX_ERROR_RETRIES} retries`,
          );
          throw new AppException(ErrorCode.BILLZ_UNAVAILABLE);
        }
        await delay(this.backoff(errorRetries));
        continue;
      }

      // 2xx or 4xx — a definitive answer the caller interprets.
      const bodyText = await res.text();
      return {status: res.status, body: this.parseJson<T>(bodyText)};
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {...init, signal: controller.signal});
    } finally {
      clearTimeout(timer);
    }
  }

  /** attempt is 1-based: 1s, 2s, 4s, 8s, 16s … capped at 60s. */
  private backoff(attempt: number): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  }

  /** Retry-After is either delta-seconds or an HTTP date; clamp to [0, 60s]. */
  private parseRetryAfter(header: string | null): number | null {
    if (!header) {
      return null;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds, 0) * 1000, BACKOFF_MAX_MS);
    }
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), BACKOFF_MAX_MS);
    }
    return null;
  }

  private parseJson<T>(text: string): T | null {
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}
