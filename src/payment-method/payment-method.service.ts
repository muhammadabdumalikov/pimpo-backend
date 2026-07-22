import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import { paymentMethods, type PaymentMethod } from '../database/schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import { generateId } from '../utils/uuid';
import { CacheKeys, TTL } from '../cache/cache.util';

// System methods seeded per business on the first list. `code` is the stable
// value stored on order payments — 'cash' keeps its special change /
// reconciliation semantics, everything else is a non-cash bucket. Only cash and
// card start visible (matches what the till supported before); the owner turns
// the rest on from Sozlamalar → To'lov turlari.
const SYSTEM_METHODS: Array<
  Pick<PaymentMethod, 'code' | 'name' | 'isVisible'>
> = [
  { code: 'cash', name: 'Naqd', isVisible: true },
  { code: 'card', name: 'Karta', isVisible: true },
  { code: 'uzcard', name: 'UzCard', isVisible: false },
  { code: 'humo', name: 'HUMO', isVisible: false },
  { code: 'visa', name: 'VISA', isVisible: false },
  { code: 'mastercard', name: 'Mastercard', isVisible: false },
  { code: 'unionpay', name: 'UnionPay', isVisible: false },
  { code: 'click', name: 'Click', isVisible: false },
];

@Injectable()
export class PaymentMethodService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Active methods (visible and hidden), system defaults seeded on first use. */
  async findAll(businessId: string): Promise<PaymentMethod[]> {
    return this.cache.wrap(
      CacheKeys.paymentMethods(businessId),
      async () => {
        await this.ensureSystemMethods(businessId);
        return this.dbService.db
          .select()
          .from(paymentMethods)
          .where(
            and(
              eq(paymentMethods.businessId, businessId),
              eq(paymentMethods.isActive, true),
            ),
          )
          .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.createdAt));
      },
      TTL.SETTINGS,
    );
  }

  private async ensureSystemMethods(businessId: string): Promise<void> {
    const [{ value }] = await this.dbService.db
      .select({ value: sql<number>`count(*)` })
      .from(paymentMethods)
      .where(eq(paymentMethods.businessId, businessId));
    if (Number(value) > 0) return;

    await this.dbService.db.insert(paymentMethods).values(
      SYSTEM_METHODS.map((m, i) => ({
        id: generateId(),
        businessId,
        code: m.code,
        name: m.name,
        type: 'system',
        isVisible: m.isVisible,
        sortOrder: i,
      })),
    );
  }

  async create(
    businessId: string,
    data: { name: string; sortOrder?: number },
  ): Promise<PaymentMethod> {
    await this.assertNameFree(businessId, data.name);

    const [created] = await this.dbService.db
      .insert(paymentMethods)
      .values({
        id: generateId(),
        businessId,
        // Stable code for order payments; slug of the name, uniquified by a
        // short random suffix so renames never break past sales.
        code: `custom-${generateId().slice(0, 8)}`,
        name: data.name,
        type: 'custom',
        isVisible: true,
        sortOrder: data.sortOrder ?? SYSTEM_METHODS.length + 100,
      })
      .returning();

    await this.cache.del(CacheKeys.paymentMethods(businessId));
    return created;
  }

  async update(
    businessId: string,
    id: string,
    data: { name?: string; isVisible?: boolean; sortOrder?: number },
  ): Promise<PaymentMethod> {
    const existing = await this.findOneOrThrow(businessId, id);

    // System methods: only visibility/order may change, never the name.
    if (existing.type === 'system' && data.name && data.name !== existing.name) {
      throw new AppException(ErrorCode.PAYMENT_METHOD_SYSTEM_IMMUTABLE);
    }
    if (data.name && data.name !== existing.name) {
      await this.assertNameFree(businessId, data.name);
    }

    const [updated] = await this.dbService.db
      .update(paymentMethods)
      .set({
        name: data.name ?? existing.name,
        isVisible: data.isVisible ?? existing.isVisible,
        sortOrder: data.sortOrder ?? existing.sortOrder,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentMethods.id, id),
          eq(paymentMethods.businessId, businessId),
        ),
      )
      .returning();

    await this.cache.del(CacheKeys.paymentMethods(businessId));
    return updated;
  }

  /** Soft-delete a custom method; past sales keep its code snapshot. */
  async remove(businessId: string, id: string): Promise<void> {
    const existing = await this.findOneOrThrow(businessId, id);
    if (existing.type === 'system') {
      throw new AppException(ErrorCode.PAYMENT_METHOD_SYSTEM_IMMUTABLE);
    }
    await this.dbService.db
      .update(paymentMethods)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(paymentMethods.id, id),
          eq(paymentMethods.businessId, businessId),
        ),
      );

    await this.cache.del(CacheKeys.paymentMethods(businessId));
  }

  private async assertNameFree(businessId: string, name: string): Promise<void> {
    const [dup] = await this.dbService.db
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.businessId, businessId),
          eq(paymentMethods.isActive, true),
          eq(paymentMethods.name, name),
        ),
      )
      .limit(1);
    if (dup) throw new AppException(ErrorCode.PAYMENT_METHOD_NAME_EXISTS, { name });
  }

  private async findOneOrThrow(
    businessId: string,
    id: string,
  ): Promise<PaymentMethod> {
    const [existing] = await this.dbService.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.id, id),
          eq(paymentMethods.businessId, businessId),
        ),
      )
      .limit(1);
    if (!existing) throw new AppException(ErrorCode.PAYMENT_METHOD_NOT_FOUND);
    return existing;
  }
}
