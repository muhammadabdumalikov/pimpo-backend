import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import {
  products,
  inventoryBatches,
  globalBarcodes,
  mxikClassifier,
  type Product,
  type NewProduct,
} from '../database/schema';
import { eq, and, desc, ilike, or, sql } from 'drizzle-orm';
import { generateId } from '../utils/uuid';
import { SubscriptionService } from '../subscription/subscription.service';

@Injectable()
export class ProductService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptionService: SubscriptionService,
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
    priceBundle?: string;
    lowStockThreshold?: number;
    brandId?: string;
    supplierId?: string;
  }): Promise<Product> {
    // Enforce the plan's product limit (null = unlimited).
    const { productsLimit } =
      await this.subscriptionService.getSubscriptionLimits(businessId);
    if (productsLimit !== null) {
      const currentCount = await this.getCount(businessId);
      if (currentCount >= productsLimit) {
        throw new AppException(ErrorCode.PRODUCT_LIMIT_REACHED, { limit: productsLimit });
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
        throw new AppException(ErrorCode.PRODUCT_CODE_EXISTS);
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
      priceBundle: data.priceBundle || null,
      lowStockThreshold: data.lowStockThreshold ?? null,
      brandId: data.brandId || null,
      supplierId: data.supplierId || null,
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

  /**
   * Bulk-import products from a parsed spreadsheet (Excel/CSV).
   *
   * Partial success: each row is validated on its own — invalid rows and rows
   * whose code/barcode already exist are reported (skipped), the rest are
   * created. The plan's product limit is honoured (rows past it are skipped and
   * `limitReached` is set). Not available on the free plan.
   */
  async bulkCreate(
    businessId: string,
    items: Array<{
      name?: string;
      code?: string;
      barcode?: string;
      priceIn?: string;
      priceOut?: string;
      quantity?: number;
      quantityType?: string;
      priceBundle?: string;
      lowStockThreshold?: number;
    }>,
  ): Promise<{
    created: number;
    skipped: Array<{ row: number; reason: string }>;
    errors: Array<{ row: number; reason: string }>;
    limitReached: boolean;
  }> {
    // Feature gate: bulk import is a paid-plan feature (not on free).
    const subscription =
      await this.subscriptionService.getBusinessSubscription(businessId);
    const tier = subscription?.plan.tier ?? 'free';
    if (tier === 'free') {
      throw new AppException(ErrorCode.PRODUCT_BULK_IMPORT_PRO_ONLY);
    }

    const skipped: Array<{ row: number; reason: string }> = [];
    const errors: Array<{ row: number; reason: string }> = [];

    // Remaining slots under the plan's product limit (null = unlimited).
    const { productsLimit } =
      await this.subscriptionService.getSubscriptionLimits(businessId);
    let remaining = Infinity;
    if (productsLimit !== null) {
      const currentCount = await this.getCount(businessId);
      remaining = Math.max(0, productsLimit - currentCount);
    }

    // Existing codes/barcodes for this business, to skip duplicates cheaply.
    const existing = await this.dbService.db
      .select({ code: products.code, barcode: products.barcode })
      .from(products)
      .where(
        and(eq(products.businessId, businessId), eq(products.isActive, true)),
      );
    const existingCodes = new Set(
      existing.map((e) => e.code).filter((c): c is string => !!c),
    );
    const existingBarcodes = new Set(
      existing.map((e) => e.barcode).filter((b): b is string => !!b),
    );

    const seenCodes = new Set<string>();
    const seenBarcodes = new Set<string>();
    const toInsert: NewProduct[] = [];
    let limitReached = false;

    const cleanNum = (v: unknown): number =>
      Number(String(v ?? '').replace(/[^\d.]/g, ''));

    items.forEach((data, i) => {
      const row = i + 1;

      // Per-row validation (backend is the source of truth).
      const name = data.name?.trim();
      if (!name) {
        errors.push({ row, reason: 'Name is required' });
        return;
      }
      const priceInNum = cleanNum(data.priceIn);
      const priceOutNum = cleanNum(data.priceOut);
      if (!data.priceIn || Number.isNaN(priceInNum) || priceInNum < 0) {
        errors.push({ row, reason: 'Invalid purchase price' });
        return;
      }
      if (!data.priceOut || Number.isNaN(priceOutNum) || priceOutNum <= 0) {
        errors.push({ row, reason: 'Invalid selling price' });
        return;
      }

      const code = data.code?.trim() || null;
      const barcode = data.barcode?.trim() || null;

      // Duplicate detection against the DB and earlier rows in this batch.
      if (code && (existingCodes.has(code) || seenCodes.has(code))) {
        skipped.push({ row, reason: `Duplicate code: ${code}` });
        return;
      }
      if (barcode && (existingBarcodes.has(barcode) || seenBarcodes.has(barcode))) {
        skipped.push({ row, reason: `Duplicate barcode: ${barcode}` });
        return;
      }

      // Plan limit — everything past it is skipped.
      if (toInsert.length >= remaining) {
        limitReached = true;
        skipped.push({ row, reason: 'Product limit reached' });
        return;
      }

      if (code) seenCodes.add(code);
      if (barcode) seenBarcodes.add(barcode);

      const quantity =
        typeof data.quantity === 'number' && data.quantity > 0
          ? Math.floor(data.quantity)
          : 0;
      const lowStockThreshold =
        typeof data.lowStockThreshold === 'number' && data.lowStockThreshold >= 0
          ? Math.floor(data.lowStockThreshold)
          : null;

      toInsert.push({
        id: generateId(),
        businessId,
        name,
        code,
        barcode,
        priceIn: String(priceInNum),
        priceOut: String(priceOutNum),
        quantity,
        quantityType: data.quantityType?.trim() || null,
        image: null,
        categoryId: null,
        priceBundle: data.priceBundle?.toString().trim() || null,
        lowStockThreshold,
        brandId: null,
        supplierId: null,
        isActive: true,
      });
    });

    if (toInsert.length === 0) {
      return { created: 0, skipped, errors, limitReached };
    }

    await this.dbService.db.transaction(async (tx) => {
      await tx.insert(products).values(toInsert);

      // Opening inventory batches for rows with initial stock (keeps the FIFO
      // queue in sync with products.quantity).
      const batches = toInsert
        .filter((p) => (p.quantity ?? 0) > 0)
        .map((p) => ({
          id: generateId(),
          businessId,
          productId: p.id as string,
          receiptItemId: null,
          priceIn: p.priceIn as string,
          priceOut: p.priceOut as string,
          qtyReceived: p.quantity as number,
          qtyRemaining: p.quantity as number,
        }));
      if (batches.length > 0) {
        await tx.insert(inventoryBatches).values(batches);
      }

      // Contribute barcodes to the shared community catalog (barcodes are unique
      // within this batch, so the multi-row upsert can't hit the same row twice).
      const barcodeRows = toInsert
        .filter((p) => p.barcode)
        .map((p) => ({
          barcode: p.barcode as string,
          name: p.name,
          image: p.image ?? null,
          source: 'community',
        }));
      if (barcodeRows.length > 0) {
        await tx
          .insert(globalBarcodes)
          .values(barcodeRows)
          .onConflictDoUpdate({
            target: globalBarcodes.barcode,
            set: {
              timesUsed: sql`${globalBarcodes.timesUsed} + 1`,
              image: sql`coalesce(${globalBarcodes.image}, excluded.image)`,
              updatedAt: new Date(),
            },
          });
      }
    });

    return { created: toInsert.length, skipped, errors, limitReached };
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
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
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
        throw new AppException(ErrorCode.PRODUCT_CODE_EXISTS);
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
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
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
    source: 'own' | 'community' | 'classifier' | null;
    name: string | null;
    image: string | null;
    categoryName: string | null;
    mxikCode: string | null;
    existsInBusiness: boolean;
    productId: string | null;
  }> {
    const empty = {
      found: false,
      source: null,
      name: null,
      image: null,
      categoryName: null,
      mxikCode: null,
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
        mxikCode: null,
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
        mxikCode: null,
        existsInBusiness: false,
        productId: null,
      };
    }

    // Last resort: the Uzbekistan national classifier (IKPU / MXIK), imported
    // from tasnif.soliq.uz. Authoritative and fully offline — also carries the
    // 17-digit MXIK code the product needs for fiscalization.
    const [classifier] = await this.dbService.db
      .select()
      .from(mxikClassifier)
      .where(eq(mxikClassifier.barcode, barcode))
      .limit(1);

    if (classifier) {
      return {
        found: true,
        source: 'classifier',
        name: classifier.name,
        image: null,
        categoryName: classifier.groupName,
        mxikCode: classifier.mxikCode,
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

  /**
   * Generate a fresh, valid EAN-13 barcode that isn't already used by this
   * business. Uses the "200" prefix reserved for in-store / restricted
   * distribution (never collides with real GS1-assigned manufacturer barcodes),
   * a random 9-digit body, and a computed EAN-13 check digit.
   */
  async generateBarcode(businessId: string): Promise<string> {
    const maxAttempts = 20;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // "200" prefix + 9 random digits = 12 digits, then the check digit.
      let body = '200';
      for (let i = 0; i < 9; i++) {
        body += Math.floor(Math.random() * 10).toString();
      }
      const barcode = body + this.ean13CheckDigit(body);

      const existing = await this.dbService.db
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

      if (existing.length === 0) {
        return barcode;
      }
    }

    // Extremely unlikely to reach here; last resort still returns a valid EAN-13.
    const fallbackBody = ('200' + Date.now().toString().slice(-9)).slice(0, 12);
    return fallbackBody + this.ean13CheckDigit(fallbackBody);
  }

  /** Standard EAN-13 check digit for the first 12 digits. */
  private ean13CheckDigit(twelveDigits: string): string {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = twelveDigits.charCodeAt(i) - 48;
      sum += i % 2 === 0 ? digit : digit * 3;
    }
    return ((10 - (sum % 10)) % 10).toString();
  }
}
