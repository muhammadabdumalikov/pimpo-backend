import {Injectable} from '@nestjs/common';
import {eq} from 'drizzle-orm';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {DatabaseService} from '../database/database.service';
import {billzMigrationState} from '../database/schema';
import {generateId} from '../utils/uuid';
import {BillzClientService} from './billz-client.service';
import {asRecord, extractList, mapCustomer, mapProduct} from './billz-mapping';
import type {
  ProbeEntity,
  ProbeResponse,
  ProbeSample,
} from './billz-import.types';
import type {CustomerMapping, ProductMapping} from './billz-mapping';

// Shape of the /v1/auth/login response (MIGRATSIYA.md §4A.0).
interface BillzLoginData {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}
interface BillzLoginResponse {
  code?: number;
  message?: string;
  error?: unknown;
  data?: BillzLoginData;
}

// Re-login a few minutes before the token actually expires so an in-flight
// migration never uses a token that lapses mid-request.
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
// Fallback TTL if BiLLZ omits/zeroes `expires_in`. Conservative (12h) so we
// re-login sooner rather than trusting a token past its real lifetime.
const DEFAULT_TOKEN_TTL_SECONDS = 12 * 60 * 60;

@Injectable()
export class BillzService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly client: BillzClientService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * Exchange a secret_token for a token pair via POST /v1/auth/login.
   *
   * HTTP 200 with a non-empty `data.access_token` is success. A 400/401/403 or
   * a 200 with no token means the key is invalid — a NORMAL outcome for a wrong
   * key, so it is NOT retried; it surfaces as BILLZ_TOKEN_INVALID. Rate-limit /
   * network exhaustion is already turned into BILLZ_UNAVAILABLE by the client.
   */
  async login(secretToken: string): Promise<BillzLoginData> {
    const {status, body} = await this.client.postJson<BillzLoginResponse>(
      '/v1/auth/login',
      {secret_token: secretToken},
    );
    const data = body?.data;
    if (status === 200 && data?.access_token) {
      return data;
    }
    throw new AppException(ErrorCode.BILLZ_TOKEN_INVALID);
  }

  /**
   * Verify a secret_token and connect the business: on success, upsert the
   * billz_migration_state row (secret + token pair + expiry + verifiedAt).
   * Throws BILLZ_TOKEN_INVALID for a bad key, BILLZ_UNAVAILABLE if BiLLZ is down.
   */
  async verify(
    businessId: string,
    secretToken: string,
  ): Promise<{expiresIn: number}> {
    const data = await this.login(secretToken);
    const expiresIn =
      typeof data.expires_in === 'number' && data.expires_in > 0
        ? data.expires_in
        : DEFAULT_TOKEN_TTL_SECONDS;
    const now = new Date();
    const tokenExpiresAt = new Date(now.getTime() + expiresIn * 1000);

    const set = {
      secretToken,
      accessToken: data.access_token ?? null,
      refreshToken: data.refresh_token ?? null,
      tokenExpiresAt,
      verifiedAt: now,
      updatedAt: now,
    };

    await this.db
      .insert(billzMigrationState)
      .values({id: generateId(), businessId, ...set})
      .onConflictDoUpdate({target: billzMigrationState.businessId, set});

    return {expiresIn};
  }

  /**
   * Return a usable access token for the business, re-authenticating when the
   * cached one is missing or within the expiry margin.
   *
   * NOTE: BiLLZ's refresh endpoint is not documented in MIGRATSIYA.md, so we do
   * NOT invent one — we re-login with the stored secret_token instead (the
   * refresh_token is still persisted for when the endpoint is documented, at
   * which point this can swap to a refresh call). Used by MG3 import calls.
   */
  async getAccessToken(businessId: string): Promise<string> {
    const [row] = await this.db
      .select()
      .from(billzMigrationState)
      .where(eq(billzMigrationState.businessId, businessId))
      .limit(1);
    if (!row) {
      // No connection on record — the business must verify a secret_token first.
      throw new AppException(ErrorCode.BILLZ_TOKEN_INVALID);
    }

    const now = Date.now();
    if (
      row.accessToken &&
      row.tokenExpiresAt &&
      row.tokenExpiresAt.getTime() - TOKEN_EXPIRY_MARGIN_MS > now
    ) {
      return row.accessToken;
    }

    // Expired / missing — re-login with the stored secret_token.
    const data = await this.login(row.secretToken);
    const expiresIn =
      typeof data.expires_in === 'number' && data.expires_in > 0
        ? data.expires_in
        : DEFAULT_TOKEN_TTL_SECONDS;
    const refreshedAt = new Date();
    const tokenExpiresAt = new Date(refreshedAt.getTime() + expiresIn * 1000);

    await this.db
      .update(billzMigrationState)
      .set({
        accessToken: data.access_token ?? null,
        refreshToken: data.refresh_token ?? row.refreshToken,
        tokenExpiresAt,
        updatedAt: refreshedAt,
      })
      .where(eq(billzMigrationState.businessId, businessId));

    // login() guarantees access_token is present on success.
    return data.access_token as string;
  }

  /** Connection status for the current business (row exists AND verified). */
  async getStatus(
    businessId: string,
  ): Promise<{connected: boolean; verifiedAt: string | null}> {
    const [row] = await this.db
      .select()
      .from(billzMigrationState)
      .where(eq(billzMigrationState.businessId, businessId))
      .limit(1);
    const verifiedAt = row?.verifiedAt ?? null;
    return {
      connected: !!verifiedAt,
      verifiedAt: verifiedAt ? verifiedAt.toISOString() : null,
    };
  }

  /**
   * MG2 probe: fetch ONE small page (5 records) of raw BiLLZ JSON and show it
   * alongside how the SHARED mapper (billz-mapping.ts) reads each field — the
   * exact same functions the import's LOAD phase uses, so `mapped` is guaranteed
   * identical to what a real import would read. READ-ONLY: no staging, no writes.
   *
   * `warnings` flags every guessed field that came back empty across ALL sampled
   * records (retail price, stock, customer phone, …) plus envelope/total misses,
   * so we can confirm which field-name guesses are wrong before trusting import.
   *
   * Requires a verified connection (BILLZ_NOT_CONNECTED otherwise). A client
   * throw (BILLZ_UNAVAILABLE, from exhausted 429/5xx/network retries) propagates;
   * any other non-200 is also surfaced as BILLZ_UNAVAILABLE (no new error codes).
   */
  async probe(businessId: string, entity: ProbeEntity): Promise<ProbeResponse> {
    const [conn] = await this.db
      .select({verifiedAt: billzMigrationState.verifiedAt})
      .from(billzMigrationState)
      .where(eq(billzMigrationState.businessId, businessId))
      .limit(1);
    if (!conn || !conn.verifiedAt) {
      throw new AppException(ErrorCode.BILLZ_NOT_CONNECTED);
    }

    const token = await this.getAccessToken(businessId);
    const path =
      entity === 'products'
        ? '/v2/products?page=1&limit=5'
        : '/v1/client?page=1&limit=5';
    const {status, body} = await this.client.request(path, {
      method: 'GET',
      headers: {accept: 'application/json', Authorization: `Bearer ${token}`},
    });
    if (status !== 200) {
      // 429/5xx/network already threw BILLZ_UNAVAILABLE inside the client; a
      // definitive non-200 here (e.g. a rejected token) reuses the same code.
      throw new AppException(ErrorCode.BILLZ_UNAVAILABLE);
    }

    const {records, total, envelopeKeys, arrayFound} = extractList(body);
    const sampleRecords = records.slice(0, 5);

    // Sorted union of keys seen across the sampled raw records.
    const keySet = new Set<string>();
    for (const r of sampleRecords) {
      const rec = asRecord(r);
      if (rec) for (const k of Object.keys(rec)) keySet.add(k);
    }
    const recordKeys = [...keySet].sort();

    const warnings: string[] = [];
    if (!arrayFound) {
      warnings.push('no record array found under known envelope keys');
    } else if (sampleRecords.length === 0) {
      warnings.push('BiLLZ returned no records for this entity');
    }
    if (total == null) {
      warnings.push('total count not detected in the response envelope');
    }

    if (entity === 'products') {
      const samples: ProbeSample<ProductMapping>[] = sampleRecords.map((r) => {
        const mapped = mapProduct(r);
        return {billzId: mapped.billzId, raw: asRecord(r) ?? {}, mapped};
      });
      warnings.push(...this.productFieldWarnings(samples.map((s) => s.mapped)));
      return {
        entity,
        totalReported: total,
        envelopeKeys,
        recordKeys,
        samples,
        warnings,
      };
    }

    const samples: ProbeSample<CustomerMapping>[] = sampleRecords.map((r) => {
      const mapped = mapCustomer(r);
      return {billzId: mapped.billzId, raw: asRecord(r) ?? {}, mapped};
    });
    warnings.push(...this.customerFieldWarnings(samples.map((s) => s.mapped)));
    return {
      entity,
      totalReported: total,
      envelopeKeys,
      recordKeys,
      samples,
      warnings,
    };
  }

  /**
   * A guessed product field is "not found" when it is empty (null, or a zeroed
   * price/stock) across EVERY sampled record — a strong signal the candidate key
   * is wrong. Empty when there are no samples (checked by the caller).
   */
  private productFieldWarnings(mapped: ProductMapping[]): string[] {
    if (mapped.length === 0) return [];
    const w: string[] = [];
    if (mapped.every((m) => m.name == null))
      w.push('product name not found in any sampled record (tried name)');
    if (mapped.every((m) => m.sku == null))
      w.push('sku not found in any sampled record (tried sku)');
    if (mapped.every((m) => m.barcode == null))
      w.push('barcode not found in any sampled record (tried barcode)');
    if (mapped.every((m) => Number(m.priceIn) === 0))
      w.push(
        'supply price (priceIn) not found in any sampled record (tried shop_prices[].supply_price)',
      );
    if (mapped.every((m) => Number(m.priceOut) === 0))
      w.push(
        'retail price (priceOut) not found in any sampled record (tried shop_prices[].retail_price, shop_prices[].price)',
      );
    if (mapped.every((m) => m.stock === 0))
      w.push(
        'stock not found in any sampled record (tried shop_measurement_values[].active_measurement_value)',
      );
    if (mapped.every((m) => m.brandName == null))
      w.push('brand name not found in any sampled record (tried brand_name)');
    if (mapped.every((m) => m.categoryName == null))
      w.push(
        'category name not found in any sampled record (tried categories[0].name)',
      );
    if (mapped.every((m) => m.unitName == null))
      w.push(
        'unit name not found in any sampled record (tried measurement_unit.name)',
      );
    return w;
  }

  /** As productFieldWarnings, for the customer entity's guessed fields. */
  private customerFieldWarnings(mapped: CustomerMapping[]): string[] {
    if (mapped.length === 0) return [];
    const w: string[] = [];
    if (mapped.every((m) => m.name == null))
      w.push(
        'customer name not found in any sampled record (tried name, full_name, first_name+last_name+middle_name)',
      );
    if (mapped.every((m) => m.phone == null))
      w.push(
        'customer phone not found in any sampled record (tried phone_numbers[], phone_number, phone, mobile_phone, mobile)',
      );
    return w;
  }
}
