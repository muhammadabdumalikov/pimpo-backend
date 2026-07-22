import {
  Injectable,
} from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import { branches, type Branch } from '../database/schema';
import { eq, and, asc, desc, count } from 'drizzle-orm';
import { generateId } from '../utils/uuid';
import { SubscriptionService } from '../subscription/subscription.service';

@Injectable()
export class BranchService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptionService: SubscriptionService,
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
    data: { name: string; address?: string },
  ): Promise<Branch> {
    await this.ensureDefault(businessId);

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

    const [created] = await this.dbService.db
      .insert(branches)
      .values({
        id: generateId(),
        businessId,
        name: data.name,
        address: data.address ?? null,
        isDefault: false,
        isActive: true,
      })
      .returning();
    return created;
  }

  async update(
    businessId: string,
    id: string,
    data: { name?: string; address?: string },
  ): Promise<Branch> {
    const existing = await this.findOneOrThrow(businessId, id);

    const [updated] = await this.dbService.db
      .update(branches)
      .set({
        name: data.name ?? existing.name,
        address: data.address !== undefined ? data.address : existing.address,
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
