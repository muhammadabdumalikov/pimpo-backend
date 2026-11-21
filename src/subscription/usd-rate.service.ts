import {Injectable, Logger} from '@nestjs/common';
import {USD_RATE_FALLBACK} from '../billing/ai-usage';

const CBU_URL = 'https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/';
const FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4_000;

/**
 * So'm per US dollar, for turning a model's dollar price into what a shop
 * pays (billing/ai-usage.ts). The Central Bank's official rate, read a few
 * times a day and kept in memory: an answer must never wait on, or fail
 * because of, somebody else's server — so when it cannot be read the last
 * rate we saw is used, and before any was seen `USD_UZS_RATE` or the
 * fallback constant.
 */
@Injectable()
export class UsdRateService {
  private readonly logger = new Logger(UsdRateService.name);
  private rate: number | null = null;
  private nextFetchAt = 0;
  private inFlight: Promise<void> | null = null;

  /** Never throws, never blocks longer than one bounded fetch. */
  async get(): Promise<number> {
    if (Date.now() >= this.nextFetchAt) {
      this.inFlight ??= this.refresh().finally(() => {
        this.inFlight = null;
      });
      // Only the very first reader waits; later ones get the rate in hand.
      if (this.rate == null) await this.inFlight;
    }
    return this.rate ?? this.configured();
  }

  private configured(): number {
    const env = Number(process.env.USD_UZS_RATE);
    return Number.isFinite(env) && env > 0 ? env : USD_RATE_FALLBACK;
  }

  private async refresh(): Promise<void> {
    try {
      const res = await fetch(CBU_URL, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {Rate?: string}[];
      const rate = Number(body?.[0]?.Rate);
      // A rate far off anything plausible is a broken answer, not a devaluation.
      if (!Number.isFinite(rate) || rate < 1_000 || rate > 1_000_000) {
        throw new Error(`unexpected rate ${body?.[0]?.Rate}`);
      }
      this.rate = rate;
      this.nextFetchAt = Date.now() + FRESH_MS;
    } catch (e) {
      this.nextFetchAt = Date.now() + RETRY_MS;
      this.logger.warn(
        `USD rate not read (${(e as Error).message}); using ${this.rate ?? this.configured()}`,
      );
    }
  }
}
