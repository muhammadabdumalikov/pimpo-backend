import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  loyaltySettings,
  loyaltyTransactions,
  users,
  orders,
  type LoyaltySettings,
  type LoyaltyTier,
} from '../database/schema';
import { CacheKeys, TTL } from '../cache/cache.util';
import { UpdateLoyaltySettingsDto } from './dto/update-loyalty-settings.dto';
import {
  decodeCursor,
  encodeCursor,
  keysetBefore,
  type KeysetKey,
} from '../common/cursor';

// A customer row on the loyalty list — the balance/tier view of a customer.
export interface LoyaltyCustomer {
  id: string;
  name: string;
  phone: string;
  bonusBalance: string;
  totalSpent: string;
  tier: string | null;
  lastOrderAt: string | null;
}

// Program defaults before a business has ever saved — the program is off, and
// the numbers are the sensible starting values shown on the config page.
const DEFAULTS = {
  enabled: false,
  cashbackPercent: '0',
  minPurchase: '0',
  redeemMaxPercent: '50',
  expiryMonths: null as number | null,
  tiers: [] as LoyaltyTier[],
};

/**
 * Sort key of the customers list: balance first (the point of the screen — the
 * most-rewarded customer on top), then the signup date, then the id so rows
 * with the same balance — which is most of them, at 0 — still have exactly one
 * order for the cursor to resume from.
 */
const CUSTOMER_KEYS: KeysetKey[] = [
  {
    column: users.bonusBalance,
    cast: 'numeric',
    read: (row) => (row.bonusBalance ?? '0') as string,
  },
  {
    column: users.createdAt,
    cast: 'timestamp',
    read: (row) => (row.createdAt ?? null) as Date | null,
  },
  { column: users.id, cast: 'text', read: (row) => (row.id ?? '') as string },
];

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Loyalty settings for a business, falling back to defaults if unset. */
  async getSettings(businessId: string): Promise<LoyaltySettings> {
    return this.cache.wrap(
      CacheKeys.loyaltySettings(businessId),
      async () => {
        const [row] = await this.dbService.db
          .select()
          .from(loyaltySettings)
          .where(eq(loyaltySettings.businessId, businessId))
          .limit(1);

        if (row) return row;
        return {
          businessId,
          ...DEFAULTS,
          updatedAt: new Date(),
        };
      },
      TTL.LOYALTY,
    );
  }

  /** Upsert: create the row on first save, update it thereafter. */
  async updateSettings(
    businessId: string,
    dto: UpdateLoyaltySettingsDto,
  ): Promise<LoyaltySettings> {
    const current = await this.getSettings(businessId);
    // Decimals are stored/returned as strings; normalize numeric input to
    // strings so the column type and the cached shape stay consistent. Tiers
    // are sanitized (clamped, coerced) so a bad payload can't corrupt the sums.
    const next = {
      enabled: dto.enabled ?? current.enabled,
      cashbackPercent:
        dto.cashbackPercent !== undefined
          ? String(dto.cashbackPercent)
          : current.cashbackPercent,
      minPurchase:
        dto.minPurchase !== undefined
          ? String(dto.minPurchase)
          : current.minPurchase,
      redeemMaxPercent:
        dto.redeemMaxPercent !== undefined
          ? String(dto.redeemMaxPercent)
          : current.redeemMaxPercent,
      expiryMonths:
        dto.expiryMonths === undefined ? current.expiryMonths : dto.expiryMonths,
      tiers: dto.tiers !== undefined ? this.normalizeTiers(dto.tiers) : current.tiers,
    };

    await this.dbService.db
      .insert(loyaltySettings)
      .values({ businessId, ...next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: loyaltySettings.businessId,
        set: { ...next, updatedAt: new Date() },
      });

    await this.cache.del(CacheKeys.loyaltySettings(businessId));

    return this.getSettings(businessId);
  }

  // Keep tiers clean and deterministic: drop unnamed rows, clamp the numbers,
  // and sort ascending by threshold so the checkout resolver (later) can pick a
  // customer's tier by walking the list.
  private normalizeTiers(tiers: LoyaltyTier[]): LoyaltyTier[] {
    return tiers
      .filter((tt) => tt && typeof tt.name === 'string' && tt.name.trim() !== '')
      .map((tt) => ({
        name: tt.name.trim().slice(0, 50),
        minTotal: Math.max(0, Number(tt.minTotal) || 0),
        cashbackPercent: Math.min(100, Math.max(0, Number(tt.cashbackPercent) || 0)),
      }))
      .sort((a, b) => a.minTotal - b.minTotal);
  }

  // Highest tier a lifetime spend qualifies for (tiers sorted ascending), or
  // null when no tier is reached / none are configured.
  private tierFor(spent: number, tiers: LoyaltyTier[]): string | null {
    let name: string | null = null;
    for (const t of tiers) if (spent >= t.minTotal) name = t.name;
    return name;
  }

  /**
   * Customers with their loyalty standing — balance, lifetime spend, tier and
   * last visit. Paginated + searchable by name/phone. Ordered by balance so the
   * most-rewarded customers surface first.
   */
  async listCustomers(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
      // Keyset pagination (common/cursor.ts). This list is not sorted by date,
      // so its cursor carries the balance too — see CUSTOMER_KEYS.
      cursor?: string;
      // False skips the count(*); `total` then comes back null.
      withTotal?: boolean;
    },
  ): Promise<{
    customers: LoyaltyCustomer[];
    total: number | null;
    page: number;
    limit: number;
    nextCursor: string | null;
  }> {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const offset = (page - 1) * limit;
    const fetchLimit = limit + 1;
    const withTotal = options?.withTotal !== false;
    const cursor = decodeCursor(options?.cursor, CUSTOMER_KEYS.length);
    const search = options?.search?.trim();

    const where = [eq(users.businessId, businessId), eq(users.isActive, true)];
    if (search) {
      where.push(
        or(ilike(users.name, `%${search}%`), ilike(users.phone, `%${search}%`))!,
      );
    }

    const total = withTotal
      ? (
          await this.dbService.db
            .select({ value: count() })
            .from(users)
            .where(and(...where))
        )[0].value
      : null;

    // Last visit per customer via a correlated max(order date).
    const lastOrderAt = sql<string | null>`(
      select max(${orders.createdAt}) from ${orders}
      where ${orders.userId} = ${users.id}
    )`;

    const fetched = await this.dbService.db
      .select({
        id: users.id,
        name: users.name,
        phone: users.phone,
        bonusBalance: users.bonusBalance,
        totalSpent: users.totalSpent,
        lastOrderAt,
        // Part of the sort key, so it has to be read even though the client
        // never sees it — it is stripped back out below.
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        and(
          ...(cursor ? [...where, keysetBefore(CUSTOMER_KEYS, cursor)] : where),
        ),
      )
      .orderBy(desc(users.bonusBalance), desc(users.createdAt), desc(users.id))
      .limit(fetchLimit)
      .offset(cursor ? 0 : offset);

    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    const nextCursor = hasMore
      ? encodeCursor(rows[rows.length - 1], CUSTOMER_KEYS)
      : null;

    const { tiers } = await this.getSettings(businessId);
    // `createdAt` was read for the cursor only — it is not part of the shape
    // the customers screen is typed against, so it stops here.
    const customers: LoyaltyCustomer[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      bonusBalance: r.bonusBalance,
      totalSpent: r.totalSpent,
      lastOrderAt: r.lastOrderAt ? new Date(r.lastOrderAt).toISOString() : null,
      tier: this.tierFor(Number(r.totalSpent), tiers),
    }));

    return { customers, total, page, limit, nextCursor };
  }

  /** One customer's loyalty ledger (newest first), paginated. */
  async getCustomerHistory(
    businessId: string,
    userId: string,
    options?: { page?: number; limit?: number },
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const offset = (page - 1) * limit;

    const where = and(
      eq(loyaltyTransactions.businessId, businessId),
      eq(loyaltyTransactions.userId, userId),
    );

    const [{ value: total }] = await this.dbService.db
      .select({ value: count() })
      .from(loyaltyTransactions)
      .where(where);

    const transactions = await this.dbService.db
      .select()
      .from(loyaltyTransactions)
      .where(where)
      .orderBy(desc(loyaltyTransactions.createdAt))
      .limit(limit)
      .offset(offset);

    return { transactions, total, page, limit };
  }
}
