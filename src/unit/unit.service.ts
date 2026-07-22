import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import { units, type Unit } from '../database/schema';
import { eq, and, asc, desc, isNull, or, sql } from 'drizzle-orm';
import { generateId } from '../utils/uuid';
import { CacheKeys, TTL } from '../cache/cache.util';

// Global system units (businessId NULL): exist for every business out of the
// box, immutable from the API (update/delete only match business-owned rows).
// Fixed ids so the insert is idempotent (also seeded by migration 0039).
const SYSTEM_UNITS: Array<
  Pick<Unit, 'id' | 'name' | 'shortName' | 'precision'>
> = [
  { id: 'unit-system-dona', name: 'Dona', shortName: 'dona', precision: 0 },
  { id: 'unit-system-kg', name: 'Kilogramm', shortName: 'kg', precision: 3 },
];

// Seeded once per business, on the first list. Deleting them later is fine —
// they only come back if the business has no unit rows at all (incl. inactive),
// so a deliberately trimmed catalogue stays trimmed.
const DEFAULT_UNITS: Array<Pick<Unit, 'name' | 'shortName' | 'precision'>> = [
  { name: 'Litr', shortName: 'l', precision: 2 },
  { name: 'Metr', shortName: 'm', precision: 2 },
];

@Injectable()
export class UnitService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Active units: global system units first, then the business's own. */
  async findAll(businessId: string): Promise<Unit[]> {
    return this.cache.wrap(
      CacheKeys.units(businessId),
      async () => {
        await this.ensureSystemUnits();
        await this.ensureDefaults(businessId);
        return this.dbService.db
          .select()
          .from(units)
          .where(
            and(
              or(eq(units.businessId, businessId), isNull(units.businessId)),
              eq(units.isActive, true),
            ),
          )
          .orderBy(desc(sql`${units.businessId} IS NULL`), asc(units.createdAt));
      },
      TTL.SETTINGS,
    );
  }

  /** Safety net on top of migration 0039 — fixed ids make this idempotent. */
  private async ensureSystemUnits(): Promise<void> {
    await this.dbService.db
      .insert(units)
      .values(SYSTEM_UNITS.map((u) => ({ ...u, businessId: null })))
      .onConflictDoNothing();
  }

  private async ensureDefaults(businessId: string): Promise<void> {
    const [{ value }] = await this.dbService.db
      .select({ value: sql<number>`count(*)` })
      .from(units)
      .where(eq(units.businessId, businessId));
    if (Number(value) > 0) return;

    await this.dbService.db.insert(units).values(
      DEFAULT_UNITS.map((u) => ({
        id: generateId(),
        businessId,
        ...u,
      })),
    );
  }

  async create(
    businessId: string,
    data: { name: string; shortName: string; precision: number },
  ): Promise<Unit> {
    await this.assertNameFree(businessId, data.name);

    const [created] = await this.dbService.db
      .insert(units)
      .values({ id: generateId(), businessId, ...data })
      .returning();

    await this.cache.del(CacheKeys.units(businessId));
    return created;
  }

  async update(
    businessId: string,
    id: string,
    data: { name?: string; shortName?: string; precision?: number },
  ): Promise<Unit> {
    const existing = await this.findOneOrThrow(businessId, id);
    if (data.name && data.name !== existing.name) {
      await this.assertNameFree(businessId, data.name);
    }

    const [updated] = await this.dbService.db
      .update(units)
      .set({
        name: data.name ?? existing.name,
        shortName: data.shortName ?? existing.shortName,
        precision: data.precision ?? existing.precision,
        updatedAt: new Date(),
      })
      .where(and(eq(units.id, id), eq(units.businessId, businessId)))
      .returning();

    await this.cache.del(CacheKeys.units(businessId));
    return updated;
  }

  /** Soft-delete: products keep whatever label they were saved with. */
  async remove(businessId: string, id: string): Promise<void> {
    await this.findOneOrThrow(businessId, id);
    await this.dbService.db
      .update(units)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(units.id, id), eq(units.businessId, businessId)));

    await this.cache.del(CacheKeys.units(businessId));
  }

  private async assertNameFree(businessId: string, name: string): Promise<void> {
    // System units count too — a business can't shadow "Dona"/"Kilogramm".
    const [dup] = await this.dbService.db
      .select({ id: units.id })
      .from(units)
      .where(
        and(
          or(eq(units.businessId, businessId), isNull(units.businessId)),
          eq(units.isActive, true),
          eq(units.name, name),
        ),
      )
      .limit(1);
    if (dup) throw new AppException(ErrorCode.UNIT_NAME_EXISTS, { name });
  }

  private async findOneOrThrow(businessId: string, id: string): Promise<Unit> {
    const [existing] = await this.dbService.db
      .select()
      .from(units)
      .where(and(eq(units.id, id), eq(units.businessId, businessId)))
      .limit(1);
    if (!existing) throw new AppException(ErrorCode.UNIT_NOT_FOUND);
    return existing;
  }
}
