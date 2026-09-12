import {Injectable, Inject} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {isStockTakeActive} from '../common/stock-take-lock';
import {businessDayStart, businessDayEnd} from '../common/business-time';
import {DatabaseService} from '../database/database.service';
import {
  goodsReceipts,
  goodsReceiptItems,
  inventoryBatches,
  products,
  branchStock,
  suppliers,
  receiptSettings,
  supplierPayments,
  supplierReturns,
  supplierReturnItems,
  staff,
  businesses,
  branches,
  type GoodsReceipt,
  type GoodsReceiptItem,
  type SupplierPayment,
  type SupplierReturn,
} from '../database/schema';
import {
  eq,
  and,
  asc,
  desc,
  gt,
  gte,
  ilike,
  lte,
  ne,
  or,
  inArray,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {FinanceService} from '../finance/finance.service';
import {BranchService} from '../branch/branch.service';
import {CreateReceiptDto} from './dto/create-receipt.dto';
import {UpdateReceiptDto} from './dto/update-receipt.dto';
import {UpdateReceiptHeaderDto} from './dto/update-receipt-header.dto';
import {AddPaymentDto} from './dto/add-payment.dto';
import {CreateReturnDto} from './dto/create-return.dto';

function money(value: number): string {
  return value.toFixed(2);
}

/** Roll paid vs total into a status. */
function paymentStatusOf(paid: number, total: number): string {
  if (paid <= 0) return 'unpaid';
  if (paid >= total) return 'paid';
  return 'partial';
}

export type ReceiptWithItems = GoodsReceipt & {
  branchName?: string | null;
  items: GoodsReceiptItem[];
  payments?: SupplierPayment[];
  returns?: SupplierReturn[];
};

// A prepared receipt line, ready to apply to stock (batches + costing).
interface ReceiptLine {
  itemId: string;
  productId: string;
  productName: string;
  // priceIn is in the receipt currency; priceInBase is the same in UZS (the
  // base used for inventory batches + weighted-average cost).
  priceIn: string;
  priceInBase: string;
  currency: string;
  priceOut: string;
  priceWholesale: string | null;
  priceBundle: string | null;
  quantity: number;
  lineTotal: string;
}

// Everything a receipt payload turns into: the lines to store plus the
// per-product aggregates that applying it to stock needs.
interface PreparedReceipt {
  supplierName: string | null;
  currency: 'UZS' | 'USD';
  rateToBase: number;
  lines: ReceiptLine[];
  received: Map<string, {qty: number; value: number}>;
  productInfo: Map<
    string,
    {
      name: string;
      priceOut: string;
      quantityType?: string | null;
      repriceOverride?: boolean;
    }
  >;
  wholesaleByProduct: Map<string, string>;
  bundleByProduct: Map<string, string>;
  total: number;
  itemCount: number;
}

// Drizzle transaction handle (parameter of db.transaction's callback).
type DbTx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

@Injectable()
export class ReceiptService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly financeService: FinanceService,
    private readonly branchService: BranchService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // Acting cashier (owner or staff) — snapshotted onto the payment.
  private async resolveCashier(
    account?: IAccount,
  ): Promise<{id: string | null; name: string | null}> {
    if (!account) return {id: null, name: null};
    if (account.type === 'staff') {
      const [row] = await this.dbService.db
        .select({name: staff.name})
        .from(staff)
        .where(eq(staff.id, account.id))
        .limit(1);
      return {id: account.id, name: row?.name ?? null};
    }
    const [row] = await this.dbService.db
      .select({name: businesses.name})
      .from(businesses)
      .where(eq(businesses.id, account.id))
      .limit(1);
    return {id: account.id, name: row?.name ?? null};
  }

  /**
   * Turn a receipt payload into the lines to store plus the aggregates needed
   * to apply it to stock. Validates the supplier, the currency/rate pair and
   * every product. Shared by creating a receipt and by editing a draft.
   */
  private async prepareReceipt(
    businessId: string,
    dto: CreateReceiptDto,
  ): Promise<PreparedReceipt> {
    // Resolve supplier (optional) and snapshot its name.
    let supplierName: string | null = null;
    if (dto.supplierId) {
      const [supplier] = await this.dbService.db
        .select()
        .from(suppliers)
        .where(
          and(
            eq(suppliers.businessId, businessId),
            eq(suppliers.id, dto.supplierId),
          ),
        )
        .limit(1);
      if (!supplier) {
        throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND_BY_ID, {
          supplierId: dto.supplierId,
        });
      }
      supplierName = supplier.name;
    }

    // Supply currency + the USD→UZS rate used to convert cost to base for
    // inventory. USD receipts settle in USD (debt/payments) but stock cost is
    // always stored in base UZS.
    const currency = dto.currency ?? 'UZS';
    if (currency === 'USD' && (!dto.usdRate || dto.usdRate <= 0)) {
      throw new AppException(ErrorCode.RECEIPT_USD_RATE_REQUIRED);
    }
    const rateToBase = currency === 'USD' ? Number(dto.usdRate) : 1;

    // Validate + snapshot each product once (products may repeat across lines).
    // The receipt keeps every entered line as the document of record.
    const productInfo = new Map<
      string,
      {
        name: string;
        priceOut: string;
        quantityType?: string | null;
        repriceOverride?: boolean;
      }
    >();
    // Per-product received totals — the same product across multiple lines is
    // summed so a single stock/cost update applies the full received batch
    // (otherwise a second line for the same product would overwrite the first).
    const received = new Map<string, {qty: number; value: number}>();
    const lines: ReceiptLine[] = [];
    // Wholesale + bundle prices entered per product (last line wins) → update
    // the product's tiers.
    const wholesaleByProduct = new Map<string, string>();
    const bundleByProduct = new Map<string, string>();
    let total = 0;
    let itemCount = 0;

    for (const item of dto.items) {
      let info = productInfo.get(item.productId);
      if (info === undefined) {
        const [product] = await this.dbService.db
          .select()
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, item.productId),
            ),
          )
          .limit(1);
        if (!product) {
          throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
            productId: item.productId,
          });
        }
        info = {
          name: product.name,
          priceOut: product.priceOut,
          quantityType: product.quantityType,
        };
        productInfo.set(item.productId, info);
      }
      // A per-line override (last one wins) controls repricing for the product.
      if (item.repriceExisting !== undefined) {
        info.repriceOverride = item.repriceExisting;
      }

      // Selling price of this batch: explicit, else the product's current price.
      const priceOut = item.priceOut ?? Number(info.priceOut);
      const priceWholesale =
        item.priceWholesale != null ? money(item.priceWholesale) : null;
      if (priceWholesale != null) {
        wholesaleByProduct.set(item.productId, priceWholesale);
      }
      const priceBundle =
        item.priceBundle != null ? money(item.priceBundle) : null;
      if (priceBundle != null) {
        bundleByProduct.set(item.productId, priceBundle);
      }
      // Line total is in the receipt currency; the base cost (UZS) drives the
      // inventory batch + weighted-average product cost.
      const lineTotal = item.priceIn * item.quantity;
      const priceInBase = item.priceIn * rateToBase;
      total += lineTotal;
      // Weighed goods count as one item so itemCount stays whole (integer col).
      itemCount += info.quantityType === 'kg' ? 1 : item.quantity;

      lines.push({
        itemId: generateId(),
        productId: item.productId,
        productName: info.name,
        priceIn: money(item.priceIn),
        priceInBase: money(priceInBase),
        currency,
        priceOut: money(priceOut),
        priceWholesale,
        priceBundle,
        quantity: item.quantity,
        lineTotal: money(lineTotal),
      });

      const agg = received.get(item.productId) ?? {qty: 0, value: 0};
      agg.qty += item.quantity;
      agg.value += priceInBase * item.quantity;
      received.set(item.productId, agg);
    }

    return {
      supplierName,
      currency,
      rateToBase,
      lines,
      received,
      productInfo,
      wholesaleByProduct,
      bundleByProduct,
      total,
      itemCount,
    };
  }

  /**
   * Create a goods receipt: insert the document + items, increment product
   * stock, and roll each product's purchase cost into a weighted average — all
   * in one transaction. A received receipt is immutable; a draft can still be
   * edited or deleted until it is received.
   */
  async create(
    businessId: string,
    dto: CreateReceiptDto,
  ): Promise<ReceiptWithItems> {
    // Freeze inbound stock while a count is open — a receipt changes
    // products.quantity and opens a new batch, which would desync the count's
    // book snapshot and break the SUM(qtyRemaining)==quantity invariant when the
    // count snaps stock back to the counted figure. Same freeze sales/shifts use
    // (INVENTARIZATSIYA.md §9.4); guarded + fail-open if the table isn't migrated.
    if (await isStockTakeActive(this.cache, this.dbService.db, businessId)) {
      throw new AppException(ErrorCode.RECEIPT_FROZEN_STOCK_TAKE);
    }

    const {
      supplierName,
      currency,
      rateToBase,
      lines,
      received,
      productInfo,
      wholesaleByProduct,
      bundleByProduct,
      total,
      itemCount,
    } = await this.prepareReceipt(businessId, dto);

    // Default selling-price behaviour comes from the business settings, but a
    // receipt line can override it per product.
    const [settings] = await this.dbService.db
      .select({priceIncreaseMode: receiptSettings.priceIncreaseMode})
      .from(receiptSettings)
      .where(eq(receiptSettings.businessId, businessId))
      .limit(1);
    const repriceExistingDefault =
      settings?.priceIncreaseMode === 'REPRICE_EXISTING';

    const receiptId = generateId();
    const draft = dto.draft === true;

    // Attribute the receipt to a branch ("do'kon"); fall back to the default.
    const branchId =
      dto.branchId ?? (await this.branchService.ensureDefault(businessId)).id;

    await this.dbService.db.transaction(async (tx) => {
      await tx.insert(goodsReceipts).values({
        id: receiptId,
        businessId,
        supplierId: dto.supplierId ?? null,
        supplierName,
        branchId,
        status: draft ? 'draft' : 'received',
        totalAmount: money(total),
        currency,
        usdRate: currency === 'USD' ? money(rateToBase) : null,
        itemCount,
        note: dto.note ?? null,
      });

      await tx.insert(goodsReceiptItems).values(
        lines.map((line) => ({
          id: line.itemId,
          receiptId,
          businessId,
          productId: line.productId,
          productName: line.productName,
          priceIn: line.priceIn,
          currency: line.currency,
          priceOut: line.priceOut,
          priceWholesale: line.priceWholesale,
          priceBundle: line.priceBundle,
          quantity: line.quantity,
          lineTotal: line.lineTotal,
        })),
      );

      // A draft only records the document — stock, batches and cost are applied
      // later when it is received. A normal receipt applies them immediately.
      if (!draft) {
        await this.applyReceiptStockTx(
          tx,
          businessId,
          branchId,
          lines,
          received,
          productInfo,
          wholesaleByProduct,
          bundleByProduct,
          repriceExistingDefault,
        );
      }
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  /**
   * Apply a receipt's lines to stock: push wholesale prices, open one inventory
   * batch per line, add received quantity + roll the weighted-average cost, and
   * settle the selling price (reprice existing batches or track the FIFO front).
   * Runs inside the caller's transaction. Shared by immediate receipts and by
   * receiving a draft.
   */
  private async applyReceiptStockTx(
    tx: DbTx,
    businessId: string,
    branchId: string,
    lines: ReceiptLine[],
    received: Map<string, {qty: number; value: number}>,
    productInfo: Map<
      string,
      {name: string; priceOut: string; repriceOverride?: boolean}
    >,
    wholesaleByProduct: Map<string, string>,
    bundleByProduct: Map<string, string>,
    repriceExistingDefault: boolean,
  ): Promise<void> {
    // Push entered wholesale prices onto the products (last value per product).
    for (const [productId, priceWholesale] of wholesaleByProduct) {
      await tx
        .update(products)
        .set({priceWholesale, updatedAt: new Date()})
        .where(
          and(eq(products.businessId, businessId), eq(products.id, productId)),
        );
    }
    // Same for entered bundle ("to'plam") prices.
    for (const [productId, priceBundle] of bundleByProduct) {
      await tx
        .update(products)
        .set({priceBundle, updatedAt: new Date()})
        .where(
          and(eq(products.businessId, businessId), eq(products.id, productId)),
        );
    }

    // Open one inventory batch per line — the FIFO/cost source of truth. Same
    // product at different prices stays as separate lots. The batch belongs to
    // the receipt's branch so per-branch FIFO draws from the right store.
    await tx.insert(inventoryBatches).values(
      lines.map((line) => ({
        id: generateId(),
        businessId,
        productId: line.productId,
        branchId,
        receiptItemId: line.itemId,
        // Batches hold cost in base UZS (converted from the receipt currency).
        priceIn: line.priceInBase,
        priceOut: line.priceOut,
        qtyReceived: line.quantity,
        qtyRemaining: line.quantity,
      })),
    );

    // Add the received quantity to the receipt's BRANCH stock (upsert the row).
    for (const [productId, agg] of received) {
      await tx
        .insert(branchStock)
        .values({
          id: generateId(),
          businessId,
          productId,
          branchId,
          quantity: agg.qty,
        })
        .onConflictDoUpdate({
          target: [branchStock.productId, branchStock.branchId],
          set: {
            quantity: sql`ROUND((${branchStock.quantity} + ${agg.qty})::numeric, 3)`,
            updatedAt: new Date(),
          },
        });
    }

    // One atomic update per product: add the received quantity and roll the
    // purchase cost into a weighted average, computed in SQL against the live
    // row so concurrent sales/receipts can't clobber the result.
    for (const [productId, agg] of received) {
      await tx
        .update(products)
        .set({
          quantity: sql`ROUND((${products.quantity} + ${agg.qty})::numeric, 3)`,
          priceIn: sql`CASE WHEN ${products.quantity} + ${agg.qty} > 0
              THEN ROUND(
                ((${products.quantity} * ${products.priceIn} + ${money(agg.value)})
                / (${products.quantity} + ${agg.qty}))::numeric,
                2
              )
              ELSE ${products.priceIn} END`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(products.businessId, businessId), eq(products.id, productId)),
        );
    }

    // Selling-price handling per product (reprice existing batches up, or track
    // the FIFO-front price).
    for (const [productId, info] of productInfo) {
      const currentPriceOut = Number(info.priceOut);
      const newPriceOut = Math.max(
        ...lines
          .filter((l) => l.productId === productId)
          .map((l) => Number(l.priceOut)),
      );
      const reprice = info.repriceOverride ?? repriceExistingDefault;

      if (newPriceOut > currentPriceOut && reprice) {
        await tx
          .update(inventoryBatches)
          .set({priceOut: money(newPriceOut)})
          .where(
            and(
              eq(inventoryBatches.businessId, businessId),
              eq(inventoryBatches.productId, productId),
              gt(inventoryBatches.qtyRemaining, 0),
            ),
          );
        await tx
          .update(products)
          .set({priceOut: money(newPriceOut), updatedAt: new Date()})
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, productId),
            ),
          );
      } else {
        const [front] = await tx
          .select({priceOut: inventoryBatches.priceOut})
          .from(inventoryBatches)
          .where(
            and(
              eq(inventoryBatches.businessId, businessId),
              eq(inventoryBatches.productId, productId),
              gt(inventoryBatches.qtyRemaining, 0),
            ),
          )
          .orderBy(asc(inventoryBatches.createdAt))
          .limit(1);
        if (front) {
          await tx
            .update(products)
            .set({priceOut: front.priceOut, updatedAt: new Date()})
            .where(
              and(
                eq(products.businessId, businessId),
                eq(products.id, productId),
              ),
            );
        }
      }
    }
  }

  /**
   * Receive a draft receipt: apply its stored lines to stock/cost and flip the
   * status to 'received'. Rebuilds the apply inputs from the saved items.
   */
  async receiveReceipt(
    businessId: string,
    receiptId: string,
  ): Promise<ReceiptWithItems> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    if (receipt.status !== 'draft') {
      throw new AppException(ErrorCode.RECEIPT_ONLY_DRAFT_RECEIVABLE);
    }

    const items = await this.dbService.db
      .select()
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receiptId));

    const [settings] = await this.dbService.db
      .select({priceIncreaseMode: receiptSettings.priceIncreaseMode})
      .from(receiptSettings)
      .where(eq(receiptSettings.businessId, businessId))
      .limit(1);
    const repriceExistingDefault =
      settings?.priceIncreaseMode === 'REPRICE_EXISTING';

    // Cost is stored in base UZS; convert the saved line prices by the receipt's
    // rate (1 for UZS receipts).
    const rateToBase =
      receipt.currency === 'USD' ? Number(receipt.usdRate ?? 0) : 1;

    // Rebuild the apply inputs from the saved lines + the products' live prices.
    const lines: ReceiptLine[] = [];
    const received = new Map<string, {qty: number; value: number}>();
    const productInfo = new Map<
      string,
      {name: string; priceOut: string; repriceOverride?: boolean}
    >();
    const wholesaleByProduct = new Map<string, string>();
    const bundleByProduct = new Map<string, string>();

    for (const it of items) {
      if (!it.productId) continue;
      let info = productInfo.get(it.productId);
      if (!info) {
        const [product] = await this.dbService.db
          .select({priceOut: products.priceOut})
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, it.productId),
            ),
          )
          .limit(1);
        info = {
          name: it.productName,
          priceOut: product?.priceOut ?? it.priceOut ?? '0',
        };
        productInfo.set(it.productId, info);
      }
      const priceOut = it.priceOut ?? info.priceOut;
      if (it.priceWholesale != null) {
        wholesaleByProduct.set(it.productId, it.priceWholesale);
      }
      if (it.priceBundle != null) {
        bundleByProduct.set(it.productId, it.priceBundle);
      }
      const priceInBase = Number(it.priceIn) * rateToBase;
      lines.push({
        itemId: it.id,
        productId: it.productId,
        productName: it.productName,
        priceIn: it.priceIn,
        priceInBase: money(priceInBase),
        currency: it.currency ?? 'UZS',
        priceOut,
        priceWholesale: it.priceWholesale,
        priceBundle: it.priceBundle,
        quantity: it.quantity,
        lineTotal: it.lineTotal,
      });
      const agg = received.get(it.productId) ?? {qty: 0, value: 0};
      agg.qty += it.quantity;
      agg.value += priceInBase * it.quantity;
      received.set(it.productId, agg);
    }

    const receiveBranchId =
      receipt.branchId ??
      (await this.branchService.ensureDefault(businessId)).id;
    await this.dbService.db.transaction(async (tx) => {
      await this.applyReceiptStockTx(
        tx,
        businessId,
        receiveBranchId,
        lines,
        received,
        productInfo,
        wholesaleByProduct,
        bundleByProduct,
        repriceExistingDefault,
      );
      await tx
        .update(goodsReceipts)
        .set({status: 'received', updatedAt: new Date()})
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        );
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  /**
   * Load a receipt that may still be taken back whole.
   *
   * A draft qualifies trivially — it holds nothing. A received one qualifies
   * only while every unit it brought in is still on the shelf: the moment a
   * sale consumes one, that sale's cost came out of this receipt's batch, and
   * unwinding the batch would rewrite a closed sale. That is the same line the
   * returns flow draws, and it is drawn here for the same reason.
   *
   * Payments and returns block it too. Both are records of their own, made
   * against this document; deleting the document under them would leave money
   * and goods pointing at nothing.
   */
  private async loadReversible(
    businessId: string,
    receiptId: string,
  ): Promise<{receipt: GoodsReceipt; items: GoodsReceiptItem[]}> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);

    const items = await this.dbService.db
      .select()
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receiptId));

    if (receipt.status === 'draft') return {receipt, items};

    const [ret] = await this.dbService.db
      .select({id: supplierReturns.id})
      .from(supplierReturns)
      .where(
        and(
          eq(supplierReturns.businessId, businessId),
          eq(supplierReturns.receiptId, receiptId),
        ),
      )
      .limit(1);
    if (ret) throw new AppException(ErrorCode.RECEIPT_HAS_RETURNS);

    const [pay] = await this.dbService.db
      .select({id: supplierPayments.id})
      .from(supplierPayments)
      .where(
        and(
          eq(supplierPayments.businessId, businessId),
          eq(supplierPayments.receiptId, receiptId),
        ),
      )
      .limit(1);
    if (pay) throw new AppException(ErrorCode.RECEIPT_HAS_PAYMENTS);

    const itemIds = items.map((i) => i.id);
    if (itemIds.length) {
      const batches = await this.dbService.db
        .select({
          receiptItemId: inventoryBatches.receiptItemId,
          qtyReceived: inventoryBatches.qtyReceived,
          qtyRemaining: inventoryBatches.qtyRemaining,
        })
        .from(inventoryBatches)
        .where(
          and(
            eq(inventoryBatches.businessId, businessId),
            inArray(inventoryBatches.receiptItemId, itemIds),
          ),
        );
      // Fractions of a kilo are stored to the gram, so compare with the same
      // tolerance the rest of the stock maths uses rather than exactly.
      const consumed = batches.find(
        (b) => b.qtyReceived - b.qtyRemaining > 0.0005,
      );
      if (consumed) {
        const item = items.find((i) => i.id === consumed.receiptItemId);
        throw new AppException(ErrorCode.RECEIPT_PARTLY_SOLD, {
          name: item?.productName ?? '',
          sold:
            Math.round((consumed.qtyReceived - consumed.qtyRemaining) * 1000) /
            1000,
        });
      }
    }

    return {receipt, items};
  }

  /**
   * Undo what receiving this document did to stock and cost.
   *
   * Only ever called for a receipt `loadReversible` has cleared, so every
   * batch it opened is still whole and can simply be dropped. Cost is not
   * un-blended arithmetically — `products.priceIn` is a weighted average
   * across receipts and subtracting one term back out drifts — it is
   * RECOMPUTED from the batches that remain, which is exact by construction
   * and self-healing if anything was ever off.
   */
  private async reverseReceiptStockTx(
    tx: DbTx,
    businessId: string,
    receipt: GoodsReceipt,
    items: GoodsReceiptItem[],
  ): Promise<void> {
    const itemIds = items.map((i) => i.id);
    if (!itemIds.length) return;

    const perProduct = new Map<string, number>();
    for (const it of items) {
      if (!it.productId) continue;
      perProduct.set(
        it.productId,
        (perProduct.get(it.productId) ?? 0) + it.quantity,
      );
    }

    await tx
      .delete(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          inArray(inventoryBatches.receiptItemId, itemIds),
        ),
      );

    const branchId = receipt.branchId;
    for (const [productId, qty] of perProduct) {
      if (branchId) {
        await tx
          .update(branchStock)
          .set({
            quantity: sql`GREATEST(ROUND((${branchStock.quantity} - ${qty})::numeric, 3), 0)`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(branchStock.businessId, businessId),
              eq(branchStock.productId, productId),
              eq(branchStock.branchId, branchId),
            ),
          );
      }

      // What this product still has in open lots, now that this receipt's are
      // gone: the quantity is the truth for stock, the value for cost.
      const [left] = await tx
        .select({
          qty: sql<string>`COALESCE(SUM(${inventoryBatches.qtyRemaining}), 0)`,
          value: sql<string>`COALESCE(SUM(${inventoryBatches.qtyRemaining} * ${inventoryBatches.priceIn}), 0)`,
        })
        .from(inventoryBatches)
        .where(
          and(
            eq(inventoryBatches.businessId, businessId),
            eq(inventoryBatches.productId, productId),
            gt(inventoryBatches.qtyRemaining, 0),
          ),
        );
      const leftQty = Number(left?.qty ?? 0);
      const leftValue = Number(left?.value ?? 0);

      await tx
        .update(products)
        .set({
          quantity: sql`GREATEST(ROUND((${products.quantity} - ${qty})::numeric, 3), 0)`,
          // With nothing left in lots there is no average to take — the last
          // cost known is better than zeroing a price the shop still quotes.
          ...(leftQty > 0
            ? {priceIn: money(leftValue / leftQty)}
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(eq(products.businessId, businessId), eq(products.id, productId)),
        );

      // Selling price follows the FIFO front of what remains — the same rule
      // receiving uses when it is not repricing.
      const [front] = await tx
        .select({priceOut: inventoryBatches.priceOut})
        .from(inventoryBatches)
        .where(
          and(
            eq(inventoryBatches.businessId, businessId),
            eq(inventoryBatches.productId, productId),
            gt(inventoryBatches.qtyRemaining, 0),
          ),
        )
        .orderBy(asc(inventoryBatches.createdAt))
        .limit(1);
      if (front) {
        await tx
          .update(products)
          .set({priceOut: front.priceOut, updatedAt: new Date()})
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, productId),
            ),
          );
      }
    }
  }

  /**
   * Edit a DRAFT receipt: the payload replaces its header and every line.
   *
   * A draft holds no stock, batches, payments or returns, so swapping its
   * lines needs no reversal — it stays a draft and is applied later by
   * receiving it.
   *
   * A RECEIVED receipt is never edited. Its goods are on the shelf and its
   * cost is already blended into the products, so rewriting the document would
   * move real inventory behind what reads like a document change — and a
   * client that merely retried a save (a stale tab, a mobile app, an
   * integration) would move it without anyone deciding to. A mistake on a
   * received receipt is corrected by a supplier return, or by deleting the
   * receipt outright, which asks for that consent explicitly.
   */
  async update(
    businessId: string,
    receiptId: string,
    dto: UpdateReceiptDto,
  ): Promise<ReceiptWithItems> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    if (receipt.status !== 'draft') {
      throw new AppException(ErrorCode.RECEIPT_ONLY_DRAFT_EDITABLE);
    }

    // Stock, cost and price tiers are not touched here — a draft applies none
    // of that until it is received — so only the document's own fields are
    // taken off the prepared payload.
    const {supplierName, currency, rateToBase, lines, total, itemCount} =
      await this.prepareReceipt(businessId, dto);

    // Keep the receipt on its current branch unless the edit moves it.
    const branchId =
      dto.branchId ??
      receipt.branchId ??
      (await this.branchService.ensureDefault(businessId)).id;

    await this.dbService.db.transaction(async (tx) => {
      // A draft holds no batches and no stock — its lines are just swapped.
      await tx
        .delete(goodsReceiptItems)
        .where(
          and(
            eq(goodsReceiptItems.businessId, businessId),
            eq(goodsReceiptItems.receiptId, receiptId),
          ),
        );

      await tx.insert(goodsReceiptItems).values(
        lines.map((line) => ({
          id: line.itemId,
          receiptId,
          businessId,
          productId: line.productId,
          productName: line.productName,
          priceIn: line.priceIn,
          currency: line.currency,
          priceOut: line.priceOut,
          priceWholesale: line.priceWholesale,
          priceBundle: line.priceBundle,
          quantity: line.quantity,
          lineTotal: line.lineTotal,
        })),
      );

      await tx
        .update(goodsReceipts)
        .set({
          supplierId: dto.supplierId ?? null,
          supplierName,
          branchId,
          totalAmount: money(total),
          currency,
          usdRate: currency === 'USD' ? money(rateToBase) : null,
          itemCount,
          note: dto.note ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        );
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  /**
   * Fix a receipt's header — its supplier and its branch ("do'kon") — at any
   * point in its life, not just while it is a draft. Both are things a shop
   * commonly gets wrong on entry and only notices later.
   *
   * A draft holds nothing, so it is a plain relabel. A received receipt already
   * put stock somewhere: moving it to another branch moves what is LEFT of its
   * own lots along with it, while the part already sold stays booked to the
   * branch that sold it. The supplier is metadata, but this receipt's payments
   * and returns each carry a supplier snapshot of their own — they are
   * relabelled too, or the supplier ledger would split across two names.
   */
  async updateHeader(
    businessId: string,
    receiptId: string,
    dto: UpdateReceiptHeaderDto,
  ): Promise<ReceiptWithItems> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);

    // Supplier: undefined leaves it alone, null detaches it.
    const supplierGiven = dto.supplierId !== undefined;
    let supplierId = receipt.supplierId;
    let supplierName = receipt.supplierName;
    if (supplierGiven) {
      if (dto.supplierId) {
        const [supplier] = await this.dbService.db
          .select()
          .from(suppliers)
          .where(
            and(
              eq(suppliers.businessId, businessId),
              eq(suppliers.id, dto.supplierId),
            ),
          )
          .limit(1);
        if (!supplier) {
          throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND_BY_ID, {
            supplierId: dto.supplierId,
          });
        }
        supplierId = supplier.id;
        supplierName = supplier.name;
      } else {
        supplierId = null;
        supplierName = null;
      }
    }

    // Legacy rows can carry no branch; their stock went to the default one.
    const fromBranchId =
      receipt.branchId ??
      (await this.branchService.ensureDefault(businessId)).id;
    let branchId = fromBranchId;
    if (dto.branchId !== undefined && dto.branchId !== fromBranchId) {
      const [branch] = await this.dbService.db
        .select()
        .from(branches)
        .where(
          and(
            eq(branches.businessId, businessId),
            eq(branches.id, dto.branchId),
          ),
        )
        .limit(1);
      if (!branch) throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
      branchId = branch.id;
    }

    // Only a received receipt holds stock to move.
    const movesStock = branchId !== fromBranchId && receipt.status !== 'draft';
    // Same freeze as receiving: an open count snapshots the book figure, and
    // shifting stock between branches underneath it would desync the count.
    if (
      movesStock &&
      (await isStockTakeActive(this.cache, this.dbService.db, businessId))
    ) {
      throw new AppException(ErrorCode.RECEIPT_FROZEN_STOCK_TAKE);
    }

    await this.dbService.db.transaction(async (tx) => {
      if (movesStock) {
        await this.moveReceiptStockTx(
          tx,
          businessId,
          receiptId,
          fromBranchId,
          branchId,
        );
      }

      await tx
        .update(goodsReceipts)
        .set({supplierId, supplierName, branchId, updatedAt: new Date()})
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        );

      if (supplierGiven) {
        await tx
          .update(supplierPayments)
          .set({supplierId, supplierName})
          .where(
            and(
              eq(supplierPayments.businessId, businessId),
              eq(supplierPayments.receiptId, receiptId),
            ),
          );
        await tx
          .update(supplierReturns)
          .set({supplierId, supplierName})
          .where(
            and(
              eq(supplierReturns.businessId, businessId),
              eq(supplierReturns.receiptId, receiptId),
            ),
          );
      }
    });

    return this.findOne(businessId, receiptId) as Promise<ReceiptWithItems>;
  }

  /**
   * Move a received receipt's own inventory lots from one branch to another,
   * along with the branch stock they back. products.quantity is the sum across
   * branches, so it does not change — only where the goods sit does.
   *
   * A lot nobody has touched moves whole. A partly sold lot is split: the sold
   * part stays at the old branch (that is where it was sold from) and the
   * remainder opens as a lot at the new branch, keeping the receipt link so a
   * later branch change finds it again. Splitting `qtyReceived` across the two
   * rows keeps the receipt's received total exact.
   */
  private async moveReceiptStockTx(
    tx: DbTx,
    businessId: string,
    receiptId: string,
    fromBranchId: string,
    toBranchId: string,
  ): Promise<void> {
    const itemIds = (
      await tx
        .select({id: goodsReceiptItems.id})
        .from(goodsReceiptItems)
        .where(
          and(
            eq(goodsReceiptItems.businessId, businessId),
            eq(goodsReceiptItems.receiptId, receiptId),
          ),
        )
    ).map((r) => r.id);
    if (itemIds.length === 0) return;

    const lots = await tx
      .select({
        id: inventoryBatches.id,
        productId: inventoryBatches.productId,
        receiptItemId: inventoryBatches.receiptItemId,
        priceIn: inventoryBatches.priceIn,
        priceOut: inventoryBatches.priceOut,
        qtyReceived: inventoryBatches.qtyReceived,
        qtyRemaining: inventoryBatches.qtyRemaining,
        createdAt: inventoryBatches.createdAt,
      })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          eq(inventoryBatches.branchId, fromBranchId),
          inArray(inventoryBatches.receiptItemId, itemIds),
        ),
      )
      .for('update');

    const moved = new Map<string, number>();
    const newLots: (typeof inventoryBatches.$inferInsert)[] = [];

    for (const lot of lots) {
      const qty = lot.qtyRemaining;
      // Sold out at the old branch — nothing left of this lot to move.
      if (qty <= 0) continue;
      moved.set(
        lot.productId,
        Math.round(((moved.get(lot.productId) ?? 0) + qty) * 1000) / 1000,
      );

      if (qty === lot.qtyReceived) {
        await tx
          .update(inventoryBatches)
          .set({branchId: toBranchId})
          .where(eq(inventoryBatches.id, lot.id));
        continue;
      }

      await tx
        .update(inventoryBatches)
        .set({
          qtyReceived: Math.round((lot.qtyReceived - qty) * 1000) / 1000,
          qtyRemaining: 0,
        })
        .where(eq(inventoryBatches.id, lot.id));
      newLots.push({
        id: generateId(),
        businessId,
        productId: lot.productId,
        branchId: toBranchId,
        receiptItemId: lot.receiptItemId,
        priceIn: lot.priceIn,
        priceOut: lot.priceOut,
        qtyReceived: qty,
        qtyRemaining: qty,
        createdAt: lot.createdAt,
      });
    }

    if (newLots.length > 0) await tx.insert(inventoryBatches).values(newLots);

    // Per-branch on-hand follows the lots. ROUND needs the ::numeric cast —
    // branch_stock.quantity is double precision.
    for (const [productId, qty] of moved) {
      await tx
        .update(branchStock)
        .set({
          quantity: sql`GREATEST(0, ROUND((${branchStock.quantity} - ${qty})::numeric, 3))`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(branchStock.businessId, businessId),
            eq(branchStock.productId, productId),
            eq(branchStock.branchId, fromBranchId),
          ),
        );
      await tx
        .insert(branchStock)
        .values({
          id: generateId(),
          businessId,
          productId,
          branchId: toBranchId,
          quantity: qty,
        })
        .onConflictDoUpdate({
          target: [branchStock.productId, branchStock.branchId],
          set: {
            quantity: sql`ROUND((${branchStock.quantity} + ${qty})::numeric, 3)`,
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * Delete a draft receipt and its lines. Nothing else references a draft —
   * stock, batches, payments and returns only exist once it is received.
   */
  /**
   * Delete a receipt.
   *
   * A draft is just a document and goes quietly. A received one is taken off
   * stock first — its batches dropped, cost recomputed from what remains —
   * which is only allowed while none of it has been sold. Owner-only at the
   * controller, because this removes a document the books refer to.
   */
  async remove(
    businessId: string,
    receiptId: string,
    opts: {amendReceived?: boolean} = {},
  ): Promise<void> {
    const {receipt, items} = await this.loadReversible(businessId, receiptId);

    // Same consent as an edit, for the same reason: deleting a received
    // receipt takes its goods off the shelf.
    if (receipt.status !== 'draft' && opts.amendReceived !== true) {
      throw new AppException(ErrorCode.RECEIPT_ONLY_DRAFT_DELETABLE);
    }

    await this.dbService.db.transaction(async (tx) => {
      if (receipt.status !== 'draft') {
        await this.reverseReceiptStockTx(tx, businessId, receipt, items);
      }
      await tx
        .delete(goodsReceiptItems)
        .where(
          and(
            eq(goodsReceiptItems.businessId, businessId),
            eq(goodsReceiptItems.receiptId, receiptId),
          ),
        );
      await tx
        .delete(goodsReceipts)
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        );
    });
  }

  async findAll(
    businessId: string,
    options?: {
      page?: number;
      limit?: number;
      supplierId?: string;
      branchId?: string;
      paymentStatus?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
      /** Free text: supplier, note, document id, or a product on the receipt. */
      search?: string;
    },
  ): Promise<{
    receipts: Array<GoodsReceipt & {branchName: string | null}>;
    total: number;
    page: number;
    limit: number;
  }> {
    const page = options?.page || 1;
    const limit = options?.limit || 10;
    const offset = (page - 1) * limit;

    const whereConditions = [eq(goodsReceipts.businessId, businessId)];
    if (options?.supplierId) {
      whereConditions.push(eq(goodsReceipts.supplierId, options.supplierId));
    }
    if (options?.branchId) {
      whereConditions.push(eq(goodsReceipts.branchId, options.branchId));
    }
    if (options?.paymentStatus) {
      whereConditions.push(
        eq(goodsReceipts.paymentStatus, options.paymentStatus),
      );
    }
    if (options?.status === 'draft') {
      whereConditions.push(eq(goodsReceipts.status, 'draft'));
    } else if (options?.status === 'received') {
      // 'received' covers both new receipts and legacy 'Completed' rows.
      whereConditions.push(ne(goodsReceipts.status, 'draft'));
    }
    if (options?.startDate) {
      whereConditions.push(
        gte(goodsReceipts.createdAt, businessDayStart(options.startDate)),
      );
    }
    if (options?.endDate) {
      whereConditions.push(
        lte(goodsReceipts.createdAt, businessDayEnd(options.endDate)),
      );
    }

    // A goods receipt carries no document number, so people look for it by who
    // supplied it, by what is on it, or by the short id the list shows. The
    // product match is an EXISTS on the receipt's own lines (their name
    // snapshot, plus the catalogue's barcode) — that is how procurement asks
    // the question: "which delivery had this item?".
    const search = options?.search?.trim();
    if (search) {
      const like = `%${search}%`;
      whereConditions.push(
        or(
          ilike(goodsReceipts.supplierName, like),
          ilike(goodsReceipts.note, like),
          ilike(goodsReceipts.id, like),
          sql`exists (
            select 1 from ${goodsReceiptItems}
            left join ${products} on ${products.id} = ${goodsReceiptItems.productId}
            where ${goodsReceiptItems.receiptId} = ${goodsReceipts.id}
              and (${goodsReceiptItems.productName} ilike ${like}
                   or ${products.barcode} ilike ${like}
                   or ${products.code} ilike ${like})
          )`,
        )!,
      );
    }

    const [{value: total}] = await this.dbService.db
      .select({value: sql<number>`count(*)::int`})
      .from(goodsReceipts)
      .where(and(...whereConditions));

    const paginated = await this.dbService.db
      .select({...getTableColumns(goodsReceipts), branchName: branches.name})
      .from(goodsReceipts)
      .leftJoin(branches, eq(goodsReceipts.branchId, branches.id))
      .where(and(...whereConditions))
      .orderBy(desc(goodsReceipts.createdAt))
      .limit(limit)
      .offset(offset);

    return {receipts: paginated, total, page, limit};
  }

  async findOne(
    businessId: string,
    receiptId: string,
  ): Promise<ReceiptWithItems | null> {
    const [receipt] = await this.dbService.db
      .select({...getTableColumns(goodsReceipts), branchName: branches.name})
      .from(goodsReceipts)
      .leftJoin(branches, eq(goodsReceipts.branchId, branches.id))
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);

    if (!receipt) {
      return null;
    }

    const items = await this.dbService.db
      .select()
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receiptId));

    const payments = await this.getPayments(businessId, receiptId);
    const returns = await this.getReturns(businessId, receiptId);

    return {...receipt, items, payments, returns};
  }

  // ─── Supplier payments (T1) ───────────────────────────────────────────────

  /** Payment history for a receipt, newest first. */
  async getPayments(
    businessId: string,
    receiptId: string,
  ): Promise<SupplierPayment[]> {
    return this.dbService.db
      .select()
      .from(supplierPayments)
      .where(
        and(
          eq(supplierPayments.businessId, businessId),
          eq(supplierPayments.receiptId, receiptId),
        ),
      )
      .orderBy(desc(supplierPayments.createdAt));
  }

  /**
   * Record a payment to the supplier against a receipt: book a finance expense
   * (so the money-out hits the account balance and shows in Moliya), store the
   * payment row, and roll up the receipt's paidAmount/paymentStatus — all in one
   * transaction so the finance ledger and the receipt never drift apart.
   */
  async addPayment(
    businessId: string,
    receiptId: string,
    dto: AddPaymentDto,
    account?: IAccount,
  ): Promise<{payment: SupplierPayment; receipt: GoodsReceipt}> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    if (receipt.status === 'draft') {
      throw new AppException(ErrorCode.RECEIPT_RECEIVE_BEFORE_PAYMENT);
    }

    const cashier = await this.resolveCashier(account);
    const currency = receipt.currency ?? 'UZS';
    const total = Number(receipt.totalAmount);
    const newPaid = Number(receipt.paidAmount) + dto.amount;
    const status = paymentStatusOf(newPaid, total);
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();

    return this.dbService.db.transaction(async (tx) => {
      const txn = await this.financeService.recordExpenseTx(tx, businessId, {
        accountId: dto.accountId,
        amount: dto.amount,
        currency,
        note:
          dto.note ??
          `Ta'minotchi to'lovi${receipt.supplierName ? `: ${receipt.supplierName}` : ''}`,
        cashierId: cashier.id,
        cashierName: cashier.name,
      });

      const [payment] = await tx
        .insert(supplierPayments)
        .values({
          id: generateId(),
          businessId,
          receiptId,
          supplierId: receipt.supplierId,
          supplierName: receipt.supplierName,
          amount: money(dto.amount),
          currency,
          accountId: txn.accountId,
          accountName: txn.accountName,
          financialTransactionId: txn.id,
          note: dto.note ?? null,
          cashierId: cashier.id,
          cashierName: cashier.name,
          paidAt,
        })
        .returning();

      const [updated] = await tx
        .update(goodsReceipts)
        .set({
          paidAmount: money(newPaid),
          paymentStatus: status,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        )
        .returning();

      return {payment, receipt: updated};
    });
  }

  // ─── Supplier returns (T3) ────────────────────────────────────────────────

  /** Returns made against a receipt, newest first. */
  async getReturns(
    businessId: string,
    receiptId: string,
  ): Promise<SupplierReturn[]> {
    return this.dbService.db
      .select()
      .from(supplierReturns)
      .where(
        and(
          eq(supplierReturns.businessId, businessId),
          eq(supplierReturns.receiptId, receiptId),
        ),
      )
      .orderBy(desc(supplierReturns.createdAt));
  }

  /**
   * Return received goods to the supplier: reverse stock and the receipt's
   * inventory batches (oldest-first, at their purchase cost), and reduce the
   * amount owed on the receipt (settled = paid + returned). One transaction so
   * stock, batches and the receipt stay consistent. No cash movement — returned
   * goods reduce the obligation rather than moving money.
   */
  async createReturn(
    businessId: string,
    receiptId: string,
    dto: CreateReturnDto,
    account?: IAccount,
  ): Promise<{return: SupplierReturn; receipt: GoodsReceipt}> {
    const [receipt] = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    if (receipt.status === 'draft') {
      throw new AppException(ErrorCode.RECEIPT_RECEIVE_BEFORE_RETURN);
    }

    // Aggregate requested quantities per product (sum duplicate lines).
    const requested = new Map<string, number>();
    for (const line of dto.items) {
      if (line.quantity <= 0) continue;
      requested.set(
        line.productId,
        (requested.get(line.productId) ?? 0) + line.quantity,
      );
    }
    if (requested.size === 0) {
      throw new AppException(ErrorCode.RECEIPT_NOTHING_TO_RETURN);
    }

    // Receipt lines (product names) + the receipt's open batches for reversal.
    const receiptItems = await this.dbService.db
      .select()
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receiptId));
    const nameByProduct = new Map<string, string>();
    // Original unit cost per receipt line (receipt currency) — the return value
    // reduces the debt in the receipt currency, not the base UZS batch cost.
    const priceInByItem = new Map<string, number>();
    for (const it of receiptItems) {
      if (it.productId) nameByProduct.set(it.productId, it.productName);
      priceInByItem.set(it.id, Number(it.priceIn));
    }
    const itemIds = receiptItems.map((it) => it.id);

    const batches = itemIds.length
      ? await this.dbService.db
          .select()
          .from(inventoryBatches)
          .where(
            and(
              eq(inventoryBatches.businessId, businessId),
              inArray(inventoryBatches.receiptItemId, itemIds),
              gt(inventoryBatches.qtyRemaining, 0),
            ),
          )
          .orderBy(asc(inventoryBatches.createdAt))
      : [];
    const batchesByProduct = new Map<string, typeof batches>();
    for (const b of batches) {
      const list = batchesByProduct.get(b.productId) ?? [];
      list.push(b);
      batchesByProduct.set(b.productId, list);
    }

    // Unit type per returned product, so weighed goods count as one item (their
    // fractional kg isn't a piece count) — keeps itemCount whole.
    const requestedIds = [...requested.keys()];
    const productMeta = requestedIds.length
      ? await this.dbService.db
          .select({id: products.id, quantityType: products.quantityType})
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              inArray(products.id, requestedIds),
            ),
          )
      : [];
    const qtyTypeByProduct = new Map(
      productMeta.map((p) => [p.id, p.quantityType]),
    );

    // Plan the reversal: consume the receipt's batches oldest-first and value
    // each returned unit at that batch's purchase cost.
    const returnLines: {
      productId: string;
      productName: string;
      quantity: number;
      priceIn: string;
      lineTotal: string;
    }[] = [];
    const batchUpdates: {id: string; newRemaining: number}[] = [];
    let returnTotal = 0;
    let returnedQty = 0;

    for (const [productId, qty] of requested) {
      const name = nameByProduct.get(productId);
      if (!name) {
        throw new AppException(ErrorCode.RECEIPT_PRODUCT_NOT_ON_RECEIPT, {
          productId,
        });
      }
      const pb = batchesByProduct.get(productId) ?? [];
      const available = pb.reduce((s, b) => s + b.qtyRemaining, 0);
      if (qty > available) {
        throw new AppException(ErrorCode.RECEIPT_RETURN_EXCEEDS_STOCK, {
          qty,
          name,
          available,
        });
      }
      let toReturn = qty;
      let lineValue = 0;
      for (const b of pb) {
        if (toReturn <= 0) break;
        const take = Math.min(toReturn, b.qtyRemaining);
        // Value the return at the line's original (receipt-currency) cost.
        const unit = b.receiptItemId
          ? (priceInByItem.get(b.receiptItemId) ?? Number(b.priceIn))
          : Number(b.priceIn);
        lineValue += take * unit;
        toReturn -= take;
        batchUpdates.push({
          id: b.id,
          newRemaining: Math.round((b.qtyRemaining - take) * 1000) / 1000,
        });
      }
      returnTotal += lineValue;
      returnedQty += qtyTypeByProduct.get(productId) === 'kg' ? 1 : qty;
      returnLines.push({
        productId,
        productName: name,
        quantity: qty,
        priceIn: money(qty > 0 ? lineValue / qty : 0),
        lineTotal: money(lineValue),
      });
    }

    const cashier = await this.resolveCashier(account);
    const currency = receipt.currency ?? 'UZS';
    const returnId = generateId();
    const newReturned = Number(receipt.returnedAmount) + returnTotal;
    const status = paymentStatusOf(
      Number(receipt.paidAmount) + newReturned,
      Number(receipt.totalAmount),
    );

    const returnBranchId =
      receipt.branchId ??
      (await this.branchService.ensureDefault(businessId)).id;
    return this.dbService.db.transaction(async (tx) => {
      const [ret] = await tx
        .insert(supplierReturns)
        .values({
          id: returnId,
          businessId,
          receiptId,
          supplierId: receipt.supplierId,
          supplierName: receipt.supplierName,
          totalAmount: money(returnTotal),
          currency,
          itemCount: returnedQty,
          note: dto.note ?? null,
          cashierId: cashier.id,
          cashierName: cashier.name,
        })
        .returning();

      await tx.insert(supplierReturnItems).values(
        returnLines.map((l) => ({
          id: generateId(),
          returnId,
          businessId,
          productId: l.productId,
          productName: l.productName,
          priceIn: l.priceIn,
          quantity: l.quantity,
          lineTotal: l.lineTotal,
        })),
      );

      // Reverse the batches (reduce qtyRemaining) …
      for (const u of batchUpdates) {
        await tx
          .update(inventoryBatches)
          .set({qtyRemaining: u.newRemaining})
          .where(eq(inventoryBatches.id, u.id));
      }

      // … and the stock by the same amount, off the receipt's branch (and the
      // products.quantity sum), keeping the batch ↔ stock invariant.
      for (const [productId, qty] of requested) {
        await tx
          .insert(branchStock)
          .values({
            id: generateId(),
            businessId,
            productId,
            branchId: returnBranchId,
            quantity: -qty,
          })
          .onConflictDoUpdate({
            target: [branchStock.productId, branchStock.branchId],
            set: {
              quantity: sql`ROUND((${branchStock.quantity} - ${qty})::numeric, 3)`,
              updatedAt: new Date(),
            },
          });
        await tx
          .update(products)
          .set({
            quantity: sql`GREATEST(0, ROUND((${products.quantity} - ${qty})::numeric, 3))`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, productId),
            ),
          );
      }

      const [updated] = await tx
        .update(goodsReceipts)
        .set({
          returnedAmount: money(newReturned),
          paymentStatus: status,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(goodsReceipts.id, receiptId),
            eq(goodsReceipts.businessId, businessId),
          ),
        )
        .returning();

      return {return: ret, receipt: updated};
    });
  }
}
