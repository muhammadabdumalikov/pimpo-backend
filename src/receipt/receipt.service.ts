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
  lte,
  ne,
  inArray,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {FinanceService} from '../finance/finance.service';
import {BranchService} from '../branch/branch.service';
import {CreateReceiptDto} from './dto/create-receipt.dto';
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
   * Create a goods receipt: insert the document + items, increment product
   * stock, and roll each product's purchase cost into a weighted average — all
   * in one transaction. Receipts are immutable once created.
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

    // Default selling-price behaviour comes from the business settings, but a
    // receipt line can override it per product.
    const [settings] = await this.dbService.db
      .select({priceIncreaseMode: receiptSettings.priceIncreaseMode})
      .from(receiptSettings)
      .where(eq(receiptSettings.businessId, businessId))
      .limit(1);
    const repriceExistingDefault =
      settings?.priceIncreaseMode === 'REPRICE_EXISTING';

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

    const all = await this.dbService.db
      .select()
      .from(goodsReceipts)
      .where(and(...whereConditions));
    const total = all.length;

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
