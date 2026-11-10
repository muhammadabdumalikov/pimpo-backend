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
        return created;
      },
    );
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
