import {Injectable, Inject, Logger} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {DatabaseService} from '../database/database.service';
import {
  products,
  inventoryBatches,
  branchStock,
  globalBarcodes,
  mxikClassifier,
  units,
  type Product,
  type NewProduct,
  type Unit,
  type MxikClassifier,
} from '../database/schema';
import {
  eq,
  and,
  asc,
  desc,
  ilike,
  or,
  sql,
  isNull,
  isNotNull,
  getTableColumns,
} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {SubscriptionService} from '../subscription/subscription.service';
import {tierAtLeast} from '../subscription/tier';
import {BranchService} from '../branch/branch.service';
import {applyBranchStockDelta, getBranchStock} from '../common/branch-stock';
import {selectFields} from '../common/field-selection';
import {CacheKeys, TTL} from '../cache/cache.util';
import {mxikDisplayName, mxikClassName} from '../common/mxik-name';
import {latinToCyrillic, escapeRegex} from '../common/uz-translit';
import {parseScannedCode, type ScannedCode} from '../common/gs1';
import {
  ean13CheckDigit,
  parseWeightBarcode,
  type ParsedWeightBarcode,
} from '../common/weight-barcode';
import {ScaleService} from '../scale/scale.service';

/**
 * How the catalogue list comes back: newest first.
 *
 * A shop opens this page to see what it just added, not the alphabet. The id
 * is a tiebreaker, not decoration — without a unique one, two products created
 * in the same millisecond can trade places between page 1 and page 2 and one
 * of them is never seen. Ids are UUIDv7, so descending by id is itself
 * newest-first and agrees with the column above it rather than fighting it.
 */
const CATALOGUE_ORDER = [desc(products.createdAt), desc(products.id)] as const;

/** What the till gets back for one scan. */
export interface ScanResolution {
  product: Product | null;
  isGs1: boolean;
  gtin: string | null;
  /** Per-item serial, for the marking system and the fiscal receipt line. */
  serial: string | null;
  /**
   * Amount to put on the line, when the scan was a scale label that named an
   * amount. Null for an ordinary scan (the till adds one of whatever it is) and
   * for a price label the unit price could not resolve.
   */
  quantity: number | null;
  /**
   * True when the code was read as a scale label. Lets the till tell "unknown
   * barcode" from "your scale printed a PLU nothing is assigned to" — the same
   * empty result, but only one of them is a catalogue gap.
   */
  isScaleLabel: boolean;
}

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptionService: SubscriptionService,
    private readonly branchService: BranchService,
    private readonly scaleService: ScaleService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Resolve a unit the business may use: its own row or a global system row
   * (businessId NULL). Throws when missing/inactive.
   */
  private async resolveUnit(businessId: string, unitId: string): Promise<Unit> {
    const [unit] = await this.dbService.db
      .select()
      .from(units)
      .where(
        and(
          eq(units.id, unitId),
          or(eq(units.businessId, businessId), isNull(units.businessId)),
          eq(units.isActive, true),
        ),
      )
      .limit(1);
    if (!unit) throw new AppException(ErrorCode.UNIT_NOT_FOUND);
    return unit;
  }

  /**
   * Legacy weighted-vs-piece marker derived from the unit, so consumers that
   * still branch on quantityType ('kg' = fractional) keep working.
   */
  private static quantityTypeForUnit(unit: Unit): string {
    return unit.precision > 0 ? 'kg' : 'piece';
  }

  async create(
    businessId: string,
    data: {
      name: string;
      code?: string;
      barcode?: string;
      /** Scale PLU (see products.plu); null clears it. */
      plu?: number | null;
      priceIn: string;
      priceOut: string;
      quantity: number;
      quantityType?: string;
      unitId?: string;
      image?: string;
      categoryId?: string;
      priceBundle?: string;
      priceWholesale?: string;
      lowStockThreshold?: number;
      brandId?: string;
      supplierId?: string;
      branchId?: string;
      mxikCode?: string;
      packageCode?: string;
    },
  ): Promise<Product> {
    // Enforce the plan's product limit (null = unlimited).
    const {productsLimit} =
      await this.subscriptionService.getSubscriptionLimits(businessId);
    if (productsLimit !== null) {
      const currentCount = await this.getCount(businessId);
      if (currentCount >= productsLimit) {
        throw new AppException(ErrorCode.PRODUCT_LIMIT_REACHED, {
          limit: productsLimit,
        });
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

    // Scale PLU, when the product is meant to be weighed.
    if (data.plu != null) {
      await this.assertPluAvailable(businessId, data.plu);
    }

    // A product belongs to one branch (a stock-take counts only its branch's
    // products). Default to the business default branch when none is chosen.
    const branchId =
      data.branchId || (await this.branchService.ensureDefault(businessId)).id;

    // Unit of measure: when given, it also drives the legacy quantityType.
    let unitId: string | null = null;
    let quantityType = data.quantityType || null;
    if (data.unitId) {
      const unit = await this.resolveUnit(businessId, data.unitId);
      unitId = unit.id;
      quantityType = ProductService.quantityTypeForUnit(unit);
    }

    const newProduct: NewProduct = {
      id: generateId(),
      businessId,
      name: data.name,
      code: data.code || null,
      barcode: data.barcode || null,
      plu: data.plu ?? null,
      priceIn: data.priceIn,
      priceOut: data.priceOut,
      quantity: data.quantity,
      quantityType,
      unitId,
      image: data.image || null,
      categoryId: data.categoryId || null,
      priceBundle: data.priceBundle || null,
      priceWholesale: data.priceWholesale || null,
      lowStockThreshold: data.lowStockThreshold ?? null,
      brandId: data.brandId || null,
      supplierId: data.supplierId || null,
      branchId,
      mxikCode: data.mxikCode || null,
      packageCode: data.packageCode || null,
      isActive: true,
    };

    const product = await this.dbService.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(products)
        .values(newProduct)
        .returning();

      // Seed the product's per-branch stock row (its whole initial qty lives in
      // its assigned branch; products.quantity already equals this sum).
      await tx.insert(branchStock).values({
        id: generateId(),
        businessId,
        productId: created.id,
        branchId,
        quantity: data.quantity,
      });

      // Open an inventory batch (in that branch) for any initial stock so the
      // FIFO queue stays in sync with the stock (sales value COGS from batches).
      if (data.quantity > 0) {
        await tx.insert(inventoryBatches).values({
          id: generateId(),
          businessId,
          productId: created.id,
          branchId,
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
    /**
     * The rows that were actually created, each carrying the 1-based index of
     * the item it came from.
     *
     * The count alone is not enough for every caller: the delivery-note scanner
     * creates products for the lines it could not match and then has to attach
     * each new id back to its line. Rows drop out on validation, duplicates and
     * the plan limit, so position in `items` cannot be relied on — `row` is the
     * only honest link.
     */
    products: Array<{
      row: number;
      id: string;
      name: string;
      code: string | null;
      barcode: string | null;
      priceIn: string;
      priceOut: string;
      quantityType: string | null;
    }>;
    skipped: Array<{row: number; reason: string}>;
    errors: Array<{row: number; reason: string}>;
    limitReached: boolean;
  }> {
    // Feature gate: bulk import ("Ommaviy mahsulot qo'shish") is a Business (pro)
    // and up capability — not on Standart (basic) or the expired floor.
    const tier = await this.subscriptionService.getEffectiveTier(businessId);
    if (!tierAtLeast(tier, 'pro')) {
      throw new AppException(ErrorCode.PRODUCT_BULK_IMPORT_PRO_ONLY);
    }

    const skipped: Array<{row: number; reason: string}> = [];
    const errors: Array<{row: number; reason: string}> = [];

    // Remaining slots under the plan's product limit (null = unlimited).
    const {productsLimit} =
      await this.subscriptionService.getSubscriptionLimits(businessId);
    let remaining = Infinity;
    if (productsLimit !== null) {
      const currentCount = await this.getCount(businessId);
      remaining = Math.max(0, productsLimit - currentCount);
    }

    // Existing codes/barcodes for this business, to skip duplicates cheaply.
    const existing = await this.dbService.db
      .select({code: products.code, barcode: products.barcode})
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
    // Pushed in lockstep with `toInsert`, so index i of one names index i of
    // the other. Keeps the limit check (`toInsert.length`) untouched.
    const insertedRows: number[] = [];
    let limitReached = false;

    // Imported products land in the business default branch.
    const defaultBranchId = (await this.branchService.ensureDefault(businessId))
      .id;

    const cleanNum = (v: unknown): number =>
      Number(String(v ?? '').replace(/[^\d.]/g, ''));

    items.forEach((data, i) => {
      const row = i + 1;

      // Per-row validation (backend is the source of truth).
      const name = data.name?.trim();
      if (!name) {
        errors.push({row, reason: 'Name is required'});
        return;
      }
      const priceInNum = cleanNum(data.priceIn);
      const priceOutNum = cleanNum(data.priceOut);
      if (!data.priceIn || Number.isNaN(priceInNum) || priceInNum < 0) {
        errors.push({row, reason: 'Invalid purchase price'});
        return;
      }
      if (!data.priceOut || Number.isNaN(priceOutNum) || priceOutNum <= 0) {
        errors.push({row, reason: 'Invalid selling price'});
        return;
      }

      const code = data.code?.trim() || null;
      const barcode = data.barcode?.trim() || null;

      // Duplicate detection against the DB and earlier rows in this batch.
      if (code && (existingCodes.has(code) || seenCodes.has(code))) {
        skipped.push({row, reason: `Duplicate code: ${code}`});
        return;
      }
      if (
        barcode &&
        (existingBarcodes.has(barcode) || seenBarcodes.has(barcode))
      ) {
        skipped.push({row, reason: `Duplicate barcode: ${barcode}`});
        return;
      }

      // Plan limit — everything past it is skipped.
      if (toInsert.length >= remaining) {
        limitReached = true;
        skipped.push({row, reason: 'Product limit reached'});
        return;
      }

      if (code) seenCodes.add(code);
      if (barcode) seenBarcodes.add(barcode);
      insertedRows.push(row);

      // Round to whole grams (3 decimals) rather than flooring, so weighed
      // goods (quantityType 'kg') keep their fractional stock, e.g. 0.25 kg.
      const quantity =
        typeof data.quantity === 'number' && data.quantity > 0
          ? Math.round(data.quantity * 1000) / 1000
          : 0;
      const lowStockThreshold =
        typeof data.lowStockThreshold === 'number' &&
        data.lowStockThreshold >= 0
          ? Math.round(data.lowStockThreshold * 1000) / 1000
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
        branchId: defaultBranchId,
        isActive: true,
      });
    });

    if (toInsert.length === 0) {
      return {created: 0, products: [], skipped, errors, limitReached};
    }

    await this.dbService.db.transaction(async (tx) => {
      await tx.insert(products).values(toInsert);

      // Seed each product's per-branch stock row in the default branch (its whole
      // initial qty; products.quantity already equals this sum).
      await tx.insert(branchStock).values(
        toInsert.map((p) => ({
          id: generateId(),
          businessId,
          productId: p.id,
          branchId: defaultBranchId,
          quantity: p.quantity ?? 0,
        })),
      );

      // Opening inventory batches (in that branch) for rows with initial stock
      // (keeps the FIFO queue in sync with the stock).
      const batches = toInsert
        .filter((p) => (p.quantity ?? 0) > 0)
        .map((p) => ({
          id: generateId(),
          businessId,
          productId: p.id,
          branchId: defaultBranchId,
          receiptItemId: null,
          priceIn: p.priceIn,
          priceOut: p.priceOut,
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

    return {
      created: toInsert.length,
      products: toInsert.map((p, i) => ({
        row: insertedRows[i],
        id: p.id,
        name: p.name,
        code: p.code ?? null,
        barcode: p.barcode ?? null,
        priceIn: p.priceIn,
        priceOut: p.priceOut,
        quantityType: p.quantityType ?? null,
      })),
      skipped,
      errors,
      limitReached,
    };
  }

  // A product counts as "low" at or below its own reorder point
  // (lowStockThreshold), falling back to 10 when none is set.
  private static readonly DEFAULT_LOW_STOCK_THRESHOLD = 10;

  // SQL predicate for a stock-status bucket over the given quantity column
  // (products.quantity, or branch_stock.quantity in branch scope).
  private stockCondition(
    stock: 'in' | 'low' | 'out',
    qtyCol: typeof products.quantity | typeof branchStock.quantity,
  ) {
    const threshold = sql`coalesce(${products.lowStockThreshold}, ${ProductService.DEFAULT_LOW_STOCK_THRESHOLD})`;
    if (stock === 'out') return sql`${qtyCol} <= 0`;
    if (stock === 'low') return sql`${qtyCol} > 0 and ${qtyCol} <= ${threshold}`;
    return sql`${qtyCol} > ${threshold}`;
  }

  async findAll(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
      // Scope to one branch: filter to its products and report THAT branch's
      // stock as `quantity` (instead of the cross-branch sum).
      branchId?: string;
      // Filter by stock status bucket (see stockCondition).
      stock?: 'in' | 'low' | 'out';
      // Filter to one category.
      categoryId?: string;
      // Filter to one supplier — the product's default supplier. The literal
      // 'none' asks for the products that have none, which is how a catalogue
      // gets tidied up ("which products is nobody supplying?").
      supplierId?: string;
      // Filter to one unit of measure (units table). The literal 'none' asks
      // for the rows that carry no unit yet — legacy products imported before
      // the unit catalogue existed, which is how they get found and fixed.
      unitId?: string;
      // Exact scale PLU. Unlike `search` this cannot drift: a label carries one
      // PLU and it must resolve to that product or to nothing at all.
      plu?: number;
      // Sparse fieldset (common/field-selection.ts): only these columns are
      // read and returned, plus `id`. Undefined = the full row.
      fields?: Set<string>;
    },
  ): Promise<{
    products: Product[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;
    const search = options?.search;
    const branchId = options?.branchId;
    const stock = options?.stock;
    const categoryId = options?.categoryId;
    const supplierId = options?.supplierId;
    const unitId = options?.unitId;
    const plu = options?.plu;

    // Build where conditions
    const whereConditions = [
      eq(products.businessId, businessId),
      eq(products.isActive, true),
    ];

    if (search) {
      whereConditions.push(this.searchClause(search));
    }

    if (plu !== undefined) {
      whereConditions.push(eq(products.plu, plu));
    }

    if (categoryId) {
      whereConditions.push(eq(products.categoryId, categoryId));
    }

    if (supplierId) {
      whereConditions.push(
        supplierId === 'none'
          ? isNull(products.supplierId)
          : eq(products.supplierId, supplierId),
      );
    }

    if (unitId) {
      whereConditions.push(
        unitId === 'none'
          ? isNull(products.unitId)
          : eq(products.unitId, unitId),
      );
    }

    if (stock) {
      whereConditions.push(
        this.stockCondition(
          stock,
          branchId ? branchStock.quantity : products.quantity,
        ),
      );
    }

    // Per-branch: a product belongs to a branch's catalogue when it has a
    // branch_stock row there — seeded for its home branch at creation, and added
    // by a transfer for any branch it was moved into. An INNER JOIN scopes the
    // list to exactly those products and reports THAT branch's on-hand as
    // `quantity` (instead of the cross-branch sum). Without a branch, the whole
    // catalogue is returned with the row's own quantity (the sum).
    if (branchId) {
      const branchJoin = and(
        eq(branchStock.productId, products.id),
        eq(branchStock.branchId, branchId),
      );

      const [{value: total}] = await this.dbService.db
        .select({value: sql<number>`count(*)::int`})
        .from(products)
        .innerJoin(branchStock, branchJoin)
        .where(and(...whereConditions));

      const paginatedProducts = await this.dbService.db
        .select(
          selectFields(
            {...getTableColumns(products), quantity: branchStock.quantity},
            options?.fields,
          ),
        )
        .from(products)
        .innerJoin(branchStock, branchJoin)
        .where(and(...whereConditions))
        .orderBy(...CATALOGUE_ORDER)
        .limit(limit)
        .offset(offset);

      return {products: paginatedProducts, total, page, limit};
    }

    const [{value: total}] = await this.dbService.db
      .select({value: sql<number>`count(*)::int`})
      .from(products)
      .where(and(...whereConditions));

    const paginatedProducts = await this.dbService.db
      .select(selectFields(getTableColumns(products), options?.fields))
      .from(products)
      .where(and(...whereConditions))
      .orderBy(...CATALOGUE_ORDER)
      .limit(limit)
      .offset(offset);

    return {
      products: paginatedProducts,
      total,
      page,
      limit,
    };
  }

  // Whole-catalogue stats for the products-page pulse panel: stock-status
  // counts plus total units on hand and the catalogue's value at supply
  // (priceIn) and retail (priceOut) prices. Respects the same search/branch/
  // category/supplier/unit scoping as findAll, so the numbers always match the
  // (filtered) list — not just the visible page.
  async getStats(
    businessId: string,
    options?: {
      search?: string;
      branchId?: string;
      categoryId?: string;
      supplierId?: string;
      unitId?: string;
    },
  ): Promise<{
    total: number;
    inStock: number;
    lowStock: number;
    outOfStock: number;
    units: number;
    supplyValue: number;
    retailValue: number;
  }> {
    return this.cache.wrap(
      CacheKeys.productStats(businessId, options),
      async () => {
        const search = options?.search;
        const branchId = options?.branchId;
        const categoryId = options?.categoryId;
        const supplierId = options?.supplierId;
        const unitId = options?.unitId;

        const whereConditions = [
          eq(products.businessId, businessId),
          eq(products.isActive, true),
        ];
        if (search) {
          whereConditions.push(this.searchClause(search));
        }
        if (categoryId) {
          whereConditions.push(eq(products.categoryId, categoryId));
        }
        if (supplierId) {
          whereConditions.push(
            supplierId === 'none'
              ? isNull(products.supplierId)
              : eq(products.supplierId, supplierId),
          );
        }
        if (unitId) {
          whereConditions.push(
            unitId === 'none'
              ? isNull(products.unitId)
              : eq(products.unitId, unitId),
          );
        }

        const qtyCol = branchId ? branchStock.quantity : products.quantity;
        // Value sums ignore negative (oversold) rows so they can't shrink the
        // totals. quantity is doublePrecision — cast to ::numeric before
        // multiplying by the decimal prices to keep exact money math, then
        // ::float8 so the driver returns a JS number, not a string.
        const posQty = sql`greatest(${qtyCol}, 0)::numeric`;
        const selection = {
          total: sql<number>`count(*)::int`,
          inStock: sql<number>`count(*) filter (where ${this.stockCondition('in', qtyCol)})::int`,
          lowStock: sql<number>`count(*) filter (where ${this.stockCondition('low', qtyCol)})::int`,
          outOfStock: sql<number>`count(*) filter (where ${this.stockCondition('out', qtyCol)})::int`,
          units: sql<number>`coalesce(sum(${posQty}), 0)::float8`,
          supplyValue: sql<number>`coalesce(sum(${posQty} * ${products.priceIn}), 0)::float8`,
          retailValue: sql<number>`coalesce(sum(${posQty} * ${products.priceOut}), 0)::float8`,
        };

        const [row] = branchId
          ? await this.dbService.db
              .select(selection)
              .from(products)
              .innerJoin(
                branchStock,
                and(
                  eq(branchStock.productId, products.id),
                  eq(branchStock.branchId, branchId),
                ),
              )
              .where(and(...whereConditions))
          : await this.dbService.db
              .select(selection)
              .from(products)
              .where(and(...whereConditions));

        return (
          row ?? {
            total: 0,
            inStock: 0,
            lowStock: 0,
            outOfStock: 0,
            units: 0,
            supplyValue: 0,
            retailValue: 0,
          }
        );
      },
      TTL.PRODUCT_STATS,
    );
  }

  async findOne(
    businessId: string,
    productId: string,
  ): Promise<Product | null> {
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

    // Unit change: validate it and keep the derived legacy marker in sync.
    if (data.unitId) {
      const unit = await this.resolveUnit(businessId, data.unitId);
      data.quantityType = ProductService.quantityTypeForUnit(unit);
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

    // Clearing a PLU (null) always passes; setting one has to be free.
    if (data.plu != null && data.plu !== existing.plu) {
      await this.assertPluAvailable(businessId, data.plu, productId);
    }

    // Stock is per-branch, so a quantity edit and a branch reassignment can't be
    // a plain column write — route them through branch_stock (+ batches) so the
    // (product, branch) rows and the products.quantity sum never drift.
    const oldBranch =
      existing.branchId ??
      (await this.branchService.ensureDefault(businessId)).id;
    const newBranch = data.branchId ?? oldBranch;
    const branchChanged = data.branchId != null && data.branchId !== oldBranch;
    const qtyChanged =
      data.quantity != null && data.quantity !== existing.quantity;
    // quantity is applied via branch_stock, never as a direct column set.
    const {quantity: _q, ...rest} = data;
    void _q;

    return await this.dbService.db.transaction(async (tx) => {
      await tx
        .update(products)
        .set({...rest, updatedAt: new Date()})
        .where(
          and(eq(products.id, productId), eq(products.businessId, businessId)),
        );

      // Reassigned to another branch: move its lots + stock across, leaving the
      // total (products.quantity) unchanged.
      if (branchChanged) {
        await tx
          .update(inventoryBatches)
          .set({branchId: newBranch})
          .where(
            and(
              eq(inventoryBatches.productId, productId),
              eq(inventoryBatches.branchId, oldBranch),
            ),
          );
        const moved = await getBranchStock(tx, productId, oldBranch);
        if (moved !== 0) {
          await tx
            .update(branchStock)
            .set({quantity: 0, updatedAt: new Date()})
            .where(
              and(
                eq(branchStock.productId, productId),
                eq(branchStock.branchId, oldBranch),
              ),
            );
          await tx
            .insert(branchStock)
            .values({
              id: generateId(),
              businessId,
              productId,
              branchId: newBranch,
              quantity: moved,
            })
            .onConflictDoUpdate({
              target: [branchStock.productId, branchStock.branchId],
              set: {
                quantity: sql`ROUND((${branchStock.quantity} + ${moved})::numeric, 3)`,
                updatedAt: new Date(),
              },
            });
        }
      }

      // Manual quantity edit → adjust the (current) branch by the difference,
      // which also moves the products.quantity sum by the same amount.
      if (qtyChanged) {
        const delta =
          Math.round((data.quantity! - existing.quantity) * 1000) / 1000;
        await applyBranchStockDelta(
          tx,
          businessId,
          productId,
          newBranch,
          delta,
        );
      }

      const [product] = await tx
        .select()
        .from(products)
        .where(
          and(eq(products.id, productId), eq(products.businessId, businessId)),
        )
        .limit(1);
      return product;
    });
  }

  async remove(businessId: string, productId: string): Promise<void> {
    const existing = await this.findOne(businessId, productId);
    if (!existing) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
    }

    // Soft delete
    await this.dbService.db
      .update(products)
      .set({isActive: false, updatedAt: new Date()})
      .where(
        and(eq(products.id, productId), eq(products.businessId, businessId)),
      );
  }

  async getCount(businessId: string): Promise<number> {
    const result = await this.dbService.db
      .select()
      .from(products)
      .where(
        and(eq(products.businessId, businessId), eq(products.isActive, true)),
      );

    return result.length;
  }

  /**
   * Every distinct class prefix in the national classifier ("Газланган сув"),
   * loaded once and kept for the life of the process — the classifier is static
   * reference data imported offline, so it cannot go stale under us.
   *
   * Needed because a bare ": " split is not safe on shop-typed names: it would
   * turn "ATVYORKA NABOR AFIXS NO: 3013" into "3013". Matching the prefix
   * against real class names is the same guard drizzle/data/
   * 0064_strip_classifier_prefix.sql uses to repair already-written rows.
   */
  private classifierClassesCache: Promise<Set<string>> | null = null;

  private classifierClasses(): Promise<Set<string>> {
    this.classifierClassesCache ??= this.dbService.db
      .execute(
        sql`SELECT DISTINCT split_part(name, ': ', 1) AS prefix
            FROM mxik_classifier
            WHERE name LIKE '%: %'`,
      )
      .then((result: unknown) => {
        // db.execute() returns a bare row array or a { rows } object depending
        // on the driver — normalise both.
        const rows = ((result as {rows?: unknown[]}).rows ??
          (result as unknown[])) as Array<{prefix: string | null}>;
        return new Set(
          rows.map((r) => r.prefix?.trim()).filter((p): p is string => !!p),
        );
      })
      .catch((err) => {
        // Never fail a lookup over this: drop the cache so the next scan retries
        // and fall back to leaving names as contributed.
        this.classifierClassesCache = null;
        this.logger.warn(
          `Could not load classifier class prefixes: ${String(err)}`,
        );
        return new Set<string>();
      });
    return this.classifierClassesCache;
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
    /** Official classifier name behind `mxikCode`, verbatim (prefix included). */
    mxikName: string | null;
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
      mxikName: null,
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
        mxikName: null,
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
      // Community names are whatever the first contributor typed, and a shop
      // that seeded its catalog from the classifier (or from Billz, which bakes
      // the category into the name) contributes "<class>: <product>" here too.
      // Strip it like the classifier path does — but ONLY when the prefix is a
      // real classifier class, so a shop's own "ATVYORKA NABOR AFIXS NO: 3013"
      // survives untouched. The prefix then doubles as the category hint;
      // global_barcodes carries no categoryName of its own.
      const cls = mxikClassName(global.name);
      const isClass = cls !== null && (await this.classifierClasses()).has(cls);
      return {
        found: true,
        source: 'community',
        name: isClass ? mxikDisplayName(global.name) : global.name,
        image: global.image,
        categoryName: global.categoryName ?? (isClass ? cls : null),
        mxikCode: null,
        mxikName: null,
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
        // The classifier stores "<class>: <brand>, <attributes>". Only the part
        // after the class belongs in a product name — see mxikDisplayName.
        name: mxikDisplayName(classifier.name),
        image: null,
        categoryName: classifier.groupName,
        mxikCode: classifier.mxikCode,
        mxikName: classifier.name,
        existsInBusiness: false,
        productId: null,
      };
    }

    return empty;
  }

  /**
   * Resolve whatever the till's scanner produced into a product.
   *
   * Three kinds of code turn up at a till, and they are tried in this order:
   *
   *   1. a plain retail barcode or internal SKU;
   *   2. an "Asl belgi" marking DataMatrix, whose GS1 payload carries the
   *      barcode inside it (see common/gs1.ts) — without this every marked
   *      bottle (drinks, tobacco, medicines) fails to scan;
   *   3. a label one of the shop's own scales printed, which names a PLU and an
   *      amount rather than a product (see common/weight-barcode.ts).
   *
   * The order is the point, not an accident. Scale labels live in the 20-29
   * prefix range, and so do the in-store barcodes Pimpo mints itself ("200…"),
   * so a code that merely looks like a label must lose to a real product that
   * actually carries it.
   *
   * Resolution goes through `findAll` so the returned product is shaped exactly
   * like the catalogue's, with branch-scoped stock; the checkout relies on that
   * quantity for its out-of-stock guard.
   */
  async resolveScannedCode(
    businessId: string,
    code: string,
    branchId?: string,
  ): Promise<ScanResolution> {
    const scan: ScannedCode = parseScannedCode(code);

    // A GS1 scan is a barcode and nothing else; a plain scan may equally be an
    // internal SKU, so its raw form is worth trying as a `code` match too.
    const terms = scan.isGs1 ? scan.candidates : [...scan.candidates, scan.raw];

    const base = {
      isGs1: scan.isGs1,
      gtin: scan.gtin,
      serial: scan.serial,
      quantity: null,
      isScaleLabel: false,
    };

    for (const term of [...new Set(terms)]) {
      if (!term) continue;
      const {products: found} = await this.findAll(businessId, {
        page: 1,
        limit: 5,
        search: term,
        branchId,
      });
      const lower = term.toLowerCase();
      const match = found.find(
        (p) =>
          (p.barcode ?? '').toLowerCase() === lower ||
          (p.code ?? '').toLowerCase() === lower,
      );
      if (match) return {...base, product: match};
    }

    // Nothing in the catalogue owns this code, so it may be a label a scale
    // printed a minute ago. Parsed only HERE, after the catalogue has had its
    // say: prefixes 20-29 are shared ground, and Pimpo mints its own in-store
    // barcodes as "200…", so a code that merely looks like a label must lose
    // to a real product that carries it.
    const label = await this.resolveScaleLabel(businessId, scan.raw, branchId);
    if (label) {
      return {
        ...base,
        product: label.product,
        quantity: label.quantity,
        isScaleLabel: true,
      };
    }

    return {...base, product: null};
  }

  /**
   * Free-text product search: name, internal code and barcode — plus an exact
   * scale PLU when the term is all digits, so typing the number the operator
   * presses on the scale finds the same product in the catalogue.
   */
  private searchClause(search: string) {
    const clauses = [
      ilike(products.name, `%${search}%`),
      ilike(products.code, `%${search}%`),
      ilike(products.barcode, `%${search}%`),
    ];
    if (/^\d{1,8}$/.test(search)) {
      clauses.push(eq(products.plu, Number(search)));
    }
    return or(...clauses)!;
  }

  /**
   * Read a scan as a label one of this business's scales printed, and turn the
   * amount on it into a cart quantity.
   *
   * Returns null when the business has no scales, or when the code does not fit
   * any layout they print — both mean "this was never a label", and the caller
   * should keep reporting an ordinary not-found. A non-null result with a null
   * product is different and worth distinguishing: the label was genuinely read
   * but its PLU is unassigned, which is a catalogue gap the shop can fix.
   */
  private async resolveScaleLabel(
    businessId: string,
    raw: string,
    branchId?: string,
  ): Promise<{product: Product | null; quantity: number | null} | null> {
    const formats = await this.scaleService.activeFormats(businessId);
    if (formats.length === 0) return null;

    const parsed = parseWeightBarcode(raw, formats);
    if (!parsed) return null;

    // By PLU, not by search: a label names exactly one product, and a `search`
    // for "1234" could bury it under rows whose barcode merely contains those
    // digits.
    const {products: found} = await this.findAll(businessId, {
      page: 1,
      limit: 1,
      plu: parsed.plu,
      branchId,
    });
    const product = found[0] ?? null;
    if (!product) return {product: null, quantity: null};

    return {product, quantity: this.labelQuantity(product, parsed)};
  }

  /**
   * How much of the product the label represents.
   *
   * A weight label already carries the amount. A price label carries the line
   * total instead, so the amount has to be recovered by dividing by the unit
   * price — which means a price label is only as accurate as the price the
   * scale was programmed with. When that price is missing or zero there is
   * nothing to divide by and the till is better off asking the cashier than
   * inventing an amount.
   *
   * Rounded to whole grams, the precision the rest of the till keeps weighed
   * lines at, so a label can never introduce float drift into a total.
   */
  private labelQuantity(
    product: Product,
    parsed: ParsedWeightBarcode,
  ): number | null {
    // A PLU on a product sold by the piece is a mis-assignment — "0.5" of it
    // means nothing. The product form only offers a PLU on fractional units,
    // but the till must not depend on that having held.
    if (product.quantityType !== 'kg') return null;

    if (parsed.weight !== null) return Math.round(parsed.weight * 1000) / 1000;

    const unitPrice = Number(product.priceOut);
    if (!parsed.price || !unitPrice) return null;
    return Math.round((parsed.price / unitPrice) * 1000) / 1000;
  }

  /**
   * Search the national classifier (IKPU / MXIK, ~383k rows) for the product
   * form's code picker. Not scoped to a business — it is global reference data.
   *
   * Digits-only input is treated as a barcode (exact) or an MXIK prefix; any
   * other input is a free-text name search, served by the trigram GIN index
   * added in migration 0064 (an unanchored ILIKE no btree can help with).
   * Shortest names first, so the general classifier entry outranks the long
   * brand-specific variants of the same thing.
   *
   * The classifier is 100% Cyrillic while our UI (and our shops' own product
   * names) are Latin, so a Latin query is also matched in its transliterated
   * form — searching "non" has to find "нон". Both branches ride the same
   * trigram index; ORing them widens recall without a second round trip.
   */
  async searchMxik(
    query: string,
    limit = 20,
  ): Promise<
    Array<{
      mxikCode: string;
      /** Cleaned name, safe to drop into a product name field. */
      name: string;
      /** Classifier name verbatim, shown as the official label. */
      officialName: string;
      brand: string | null;
      groupName: string | null;
      unitName: string | null;
      barcode: string | null;
    }>
  > {
    const q = query.trim();
    // Trigram matching needs 3 characters to be selective; below that the query
    // degrades into a full scan of the whole classifier.
    if (q.length < 3) return [];

    if (/^\d+$/.test(q)) {
      const rows = await this.dbService.db
        .select()
        .from(mxikClassifier)
        .where(
          or(
            eq(mxikClassifier.barcode, q),
            ilike(mxikClassifier.mxikCode, `${q}%`),
          ),
        )
        .orderBy(sql`length(${mxikClassifier.name})`)
        .limit(Math.min(Math.max(limit, 1), 50));
      return rows.map((row) => ProductService.toMxikResult(row));
    }

    // Match the query as typed and, for Latin input, transliterated. Brand names
    // inside the Cyrillic entries are often left in Latin ("...: PEPSI, ПЭТ
    // бутилка 1 л"), so the raw form earns its place next to the Cyrillic one.
    const cyrillic = latinToCyrillic(q);
    const patterns = cyrillic ? [q, cyrillic] : [q];

    // Ranking, in order:
    //   1. the query IS the brand — "pepsi" wants the drink, not the hookah
    //      tobacco that merely mentions it;
    //   2. the query starts a word — without this, "non" ranks "Хинонлар"
    //      (a chemical) above "Ёпган нон";
    //   3. shortest name — the general entry over its brand-specific variants.
    // Each fragment is rebuilt per pattern: a parameterised `sql` object reused
    // in more than one clause binds its parameters only once.
    const anyOf = (make: (pattern: string) => ReturnType<typeof sql>) =>
      sql`(${sql.join(patterns.map(make), sql` or `)})`;

    const rows = await this.dbService.db
      .select()
      .from(mxikClassifier)
      .where(
        or(...patterns.map((p) => ilike(mxikClassifier.name, `%${p}%`))),
      )
      .orderBy(
        sql`${anyOf((p) => sql`${mxikClassifier.brand} ilike ${p}`)} desc`,
        sql`${anyOf(
          (p) =>
            sql`${mxikClassifier.name} ~* ${`(^|[^[:alpha:]])${escapeRegex(p)}`}`,
        )} desc`,
        sql`length(${mxikClassifier.name})`,
      )
      .limit(Math.min(Math.max(limit, 1), 50));

    return rows.map((row) => ProductService.toMxikResult(row));
  }

  private static toMxikResult(row: MxikClassifier) {
    return {
      mxikCode: row.mxikCode,
      name: mxikDisplayName(row.name),
      officialName: row.name,
      brand: row.brand,
      groupName: row.groupName,
      unitName: row.unitName,
      barcode: row.barcode,
    };
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
   * Lowest free scale PLU for this business.
   *
   * Unlike a barcode, a PLU is typed into the scale's keypad by hand and
   * pressed hundreds of times a day, so the pool is walked from the window's
   * start upward and the lowest gap is reused — short numbers are the whole
   * point. The window itself is the shop's (Sozlamalar -> Etiketka), capped by
   * what the scale barcode layouts can carry.
   *
   * Deliberately counts inactive products too. Soft-deleted rows keep their
   * PLU, and the unique index does not exclude them, so skipping them here
   * would hand out a number the database then refuses.
   */
  async generatePlu(businessId: string): Promise<number> {
    const {min, max} = await this.scaleService.pluRange(businessId);

    const rows = await this.dbService.db
      .select({plu: products.plu})
      .from(products)
      .where(
        and(eq(products.businessId, businessId), isNotNull(products.plu)),
      )
      .orderBy(asc(products.plu));

    let candidate = min;
    for (const row of rows) {
      // Numbers below the window (assigned before it was narrowed) are not
      // gaps to fill — they are simply outside it.
      if (row.plu === null || row.plu < min) continue;
      if (row.plu > candidate) break;
      if (row.plu === candidate) candidate++;
    }

    if (candidate > max) {
      throw new AppException(ErrorCode.PLU_POOL_EXHAUSTED);
    }
    return candidate;
  }

  /**
   * Guard a PLU before it is written. The database has the last word (there is
   * a unique index on business + PLU), but a duplicate caught here reports as
   * "another product uses this PLU" rather than a raw constraint violation, and
   * the range check is something only the scale/label settings know.
   */
  private async assertPluAvailable(
    businessId: string,
    plu: number,
    exceptProductId?: string,
  ): Promise<void> {
    const {min, max} = await this.scaleService.pluRange(businessId);
    if (!Number.isInteger(plu) || plu < min || plu > max) {
      throw new AppException(ErrorCode.PRODUCT_PLU_OUT_OF_RANGE, {min, max});
    }

    const [taken] = await this.dbService.db
      .select({id: products.id})
      .from(products)
      .where(and(eq(products.businessId, businessId), eq(products.plu, plu)))
      .limit(1);

    if (taken && taken.id !== exceptProductId) {
      throw new AppException(ErrorCode.PRODUCT_PLU_EXISTS);
    }
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
      const barcode = body + ean13CheckDigit(body);

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
    return fallbackBody + ean13CheckDigit(fallbackBody);
  }
}
