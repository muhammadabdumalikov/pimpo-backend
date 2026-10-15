import {Injectable} from '@nestjs/common';
import {and, eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {branches, storeSettings} from '../database/schema';
import {BranchService} from '../branch/branch.service';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';

export interface StoreDeliverySettings {
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  deliveryFee: number;
  freeDeliveryFrom: number | null;
  minDeliveryAmount: number | null;
  onlineBranchId: string | null;
}

const DEFAULTS: StoreDeliverySettings = {
  pickupEnabled: true,
  deliveryEnabled: true,
  deliveryFee: 0,
  freeDeliveryFrom: null,
  minDeliveryAmount: null,
  onlineBranchId: null,
};

const num = (v: string | null) => (v == null ? null : Number(v));

/**
 * How a shop hands over its online orders (YETKAZISH.md Q3, Q4, Q14, Q19).
 * A shop with no row runs on the defaults: both methods on, delivery free,
 * orders served from the default branch.
 */
@Injectable()
export class StoreSettingsService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly branchService: BranchService,
  ) {}

  async get(businessId: string): Promise<StoreDeliverySettings> {
    const [row] = await this.dbService.db
      .select()
      .from(storeSettings)
      .where(eq(storeSettings.businessId, businessId))
      .limit(1);
    if (!row) return {...DEFAULTS};
    return {
      pickupEnabled: row.pickupEnabled,
      deliveryEnabled: row.deliveryEnabled,
      deliveryFee: Number(row.deliveryFee),
      freeDeliveryFrom: num(row.freeDeliveryFrom),
      minDeliveryAmount: num(row.minDeliveryAmount),
      onlineBranchId: row.onlineBranchId,
    };
  }

  async update(
    businessId: string,
    patch: Partial<StoreDeliverySettings>,
  ): Promise<StoreDeliverySettings> {
    const next = {...(await this.get(businessId)), ...patch};
    if (!next.pickupEnabled && !next.deliveryEnabled) {
      throw new AppException(ErrorCode.STORE_NO_FULFILLMENT_METHOD);
    }
    if (next.onlineBranchId) {
      const [branch] = await this.dbService.db
        .select({id: branches.id})
        .from(branches)
        .where(
          and(
            eq(branches.businessId, businessId),
            eq(branches.id, next.onlineBranchId),
          ),
        )
        .limit(1);
      if (!branch) throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
    }
    const values = {
      pickupEnabled: next.pickupEnabled,
      deliveryEnabled: next.deliveryEnabled,
      deliveryFee: String(Math.max(0, next.deliveryFee || 0)),
      freeDeliveryFrom:
        next.freeDeliveryFrom == null ? null : String(next.freeDeliveryFrom),
      minDeliveryAmount:
        next.minDeliveryAmount == null ? null : String(next.minDeliveryAmount),
      onlineBranchId: next.onlineBranchId || null,
      updatedAt: new Date(),
    };
    await this.dbService.db
      .insert(storeSettings)
      .values({businessId, ...values})
      .onConflictDoUpdate({target: storeSettings.businessId, set: values});
    return this.get(businessId);
  }

  /** The branch online orders are stocked, assembled and picked up from. */
  async onlineBranch(
    businessId: string,
    settings?: StoreDeliverySettings,
  ): Promise<{id: string; name: string; address: string | null}> {
    const id = (settings ?? (await this.get(businessId))).onlineBranchId;
    if (id) {
      const [row] = await this.dbService.db
        .select({
          id: branches.id,
          name: branches.name,
          address: branches.address,
          isActive: branches.isActive,
        })
        .from(branches)
        .where(and(eq(branches.businessId, businessId), eq(branches.id, id)))
        .limit(1);
      if (row?.isActive)
        return {id: row.id, name: row.name, address: row.address};
    }
    const fallback = await this.branchService.ensureDefault(businessId);
    return {id: fallback.id, name: fallback.name, address: fallback.address};
  }
}
