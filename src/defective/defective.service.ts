import {Inject, Injectable, Logger} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  branches,
  businesses,
  defectiveLots,
  defectiveMovementItems,
  defectiveMovements,
  goodsReceiptItems,
  goodsReceipts,
  inventoryBatches,
  products,
  staff,
  supplierReturnItems,
  supplierReturns,
  suppliers,
  type DefectiveMovement,
  type DefectiveMovementItem,
} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {IAccount} from '../business/types';
import {generateId} from '../utils/uuid';
import {applyBranchStockDelta, getBranchStock} from '../common/branch-stock';
import {consumeBatches} from '../order/costing';
import {isStockTakeActive} from '../common/stock-take-lock';
import {businessDayEnd, businessDayStart} from '../common/business-time';
import {assertReasonNote} from '../common/loss-reasons';
import {
  addDefectiveLotTx,
  consumeDefectiveLotsTx,
  insertDefectiveMovementTx,
  type DefectiveMovementLine,
  type DefectiveMovementType,
} from '../common/defective-stock';
import {outstandingOf, paymentStatusOf} from '../receipt/receipt.service';
import {
  DefectiveSupplierReturnDto,
  ExchangeDefectiveDto,
  MoveToDefectiveDto,
  OpeningDefectiveDto,
  ReleaseDefectiveDto,
  WriteOffDefectiveDto,
} from './dto/defective.dto';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** How long after a business's first defective-stock move opening stock stays open. */
const OPENING_WINDOW_DAYS = 30;
/** Candidate receipts offered per product for a supplier return. */
const CANDIDATES_PER_PRODUCT = 5;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const money = (n: number) => n.toFixed(2);

export interface DefectiveStockRow {
  productId: string;
  productName: string;
  code: string | null;
  barcode: string | null;
  quantityType: string | null;
  branchId: string;
  branchName: string | null;
  qty: number;
  /** At cost (base UZS). */
  value: number;
  /** When the oldest unit still here came in. */
  since: string;
  sources: string[];
}

export interface SupplierCandidate {
  receiptId: string;
  supplierId: string | null;
  supplierName: string | null;
  receivedAt: string;
  /** The receipt line's unit cost, in the receipt currency. */
  priceIn: number;
  currency: string;
  usdRate: number | null;
  /** Still owed on the receipt, in its currency. */
  outstanding: number;
}

/**
 * Yaroqsiz tovarlar ombori — defective goods kept apart from sellable stock
 * until the shop decides what happens to them. See YOQOTISHLAR.md and
 * common/defective-stock.ts (the lot/document writes, shared with the till's
 * defective customer returns).
 *
 * Money: a defective unit is inventory, not a loss. Moving it in or out of
 * sellable stock books nothing; a write-off books its cost as an expense (less
 * opening lots, which were a loss before they were entered); a supplier return
 * takes its value off the chosen receipt's debt, like any supplier return.
 */
@Injectable()
export class DefectiveService {
  private readonly logger = new Logger(DefectiveService.name);

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** What is in defective stock now, per product and branch. */
  async list(
    businessId: string,
    q: {branchId?: string; productId?: string; search?: string} = {},
  ): Promise<{
    items: DefectiveStockRow[];
    totals: {qty: number; value: number};
  }> {
    const where: SQL[] = [
      eq(defectiveLots.businessId, businessId),
      gt(defectiveLots.qtyRemaining, 0),
    ];
    if (q.branchId) where.push(eq(defectiveLots.branchId, q.branchId));
    if (q.productId) where.push(eq(defectiveLots.productId, q.productId));
    const term = q.search?.trim();
    if (term) {
      where.push(
        or(
          ilike(products.name, `%${term}%`),
          ilike(products.code, `%${term}%`),
          ilike(products.barcode, `%${term}%`),
        )!,
      );
    }
    const rows = await this.db
      .select({
        productId: defectiveLots.productId,
        productName: products.name,
        code: products.code,
        barcode: products.barcode,
        quantityType: products.quantityType,
        branchId: defectiveLots.branchId,
        branchName: branches.name,
        qty: sql<string>`SUM(${defectiveLots.qtyRemaining})`,
        value: sql<string>`SUM(${defectiveLots.qtyRemaining} * ${defectiveLots.unitCost})`,
        since: sql<string>`MIN(${defectiveLots.createdAt})`,
        sources: sql<string[]>`array_agg(DISTINCT ${defectiveLots.source})`,
      })
      .from(defectiveLots)
      .innerJoin(products, eq(products.id, defectiveLots.productId))
      .leftJoin(branches, eq(branches.id, defectiveLots.branchId))
      .where(and(...where))
      .groupBy(
        defectiveLots.productId,
        products.name,
        products.code,
        products.barcode,
        products.quantityType,
        defectiveLots.branchId,
        branches.name,
      )
      .orderBy(
        desc(
          sql`SUM(${defectiveLots.qtyRemaining} * ${defectiveLots.unitCost})`,
        ),
      );

    const items = rows.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      code: r.code,
      barcode: r.barcode,
      quantityType: r.quantityType,
      branchId: r.branchId,
      branchName: r.branchName,
      qty: round3(Number(r.qty)),
      value: round2(Number(r.value)),
      since: toIso(r.since),
      sources: r.sources ?? [],
    }));
    return {
      items,
      totals: {
        // Same rule as order item counts: a weighed product counts as one.
        qty: round3(
          items.reduce((s, i) => s + (i.quantityType === 'kg' ? 1 : i.qty), 0),
        ),
        value: round2(items.reduce((s, i) => s + i.value, 0)),
      },
    };
  }

  /** Movement history, newest first, each with its lines. */
  async movements(
    businessId: string,
    q: {
      branchId?: string;
      productId?: string;
      type?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{
    movements: (DefectiveMovement & {
      branchName: string | null;
      items: DefectiveMovementItem[];
    })[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, q.page || 1);
    const limit = Math.min(Math.max(1, q.limit || 20), 100);
    const where: SQL[] = [eq(defectiveMovements.businessId, businessId)];
    if (q.branchId) where.push(eq(defectiveMovements.branchId, q.branchId));
    if (q.type) where.push(eq(defectiveMovements.type, q.type));
    if (q.from) {
      where.push(gte(defectiveMovements.createdAt, businessDayStart(q.from)));
    }
    if (q.to)
      where.push(lte(defectiveMovements.createdAt, businessDayEnd(q.to)));
    if (q.productId) {
      where.push(
        sql`EXISTS (SELECT 1 FROM ${defectiveMovementItems} WHERE ${defectiveMovementItems.movementId} = ${defectiveMovements.id} AND ${defectiveMovementItems.productId} = ${q.productId})`,
      );
    }
    const [agg] = await this.db
      .select({value: count()})
      .from(defectiveMovements)
      .where(and(...where));
    const rows = await this.db
      .select({m: defectiveMovements, branchName: branches.name})
      .from(defectiveMovements)
      .leftJoin(branches, eq(branches.id, defectiveMovements.branchId))
      .where(and(...where))
      .orderBy(desc(defectiveMovements.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);
    const items = rows.length
      ? await this.db
          .select()
          .from(defectiveMovementItems)
          .where(
            inArray(
              defectiveMovementItems.movementId,
              rows.map((r) => r.m.id),
            ),
          )
      : [];
    const byMovement = new Map<string, DefectiveMovementItem[]>();
    for (const it of items) {
      const list = byMovement.get(it.movementId) ?? [];
      list.push(it);
      byMovement.set(it.movementId, list);
    }
    return {
      movements: rows.map((r) => ({
        ...r.m,
        branchName: r.branchName,
        items: byMovement.get(r.m.id) ?? [],
      })),
      total: Number(agg?.value ?? 0),
      page,
      limit,
    };
  }

  /**
   * Opening stock is for entering what was already on hand when the shop
   * started using this: open until 30 days after its first defective-stock
   * move of any kind (open indefinitely before that).
   */
  async openingStatus(
    businessId: string,
  ): Promise<{open: boolean; until: string | null}> {
    const [row] = await this.db
      .select({first: sql<string | null>`MIN(${defectiveMovements.createdAt})`})
      .from(defectiveMovements)
      .where(eq(defectiveMovements.businessId, businessId));
    if (!row?.first) return {open: true, until: null};
    const until = new Date(
      new Date(toIso(row.first)).getTime() + OPENING_WINDOW_DAYS * 86_400_000,
    );
    return {open: Date.now() < until.getTime(), until: until.toISOString()};
  }

  /**
   * Receipts a defective product can go back against: non-draft receipts that
   * brought it in and still carry debt, newest first — the first is the
   * suggestion. Price is that receipt line's unit cost in its currency.
   */
  async supplierCandidates(
    businessId: string,
    productIds: string[],
  ): Promise<{items: {productId: string; candidates: SupplierCandidate[]}[]}> {
    const ids = [...new Set(productIds.filter(Boolean))].slice(0, 200);
    if (!ids.length) return {items: []};
    const rows = await this.db
      .select({
        productId: goodsReceiptItems.productId,
        receiptId: goodsReceipts.id,
        supplierId: goodsReceipts.supplierId,
        supplierName: goodsReceipts.supplierName,
        receivedAt: goodsReceipts.createdAt,
        priceIn: goodsReceiptItems.priceIn,
        currency: goodsReceipts.currency,
        usdRate: goodsReceipts.usdRate,
        totalAmount: goodsReceipts.totalAmount,
        paidAmount: goodsReceipts.paidAmount,
        returnedAmount: goodsReceipts.returnedAmount,
      })
      .from(goodsReceiptItems)
      .innerJoin(
        goodsReceipts,
        eq(goodsReceipts.id, goodsReceiptItems.receiptId),
      )
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          ne(goodsReceipts.status, 'draft'),
          inArray(goodsReceiptItems.productId, ids),
          sql`${goodsReceipts.totalAmount} - ${goodsReceipts.paidAmount} - ${goodsReceipts.returnedAmount} > 0.004`,
        ),
      )
      .orderBy(
        desc(goodsReceipts.createdAt),
        desc(goodsReceiptItems.createdAt),
      );

    const byProduct = new Map<string, SupplierCandidate[]>();
    for (const r of rows) {
      if (!r.productId) continue;
      const list = byProduct.get(r.productId) ?? [];
      // A receipt listing the product twice: the newest line's price wins.
      if (list.some((c) => c.receiptId === r.receiptId)) continue;
      if (list.length >= CANDIDATES_PER_PRODUCT) continue;
      list.push({
        receiptId: r.receiptId,
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        receivedAt: toIso(r.receivedAt),
        priceIn: Number(r.priceIn),
        currency: r.currency,
        usdRate: r.usdRate === null ? null : Number(r.usdRate),
        outstanding: round2(
          Number(r.totalAmount) -
            Number(r.paidAmount) -
            Number(r.returnedAmount),
        ),
      });
      byProduct.set(r.productId, list);
    }
    return {
      items: ids.map((productId) => ({
        productId,
        candidates: byProduct.get(productId) ?? [],
      })),
    };
  }

  // ─── Moves in ─────────────────────────────────────────────────────────────

  /** Sellable stock → defective stock ("yaroqsizga o'tkazish"), at FIFO cost. */
  async moveFromShelf(
    businessId: string,
    dto: MoveToDefectiveDto,
    account?: IAccount,
  ) {
    const lines = this.requireLines(dto.items);
    for (const l of lines) {
      assertReasonNote(l.reasonCode ?? dto.reasonCode, l.note ?? dto.note);
    }
    await this.assertNoStockTake(businessId);
    const cashier = await this.resolveCashier(account);
    const branchId = await this.resolveBranch(businessId, dto.branchId);

    const movementId = generateId();
    await this.db.transaction(async (tx) => {
      const out: DefectiveMovementLine[] = [];
      let itemCount = 0;
      for (const line of lines) {
        const product = await this.lockProduct(tx, businessId, line.productId);
        const available = await getBranchStock(tx, product.id, branchId);
        if (line.qty > available + 1e-9) {
          throw new AppException(ErrorCode.DEFECTIVE_SHELF_EXCEEDS_STOCK, {
            qty: line.qty,
            name: product.name,
            available: round3(available),
          });
        }
        const costing = await consumeBatches(
          tx,
          businessId,
          product.id,
          line.qty,
          'FIFO',
          Number(product.priceIn),
          0,
          branchId,
        );
        await applyBranchStockDelta(
          tx,
          businessId,
          product.id,
          branchId,
          -line.qty,
        );
        await addDefectiveLotTx(tx, {
          businessId,
          productId: product.id,
          branchId,
          qty: line.qty,
          unitCost: costing.costIn,
          source: 'shelf',
          movementId,
        });
        out.push({
          productId: product.id,
          productName: product.name,
          quantity: line.qty,
          unitCost: costing.costIn,
          costTotal: round2(costing.costTotal),
          reasonCode: line.reasonCode ?? dto.reasonCode ?? null,
          note: line.note?.trim() || null,
        });
        itemCount += product.quantityType === 'kg' ? 1 : line.qty;
      }
      await insertDefectiveMovementTx(
        tx,
        {
          id: movementId,
          businessId,
          branchId,
          type: 'in_shelf',
          reasonCode: dto.reasonCode ?? null,
          note: dto.note?.trim() || null,
          cashierId: cashier.id,
          cashierName: cashier.name,
        },
        out,
        itemCount,
      );
    });
    return this.getMovement(businessId, movementId);
  }

  /**
   * Opening defective stock — what was already on hand (e.g. defective returns
   * from before this existed). Owner only, while the opening window is open.
   * Valued at the card's purchase price; it was a loss already, so writing it
   * off later books no second expense.
   */
  async opening(
    businessId: string,
    dto: OpeningDefectiveDto,
    account?: IAccount,
  ) {
    if (account?.type !== 'business') {
      throw new AppException(ErrorCode.DEFECTIVE_OPENING_OWNER_ONLY);
    }
    const status = await this.openingStatus(businessId);
    if (!status.open) {
      throw new AppException(ErrorCode.DEFECTIVE_OPENING_CLOSED, {
        until: status.until?.slice(0, 10) ?? '',
      });
    }
    const lines = this.requireLines(dto.items);
    const cashier = await this.resolveCashier(account);
    const branchId = await this.resolveBranch(businessId, dto.branchId);

    const movementId = generateId();
    await this.db.transaction(async (tx) => {
      const out: DefectiveMovementLine[] = [];
      let itemCount = 0;
      for (const line of lines) {
        const product = await this.lockProduct(tx, businessId, line.productId);
        const unitCost = round2(Number(product.priceIn));
        await addDefectiveLotTx(tx, {
          businessId,
          productId: product.id,
          branchId,
          qty: line.qty,
          unitCost,
          source: 'opening',
          movementId,
        });
        out.push({
          productId: product.id,
          productName: product.name,
          quantity: line.qty,
          unitCost,
          costTotal: round2(unitCost * line.qty),
          note: line.note?.trim() || null,
        });
        itemCount += product.quantityType === 'kg' ? 1 : line.qty;
      }
      await insertDefectiveMovementTx(
        tx,
        {
          id: movementId,
          businessId,
          branchId,
          type: 'in_opening',
          note: dto.note?.trim() || null,
          cashierId: cashier.id,
          cashierName: cashier.name,
        },
        out,
        itemCount,
      );
    });
    return this.getMovement(businessId, movementId);
  }

  // ─── Moves out ────────────────────────────────────────────────────────────

  /** Defective stock → written off. The loss is booked now, as an expense. */
  async writeOff(
    businessId: string,
    dto: WriteOffDefectiveDto,
    account?: IAccount,
  ) {
    const lines = this.requireLines(dto.items);
    for (const l of lines) {
      assertReasonNote(l.reasonCode ?? dto.reasonCode, l.note ?? dto.note);
    }
    const cashier = await this.resolveCashier(account);
    const branchId = await this.resolveBranch(businessId, dto.branchId);
    const names = await this.productInfo(
      businessId,
      lines.map((l) => l.productId),
    );

    const movementId = generateId();
    await this.db.transaction(async (tx) => {
      const out: DefectiveMovementLine[] = [];
      let itemCount = 0;
      for (const line of lines) {
        const info = names.get(line.productId);
        const taken = await consumeDefectiveLotsTx(tx, {
          businessId,
          productId: line.productId,
          branchId,
          qty: line.qty,
          productName: info?.name ?? line.productId,
        });
        out.push({
          productId: line.productId,
          productName: info?.name ?? '—',
          quantity: line.qty,
          unitCost: taken.unitCost,
          costTotal: taken.costTotal,
          lossValue: taken.lossValue,
          reasonCode: line.reasonCode ?? dto.reasonCode ?? null,
          note: line.note?.trim() || null,
        });
        itemCount += info?.quantityType === 'kg' ? 1 : line.qty;
      }
      await insertDefectiveMovementTx(
        tx,
        {
          id: movementId,
          businessId,
          branchId,
          type: 'out_writeoff',
          reasonCode: dto.reasonCode ?? null,
          note: dto.note?.trim() || null,
          cashierId: cashier.id,
          cashierName: cashier.name,
        },
        out,
        itemCount,
      );
      await this.writeExpenseTx(tx, {
        businessId,
        amount: round2(out.reduce((s, l) => s + (l.lossValue ?? 0), 0)),
        cashier,
      });
    });
    return this.getMovement(businessId, movementId);
  }

  /** Defective stock → back on sale (repaired, or moved here by mistake). */
  async toSale(
    businessId: string,
    dto: ReleaseDefectiveDto,
    account?: IAccount,
  ) {
    return this.release(businessId, 'out_to_sale', dto, account);
  }

  /** The supplier swapped defective units for good ones: same product, same cost. */
  async exchange(
    businessId: string,
    dto: ExchangeDefectiveDto,
    account?: IAccount,
  ) {
    let supplier: {id: string; name: string} | null = null;
    if (dto.supplierId) {
      const [row] = await this.db
        .select({id: suppliers.id, name: suppliers.name})
        .from(suppliers)
        .where(
          and(
            eq(suppliers.businessId, businessId),
            eq(suppliers.id, dto.supplierId),
          ),
        )
        .limit(1);
      if (!row) throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);
      supplier = row;
    }
    return this.release(businessId, 'out_exchange', dto, account, supplier);
  }

  /**
   * Defective stock → back to the supplier, off a receipt's debt. Works like a
   * supplier return (a supplier_returns row, source 'defective', valued at the
   * receipt line's price in its currency, returnedAmount and payment status
   * updated) except that only defective lots move — sellable stock and the
   * receipt's own lots are untouched. The value may not exceed what is still
   * owed: with no supplier credit anywhere, the excess would silently vanish.
   */
  async supplierReturn(
    businessId: string,
    dto: DefectiveSupplierReturnDto,
    account?: IAccount,
  ) {
    const lines = this.requireLines(dto.items);
    for (const l of lines) {
      assertReasonNote(l.reasonCode ?? dto.reasonCode, l.note ?? dto.note);
    }
    const [receipt] = await this.db
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.id, dto.receiptId),
          eq(goodsReceipts.businessId, businessId),
        ),
      )
      .limit(1);
    if (!receipt) throw new AppException(ErrorCode.RECEIPT_NOT_FOUND);
    if (receipt.status === 'draft') {
      throw new AppException(ErrorCode.RECEIPT_RECEIVE_BEFORE_RETURN);
    }
    // The receipt line's price (newest line when a product is listed twice).
    const receiptLines = await this.db
      .select({
        productId: goodsReceiptItems.productId,
        productName: goodsReceiptItems.productName,
        priceIn: goodsReceiptItems.priceIn,
      })
      .from(goodsReceiptItems)
      .where(eq(goodsReceiptItems.receiptId, receipt.id))
      .orderBy(desc(goodsReceiptItems.createdAt));
    const priceOf = new Map<string, {name: string; price: number}>();
    for (const r of receiptLines) {
      if (r.productId && !priceOf.has(r.productId)) {
        priceOf.set(r.productId, {
          name: r.productName,
          price: Number(r.priceIn),
        });
      }
    }
    for (const l of lines) {
      if (!priceOf.has(l.productId)) {
        throw new AppException(ErrorCode.RECEIPT_PRODUCT_NOT_ON_RECEIPT, {
          productId: l.productId,
        });
      }
    }
    const info = await this.productInfo(
      businessId,
      lines.map((l) => l.productId),
    );
    const cashier = await this.resolveCashier(account);
    const branchId = await this.resolveBranch(
      businessId,
      dto.branchId ?? receipt.branchId ?? undefined,
    );
    const currency = receipt.currency ?? 'UZS';
    const valued = lines.map((l) => {
      const p = priceOf.get(l.productId)!;
      return {
        ...l,
        name: p.name,
        price: p.price,
        value: round2(l.qty * p.price),
      };
    });
    const value = round2(valued.reduce((s, l) => s + l.value, 0));

    const movementId = generateId();
    const returnId = generateId();
    await this.db.transaction(async (tx) => {
      // The receipt row first — the order returns, un-receiving and payments
      // take it in — so the debt is checked against locked figures.
      const [locked] = await tx
        .select()
        .from(goodsReceipts)
        .where(
          and(
            eq(goodsReceipts.id, receipt.id),
            eq(goodsReceipts.businessId, businessId),
          ),
        )
        .for('update')
        .limit(1);
      const out: DefectiveMovementLine[] = [];
      let itemCount = 0;
      for (const l of valued) {
        const taken = await consumeDefectiveLotsTx(tx, {
          businessId,
          productId: l.productId,
          branchId,
          qty: l.qty,
          productName: l.name,
        });
        out.push({
          productId: l.productId,
          productName: l.name,
          quantity: l.qty,
          unitCost: taken.unitCost,
          costTotal: taken.costTotal,
          reasonCode: l.reasonCode ?? dto.reasonCode ?? null,
          note: l.note?.trim() || null,
        });
        itemCount += info.get(l.productId)?.quantityType === 'kg' ? 1 : l.qty;
      }
      // Stock first (the clearer error when both fail), then the debt; a
      // failure rolls the lots back with the transaction.
      const outstanding = outstandingOf(locked);
      if (outstanding <= 0) {
        throw new AppException(ErrorCode.DEFECTIVE_RECEIPT_NO_DEBT);
      }
      if (Math.round(value * 100) > Math.round(outstanding * 100)) {
        throw new AppException(ErrorCode.DEFECTIVE_RETURN_EXCEEDS_DEBT, {
          value: money(value),
          outstanding: money(outstanding),
          currency,
        });
      }

      await tx.insert(supplierReturns).values({
        id: returnId,
        businessId,
        receiptId: receipt.id,
        supplierId: receipt.supplierId,
        supplierName: receipt.supplierName,
        totalAmount: money(value),
        currency,
        itemCount,
        note: dto.note?.trim() || null,
        cashierId: cashier.id,
        cashierName: cashier.name,
        source: 'defective',
      });
      await tx.insert(supplierReturnItems).values(
        valued.map((l) => ({
          id: generateId(),
          returnId,
          businessId,
          productId: l.productId,
          productName: l.name,
          priceIn: money(l.price),
          quantity: l.qty,
          lineTotal: money(l.value),
          reasonCode: l.reasonCode ?? dto.reasonCode ?? null,
          note: l.note?.trim() || null,
        })),
      );
      const newReturned = Number(locked.returnedAmount) + value;
      await tx
        .update(goodsReceipts)
        .set({
          returnedAmount: money(newReturned),
          paymentStatus: paymentStatusOf(
            Number(locked.paidAmount) + newReturned,
            Number(locked.totalAmount),
          ),
          updatedAt: new Date(),
        })
        .where(eq(goodsReceipts.id, receipt.id));

      await insertDefectiveMovementTx(
        tx,
        {
          id: movementId,
          businessId,
          branchId,
          type: 'out_supplier',
          reasonCode: dto.reasonCode ?? null,
          note: dto.note?.trim() || null,
          receiptId: receipt.id,
          supplierReturnId: returnId,
          supplierId: receipt.supplierId,
          supplierName: receipt.supplierName,
          creditValue: value,
          currency,
          cashierId: cashier.id,
          cashierName: cashier.name,
        },
        out,
        itemCount,
      );
    });
    return this.getMovement(businessId, movementId);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** Out of defective stock onto the shelf: a fresh lot at the defective cost. */
  private async release(
    businessId: string,
    type: Extract<DefectiveMovementType, 'out_to_sale' | 'out_exchange'>,
    dto: ReleaseDefectiveDto,
    account?: IAccount,
    supplier: {id: string; name: string} | null = null,
  ) {
    const lines = this.requireLines(dto.items);
    await this.assertNoStockTake(businessId);
    const cashier = await this.resolveCashier(account);
    const branchId = await this.resolveBranch(businessId, dto.branchId);

    const movementId = generateId();
    await this.db.transaction(async (tx) => {
      const out: DefectiveMovementLine[] = [];
      let itemCount = 0;
      for (const line of lines) {
        const product = await this.lockProduct(tx, businessId, line.productId);
        const taken = await consumeDefectiveLotsTx(tx, {
          businessId,
          productId: product.id,
          branchId,
          qty: line.qty,
          productName: product.name,
        });
        await tx.insert(inventoryBatches).values({
          id: generateId(),
          businessId,
          productId: product.id,
          receiptItemId: null,
          branchId,
          priceIn: money(taken.unitCost),
          priceOut: product.priceOut,
          qtyReceived: line.qty,
          qtyRemaining: line.qty,
        });
        await applyBranchStockDelta(
          tx,
          businessId,
          product.id,
          branchId,
          line.qty,
        );
        out.push({
          productId: product.id,
          productName: product.name,
          quantity: line.qty,
          unitCost: taken.unitCost,
          costTotal: taken.costTotal,
        });
        itemCount += product.quantityType === 'kg' ? 1 : line.qty;
      }
      await insertDefectiveMovementTx(
        tx,
        {
          id: movementId,
          businessId,
          branchId,
          type,
          note: dto.note?.trim() || null,
          supplierId: supplier?.id ?? null,
          supplierName: supplier?.name ?? null,
          cashierId: cashier.id,
          cashierName: cashier.name,
        },
        out,
        itemCount,
      );
    });
    return this.getMovement(businessId, movementId);
  }

  private requireLines<T extends {qty: number}>(items: T[] | undefined): T[] {
    const lines = (items ?? []).filter((l) => l.qty > 0);
    if (!lines.length) throw new AppException(ErrorCode.DEFECTIVE_EMPTY);
    return lines;
  }

  /** Moves that touch sellable stock wait for a running count to finish. */
  private async assertNoStockTake(businessId: string) {
    if (await isStockTakeActive(this.cache, this.db, businessId)) {
      throw new AppException(ErrorCode.STOCK_TAKE_IN_PROGRESS);
    }
  }

  private async resolveBranch(businessId: string, branchId?: string) {
    if (branchId) {
      const [row] = await this.db
        .select({id: branches.id})
        .from(branches)
        .where(
          and(eq(branches.id, branchId), eq(branches.businessId, businessId)),
        )
        .limit(1);
      if (!row) throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
      return row.id;
    }
    const [def] = await this.db
      .select({id: branches.id})
      .from(branches)
      .where(
        and(eq(branches.businessId, businessId), eq(branches.isDefault, true)),
      )
      .limit(1);
    if (!def) throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
    return def.id;
  }

  private async lockProduct(tx: Tx, businessId: string, productId: string) {
    const [product] = await tx
      .select({
        id: products.id,
        name: products.name,
        priceIn: products.priceIn,
        priceOut: products.priceOut,
        quantityType: products.quantityType,
      })
      .from(products)
      .where(
        and(eq(products.businessId, businessId), eq(products.id, productId)),
      )
      .for('update')
      .limit(1);
    if (!product) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {productId});
    }
    return product;
  }

  private async productInfo(businessId: string, ids: string[]) {
    const rows = ids.length
      ? await this.db
          .select({
            id: products.id,
            name: products.name,
            quantityType: products.quantityType,
          })
          .from(products)
          .where(
            and(eq(products.businessId, businessId), inArray(products.id, ids)),
          )
      : [];
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async getMovement(businessId: string, id: string) {
    const [m] = await this.db
      .select()
      .from(defectiveMovements)
      .where(
        and(
          eq(defectiveMovements.businessId, businessId),
          eq(defectiveMovements.id, id),
        ),
      )
      .limit(1);
    const items = await this.db
      .select()
      .from(defectiveMovementItems)
      .where(eq(defectiveMovementItems.movementId, id));
    return {...m, items};
  }

  private async resolveCashier(
    account?: IAccount,
  ): Promise<{id: string | null; name: string | null}> {
    if (!account) return {id: null, name: null};
    if (account.type === 'staff') {
      const [row] = await this.db
        .select({name: staff.name})
        .from(staff)
        .where(eq(staff.id, account.id))
        .limit(1);
      return {id: account.id, name: row?.name ?? null};
    }
    const [row] = await this.db
      .select({name: businesses.name})
      .from(businesses)
      .where(eq(businesses.id, account.id))
      .limit(1);
    return {id: account.id, name: row?.name ?? null};
  }

  /**
   * The write-off expense, booked like a stock-take write-off (same category,
   * so P&L shows one "Hisobdan chiqarish" line). Guarded the same way: never
   * fails the write-off if the finance table is missing or mid-migration.
   */
  private async writeExpenseTx(
    tx: Tx,
    p: {
      businessId: string;
      amount: number;
      cashier: {id: string | null; name: string | null};
    },
  ) {
    if (p.amount <= 0) return;
    try {
      const reg = (await tx.execute(
        sql`SELECT to_regclass('public.financial_transactions') AS t`,
      )) as unknown;
      const regRows =
        (reg as {rows?: Array<{t: string | null}>}).rows ??
        (reg as Array<{t: string | null}>);
      if (!regRows?.[0]?.t) return;
      await tx.execute(sql`
        INSERT INTO financial_transactions
          (id, business_id, kind, source, is_cash, amount, currency,
           category_name, cashier_id, cashier_name, note, operation_date, created_at)
        VALUES
          (${generateId()}, ${p.businessId}, 'expense', 'stock_take', false,
           ${p.amount.toFixed(4)}, 'UZS', 'Hisobdan chiqarish',
           ${p.cashier.id}, ${p.cashier.name}, 'Yaroqsiz tovar hisobdan chiqarildi',
           now(), now())
      `);
    } catch (err) {
      this.logger.warn(
        `Skipped finance write for defective write-off (${(err as Error).message})`,
      );
    }
  }
}

function toIso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  // timestamp without time zone comes back as UTC wall-time text.
  return new Date(`${v.replace(' ', 'T')}Z`).toISOString();
}
