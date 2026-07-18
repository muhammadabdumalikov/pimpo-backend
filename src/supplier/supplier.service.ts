import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { DatabaseService } from '../database/database.service';
import {
  suppliers,
  type Supplier,
  type NewSupplier,
} from '../database/schema';
import { eq, and, desc, ilike, or } from 'drizzle-orm';
import { generateId } from '../utils/uuid';
import { CacheKeys, TTL } from '../cache/cache.util';

@Injectable()
export class SupplierService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async create(
    businessId: string,
    data: { name: string; phone?: string; note?: string },
  ): Promise<Supplier> {
    const newSupplier: NewSupplier = {
      id: generateId(),
      businessId,
      name: data.name,
      phone: data.phone || null,
      note: data.note || null,
      isActive: true,
    };

    const [supplier] = await this.dbService.db
      .insert(suppliers)
      .values(newSupplier)
      .returning();

    await this.cache.del(CacheKeys.suppliers(businessId));

    return supplier;
  }

  async findAll(
    businessId: string,
    options?: { page?: number; limit?: number; search?: string },
  ): Promise<{ suppliers: Supplier[]; total: number; page: number; limit: number }> {
    const isPlainList =
      !options?.page && !options?.limit && !options?.search;

    if (isPlainList) {
      return this.cache.wrap(
        CacheKeys.suppliers(businessId),
        () => this.findAllUncached(businessId, options),
        TTL.SUPPLIERS,
      );
    }

    return this.findAllUncached(businessId, options);
  }

  private async findAllUncached(
    businessId: string,
    options?: { page?: number; limit?: number; search?: string },
  ): Promise<{ suppliers: Supplier[]; total: number; page: number; limit: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;
    const search = options?.search;

    const whereConditions = [
      eq(suppliers.businessId, businessId),
      eq(suppliers.isActive, true),
    ];

    if (search) {
      whereConditions.push(
        or(
          ilike(suppliers.name, `%${search}%`),
          ilike(suppliers.phone, `%${search}%`),
        )!,
      );
    }

    const all = await this.dbService.db
      .select()
      .from(suppliers)
      .where(and(...whereConditions));
    const total = all.length;

    const paginated = await this.dbService.db
      .select()
      .from(suppliers)
      .where(and(...whereConditions))
      .orderBy(desc(suppliers.createdAt))
      .limit(limit)
      .offset(offset);

    return { suppliers: paginated, total, page, limit };
  }

  async findOne(businessId: string, supplierId: string): Promise<Supplier | null> {
    const [supplier] = await this.dbService.db
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.id, supplierId),
          eq(suppliers.businessId, businessId),
          eq(suppliers.isActive, true),
        ),
      )
      .limit(1);

    return supplier || null;
  }

  async update(
    businessId: string,
    supplierId: string,
    data: Partial<Omit<NewSupplier, 'id' | 'businessId' | 'createdAt'>>,
  ): Promise<Supplier> {
    const existing = await this.findOne(businessId, supplierId);
    if (!existing) {
      throw new NotFoundException('Supplier not found');
    }

    const [supplier] = await this.dbService.db
      .update(suppliers)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)),
      )
      .returning();

    await this.cache.del(CacheKeys.suppliers(businessId));

    return supplier;
  }

  async remove(businessId: string, supplierId: string): Promise<void> {
    const existing = await this.findOne(businessId, supplierId);
    if (!existing) {
      throw new NotFoundException('Supplier not found');
    }

    // Soft delete (receipts keep their supplierName snapshot).
    await this.dbService.db
      .update(suppliers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(eq(suppliers.id, supplierId), eq(suppliers.businessId, businessId)),
      );

    await this.cache.del(CacheKeys.suppliers(businessId));
  }
}
