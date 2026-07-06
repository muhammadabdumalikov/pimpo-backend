import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  products,
  inventoryBatches,
  globalBarcodes,
  type Product,
  type NewProduct,
} from '../database/schema';
import { eq, and, desc, ilike, or, sql } from 'drizzle-orm';
import { generateId } from '../utils/uuid';
import { SubscriptionService } from '../subscription/subscription.service';
import { BarcodeLookupService } from './barcode-lookup.service';

@Injectable()
export class ProductService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptionService: SubscriptionService,
    private readonly barcodeLookupService: BarcodeLookupService,
  ) {}

  async create(businessId: string, data: {
    name: string;
    code?: string;
    barcode?: string;
    priceIn: string;
    priceOut: string;
    quantity: number;
    quantityType?: string;
    image?: string;
    categoryId?: string;
  }): Promise<Product> {
    // Enforce the plan's product limit (null = unlimited).
    const { productsLimit } =
      await this.subscriptionService.getSubscriptionLimits(businessId);
    if (productsLimit !== null) {
      const currentCount = await this.getCount(businessId);
      if (currentCount >= productsLimit) {
        throw new ForbiddenException(
          `Product limit of ${productsLimit} reached for your current plan.`,
        );
      }
    }

    // Check if code already exists for this business
    if (data.code) {
      const existing = await this.dbService.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            eq(products.code, data.code),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        throw new ConflictException('Product with this code already exists');
      }
    }

    const newProduct: NewProduct = {
      id: generateId(),
      businessId,
      name: data.name,
      code: data.code || null,
      barcode: data.barcode || null,
      priceIn: data.priceIn,
      priceOut: data.priceOut,
      quantity: data.quantity,
      quantityType: data.quantityType || null,
      image: data.image || null,
      categoryId: data.categoryId || null,
      isActive: true,
    };

    const product = await this.dbService.db.transaction(async (tx) => {
      const [created] = await tx.insert(products).values(newProduct).returning();

      // Open an inventory batch for any initial stock so the FIFO queue stays in
      // sync with products.quantity (sales value COGS from batches).
      if (data.quantity > 0) {
        await tx.insert(inventoryBatches).values({
          id: generateId(),
          businessId,
          productId: created.id,
          receiptItemId: null,
          priceIn: data.priceIn,
          priceOut: data.priceOut,
          qtyReceived: data.quantity,
          qtyRemaining: data.quantity,
        });
      }

      // Contribute this barcode to the shared catalog so other businesses that
      // scan it later can auto-fill the name/image. First contributor's name
      // sticks; repeat scans just bump the usage counter.
      if (created.barcode) {
        await tx
          .insert(globalBarcodes)
          .values({
            barcode: created.barcode,
            name: created.name,
            image: created.image,
            source: 'community',
          })
          .onConflictDoUpdate({
            target: globalBarcodes.barcode,
            set: {
              timesUsed: sql`${globalBarcodes.timesUsed} + 1`,
              // Backfill an image only if the catalog entry never had one.
              image: sql`coalesce(${globalBarcodes.image}, ${created.image ?? null})`,
              updatedAt: new Date(),
            },
          });
      }

      return created;
    });

    return product;
  }

  async findAll(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
    },
  ): Promise<{ products: Product[]; total: number; page: number; limit: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;
    const search = options?.search;

    // Build where conditions
    const whereConditions = [
      eq(products.businessId, businessId),
      eq(products.isActive, true),
    ];

    if (search) {
      whereConditions.push(
        or(
          ilike(products.name, `%${search}%`),
          ilike(products.code, `%${search}%`),
          ilike(products.barcode, `%${search}%`),
        )!,
      );
    }

    // Get total count
    const allProducts = await this.dbService.db
      .select()
      .from(products)
      .where(and(...whereConditions));
    const total = allProducts.length;

    // Get paginated results
    const paginatedProducts = await this.dbService.db
      .select()
      .from(products)
      .where(and(...whereConditions))
      .orderBy(desc(products.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      products: paginatedProducts,
      total,
      page,
      limit,
    };
  }

  async findOne(businessId: string, productId: string): Promise<Product | null> {
    const [product] = await this.dbService.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.id, productId),
          eq(products.businessId, businessId),
          eq(products.isActive, true),
        ),
      )
      .limit(1);

    return product || null;
  }

  async update(
    businessId: string,
    productId: string,
    data: Partial<Omit<NewProduct, 'id' | 'businessId' | 'createdAt'>>,
  ): Promise<Product> {
    const existing = await this.findOne(businessId, productId);
    if (!existing) {
      throw new NotFoundException('Product not found');
    }

    // Check if code already exists for another product
    if (data.code && data.code !== existing.code) {
      const codeExists = await this.dbService.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            eq(products.code, data.code),
            eq(products.isActive, true),
          ),
        )
        .limit(1);

      if (codeExists.length > 0) {
        throw new ConflictException('Product with this code already exists');
      }
    }

    const [product] = await this.dbService.db
      .update(products)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(products.id, productId),
          eq(products.businessId, businessId),
        ),
      )
      .returning();

    return product;
  }

  async remove(businessId: string, productId: string): Promise<void> {
    const existing = await this.findOne(businessId, productId);
    if (!existing) {
      throw new NotFoundException('Product not found');
    }

    // Soft delete
    await this.dbService.db
      .update(products)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(products.id, productId),
          eq(products.businessId, businessId),
        ),
      );
  }

  async getCount(businessId: string): Promise<number> {
    const result = await this.dbService.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          eq(products.isActive, true),
        ),
      );

    return result.length;
  }

  /**
   * Look up a scanned barcode to pre-fill a new product.
   *
   * Priority: the business's own catalog first (so we can flag "you already have
   * this"), then the shared community catalog built from all businesses.
   */
  async lookupBarcode(
    businessId: string,
    barcode: string,
  ): Promise<{
    found: boolean;
    source: 'own' | 'community' | null;
    name: string | null;
    image: string | null;
    categoryName: string | null;
    existsInBusiness: boolean;
    productId: string | null;
  }> {
    const empty = {
      found: false,
      source: null,
      name: null,
      image: null,
      categoryName: null,
      existsInBusiness: false,
      productId: null,
    };

    if (!barcode) return empty;

    // The business may already stock this exact barcode.
    const [own] = await this.dbService.db
      .select()
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          eq(products.barcode, barcode),
          eq(products.isActive, true),
        ),
      )
      .limit(1);

    if (own) {
      return {
        found: true,
        source: 'own',
        name: own.name,
        image: own.image,
        categoryName: null,
        existsInBusiness: true,
        productId: own.id,
      };
    }

    // Fall back to the shared community catalog.
    const [global] = await this.dbService.db
      .select()
      .from(globalBarcodes)
      .where(eq(globalBarcodes.barcode, barcode))
      .limit(1);

    if (global) {
      return {
        found: true,
        source: 'community',
        name: global.name,
        image: global.image,
        categoryName: global.categoryName,
        existsInBusiness: false,
        productId: null,
      };
    }

    // Last resort: query external providers (GS1 / Open Food Facts) and cache any
    // hit into the shared catalog, so this barcode is instant (and offline) next time.
    const external = await this.barcodeLookupService.lookup(barcode);
    if (external) {
      await this.dbService.db
        .insert(globalBarcodes)
        .values({
          barcode,
          name: external.name,
          image: external.image,
          categoryName: external.categoryName,
          source: external.source,
        })
        .onConflictDoNothing();

      return {
        found: true,
        source: 'community',
        name: external.name,
        image: external.image,
        categoryName: external.categoryName,
        existsInBusiness: false,
        productId: null,
      };
    }

    return empty;
  }

  async generateProductCode(businessId: string): Promise<string> {
    // Get the count of products for this business
    const productCount = await this.getCount(businessId);
    
    // Generate code pattern: PRD-0001, PRD-0002, etc.
    let attempt = 0;
    const maxAttempts = 1000; // Prevent infinite loop
    
    while (attempt < maxAttempts) {
      const codeNumber = productCount + attempt + 1;
      const generatedCode = `PRD-${String(codeNumber).padStart(4, '0')}`;
      
      // Check if this code already exists
      const existing = await this.dbService.db
        .select()
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            eq(products.code, generatedCode),
            eq(products.isActive, true),
          ),
        )
        .limit(1);
      
      if (existing.length === 0) {
        return generatedCode;
      }
      
      attempt++;
    }
    
    // Fallback: use timestamp-based code if all sequential codes are taken
    const timestamp = Date.now().toString().slice(-8);
    return `PRD-${timestamp}`;
  }
}
