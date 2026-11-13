import {
  Injectable,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import {
  branchStock,
  branches,
  cashRegisters,
  categories,
  products,
  type Branch,
} from '../database/schema';
import { eq, and, asc, desc, count, sql, type SQL } from 'drizzle-orm';
import { generateId } from '../utils/uuid';
import { SubscriptionService } from '../subscription/subscription.service';
import { normalizeWorkingHours } from './working-hours';
import { BillingService } from '../billing/billing.service';

/** Contact fields shared by create and update (AI-YORDAMCHI.md Q7). */
interface BranchContactInput {
  phone?: string | null;
  workingHours?: unknown;
  mapUrl?: string | null;
}

/** Empty strings clear a field; `undefined` leaves it untouched. */
function contactPatch(data: BranchContactInput): Partial<
  Pick<Branch, 'phone' | 'workingHours' | 'mapUrl'>
> {
  const patch: Partial<Pick<Branch, 'phone' | 'workingHours' | 'mapUrl'>> = {};
  if (data.phone !== undefined) patch.phone = data.phone?.trim() || null;
  if (data.mapUrl !== undefined) patch.mapUrl = data.mapUrl?.trim() || null;
  if (data.workingHours !== undefined) {
    patch.workingHours = normalizeWorkingHours(data.workingHours);
  }
  return patch;
}

@Injectable()
export class BranchService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptionService: SubscriptionService,
    private readonly billingService: BillingService,
  ) {}

  /**
   * The business default branch ("Asosiy do'kon"), created on first use. Every
   * business has exactly one; it is the fallback for documents without an
   * explicit branch and cannot be deleted.
   */
  async ensureDefault(businessId: string): Promise<Branch> {
    const [existing] = await this.dbService.db
      .select()
      .from(branches)
      .where(
        and(eq(branches.businessId, businessId), eq(branches.isDefault, true)),
      )
      .limit(1);
    if (existing) return existing;

    const [created] = await this.dbService.db
      .insert(branches)
      .values({
        id: generateId(),
        businessId,
        name: "Asosiy do'kon",
        isDefault: true,
        isActive: true,
      })
      .returning();
    return created;
  }

  /** Active branches, default first then by name. Guarantees a default exists. */
  async findAll(businessId: string): Promise<Branch[]> {
    await this.ensureDefault(businessId);
    return this.dbService.db
      .select()
      .from(branches)
      .where(
        and(eq(branches.businessId, businessId), eq(branches.isActive, true)),
      )
      .orderBy(desc(branches.isDefault), asc(branches.name));
  }

  async create(
    businessId: string,
    data: { name: string; address?: string } & BranchContactInput,
    // Who opened it, for the billing ledger (staff or business id).
    createdBy: string = businessId,
  ): Promise<Branch> {
    await this.ensureDefault(businessId);
    // Validate before any charge is taken.
    const contact = contactPatch(data);

    // Enforce the plan's branch cap (branchesLimit; null = unlimited). The
    // default "Asosiy do'kon" counts toward the total, matching how the landing
    // advertises limits (e.g. Standart = main + 3 = 4 total).
    const { branchesLimit } =
      await this.subscriptionService.getSubscriptionLimits(businessId);
    if (branchesLimit !== null) {
      const [{ value: activeCount }] = await this.dbService.db
        .select({ value: count() })
        .from(branches)
        .where(
          and(eq(branches.businessId, businessId), eq(branches.isActive, true)),
        );
      if (activeCount >= branchesLimit) {
        throw new AppException(ErrorCode.BRANCH_LIMIT_REACHED, {
          limit: branchesLimit,
        });
      }
    }

    // An extra seat on a running paid period is charged pro rata in the same
    // transaction as the insert (OBUNA-TOLOV.md Q13); a refused charge
    // (BILLING_INSUFFICIENT_BALANCE) leaves no branch behind.
    return this.billingService.createBranchWithCharge(
      businessId,
      data.name,
      createdBy,
      async (tx) => {
        const [created] = await tx
          .insert(branches)
          .values({
            id: generateId(),
            businessId,
            name: data.name,
            address: data.address ?? null,
            ...contact,
            isDefault: false,
            isActive: true,
          })
          .returning();
        // A branch sells through a register bound to it; without one the
        // shop would ring sales on an old register and draw the wrong
        // branch's stock (FILIAL-ASSORTIMENT.md Q13).
        await tx.insert(cashRegisters).values({
          id: generateId(),
          businessId,
          name: `${data.name} kassasi`,
          branchId: created.id,
          isActive: true,
        });
        return created;
      },
    );
  }

  // ─── Assortment copy (FILIAL-ASSORTIMENT.md Q2/Q6/Q7) ──────────────────────

  /**
   * Cards stocked in `fromBranchId` that `branchId` doesn't carry yet. "Live"
   * = on hand there, or its stock row moved in the last 90 days (every sale,
   * receipt and transfer touches branch_stock.updated_at).
   */
  private assortmentSource(
    businessId: string,
    branchId: string,
    fromBranchId: string,
    liveOnly: boolean,
  ): SQL[] {
    const where: SQL[] = [
      eq(products.businessId, businessId),
      eq(products.isActive, true),
      sql`NOT EXISTS (SELECT 1 FROM branch_stock t WHERE t.product_id = ${products.id} AND t.branch_id = ${branchId})`,
    ];
    if (liveOnly) {
      where.push(
        sql`(${branchStock.quantity} > 0 OR ${branchStock.updatedAt} >= now() - interval '90 days')`,
      );
    }
    return where;
  }

  private async requireCopyPair(
    businessId: string,
    branchId: string,
    fromBranchId: string,
  ): Promise<void> {
    if (!fromBranchId || fromBranchId === branchId) {
      throw new AppException(ErrorCode.ASSORTMENT_SAME_BRANCH);
    }
    await this.findOneOrThrow(businessId, branchId);
    await this.findOneOrThrow(businessId, fromBranchId);
  }

  async assortmentPreview(
    businessId: string,
    branchId: string,
    fromBranchId: string,
    liveOnly: boolean,
  ): Promise<{
    fromBranchId: string;
    total: number;
    categories: Array<{categoryId: string; name: string | null; count: number}>;
  }> {
    await this.requireCopyPair(businessId, branchId, fromBranchId);
    const rows = await this.dbService.db
      .select({
        categoryId: sql<string>`COALESCE(${products.categoryId}, 'none')`,
        name: sql<string | null>`MAX(${categories.name})`,
        count: sql<number>`count(*)::int`,
      })
      .from(products)
      .innerJoin(
        branchStock,
        and(
          eq(branchStock.productId, products.id),
          eq(branchStock.branchId, fromBranchId),
        ),
      )
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(
        and(...this.assortmentSource(businessId, branchId, fromBranchId, liveOnly)),
      )
      .groupBy(sql`COALESCE(${products.categoryId}, 'none')`);

    const list = rows
      .map((r) => ({
        categoryId: r.categoryId,
        name: r.categoryId === 'none' ? null : r.name,
        count: Number(r.count),
      }))
      .sort((a, b) =>
        a.categoryId === 'none'
          ? 1
          : b.categoryId === 'none'
            ? -1
            : (a.name ?? '').localeCompare(b.name ?? ''),
      );
    return {
      fromBranchId,
      total: list.reduce((sum, c) => sum + c.count, 0),
      categories: list,
    };
  }

  /**
   * Give `branchId` a 0-stock row for each matching card, so it shows in that
   * branch's till and lists. Existing rows are never touched, so running it
   * again only adds what is still missing. products.quantity is unchanged.
   */
  async copyAssortment(
    businessId: string,
    branchId: string,
    data: {fromBranchId: string; categoryIds: string[]; liveOnly: boolean},
  ): Promise<{added: number}> {
    await this.requireCopyPair(businessId, branchId, data.fromBranchId);
    const ids = [...new Set(data.categoryIds ?? [])];
    if (ids.length === 0) return {added: 0};

    const where = this.assortmentSource(
      businessId,
      branchId,
      data.fromBranchId,
      data.liveOnly,
    );
    const real = ids.filter((id) => id !== 'none');
    const categoryClauses: SQL[] = [];
    if (real.length) {
      categoryClauses.push(
        sql`${products.categoryId} IN (${sql.join(
          real.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    }
    if (ids.includes('none')) {
      categoryClauses.push(sql`${products.categoryId} IS NULL`);
    }
    where.push(sql`(${sql.join(categoryClauses, sql` OR `)})`);

    const result = await this.dbService.db.execute(sql`
      INSERT INTO branch_stock (id, business_id, product_id, branch_id, quantity)
      SELECT gen_random_uuid()::text, ${businessId}, ${products.id}, ${branchId}, 0
        FROM ${products}
        JOIN ${branchStock}
          ON ${branchStock.productId} = ${products.id}
         AND ${branchStock.branchId} = ${data.fromBranchId}
       WHERE ${and(...where)}
      ON CONFLICT (product_id, branch_id) DO NOTHING
    `);
    // postgres-js reports the affected-row count as `count`.
    return {added: Number((result as {count?: number}).count ?? 0)};
  }

  async update(
    businessId: string,
    id: string,
    data: { name?: string; address?: string } & BranchContactInput,
  ): Promise<Branch> {
    const existing = await this.findOneOrThrow(businessId, id);
    const contact = contactPatch(data);

    const [updated] = await this.dbService.db
      .update(branches)
      .set({
        name: data.name ?? existing.name,
        address: data.address !== undefined ? data.address : existing.address,
        ...contact,
        updatedAt: new Date(),
      })
      .where(and(eq(branches.id, id), eq(branches.businessId, businessId)))
      .returning();
    return updated;
  }

  /** Soft-delete a non-default branch. */
  async remove(businessId: string, id: string): Promise<void> {
    const existing = await this.findOneOrThrow(businessId, id);
    if (existing.isDefault) {
      throw new AppException(ErrorCode.BRANCH_MAIN_DELETE_FORBIDDEN);
    }
    await this.dbService.db
      .update(branches)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(branches.id, id), eq(branches.businessId, businessId)));
    // The monthly total counts active branches. The paid seat is kept
    // (paid_extra_branches): reopening one this period is not charged again.
    await this.subscriptionService.invalidate(businessId);
  }

  private async findOneOrThrow(
    businessId: string,
    id: string,
  ): Promise<Branch> {
    const [existing] = await this.dbService.db
      .select()
      .from(branches)
      .where(and(eq(branches.id, id), eq(branches.businessId, businessId)))
      .limit(1);
    if (!existing) throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
    return existing;
  }
}
