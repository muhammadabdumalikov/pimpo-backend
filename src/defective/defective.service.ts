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
  type GoodsReceipt,
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
  offReceiptPrices,
  priceInReceiptCurrency,
  productOfSupplier,
  supplierLinks,
  type OffReceiptPrice,
} from './supplier-attribution';
import {FinanceService} from '../finance/finance.service';
import {PermissionService} from '../permission/permission.service';
import {
  addCreditTx,
  creditBalanceTx,
  lockSupplierTx,
} from '../common/supplier-credit';
import {
  DefectiveSettlementDto,
  DefectiveSettlementLineDto,
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

/** A credit / cash line's price: in its own currency, `rate` → so'm. */
export interface CreditPrice {
  price: number;
  currency: string;
  rate: number;
  source: 'last_delivery' | 'card';
  from: string | null;
}

/** A return line with its price and value in the document's currency. */
interface ValuedLine {
  name: string;
  price: number;
  value: number;
}

/** Credit or cash lines of one currency: one supplier return document. */
interface MoneyReturn {
  settlement: 'credit' | 'cash';
  currency: string;
  /** cash: the account the money came into. */
  accountId: string | null;
  lines: (DefectiveSettlementLineDto & {
    name: string;
    /** What the system priced the line at. */
    computed: number;
    /** What goes on the document: the agreed amount, else computed. */
    value: number;
    /** The price's currency → so'm. */
    rate: number;
  })[];
}

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
  /** The unit price the return is valued at, in the receipt currency. */
  priceIn: number;
  currency: string;
  usdRate: number | null;
  /** Still owed on the receipt, in its currency. */
  outstanding: number;
  /** The receipt lists the product. False = off another receipt's debt (S14). */
  onReceipt: boolean;
  /**
   * Where priceIn comes from: this receipt's line, the supplier's last
   * delivery of the product, or the card's purchase price.
   */
  priceSource: 'receipt' | 'last_delivery' | 'card';
  /** last_delivery: when that delivery came in. */
  priceFrom: string | null;
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
 * takes its value off the chosen receipt's debt, like any supplier return,
 * or (S15–S20) leaves it as the supplier's credit or brings cash back.
 */
@Injectable()
export class DefectiveService {
  private readonly logger = new Logger(DefectiveService.name);

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly financeService: FinanceService,
    private readonly permissionService: PermissionService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** What is in defective stock now, per product and branch. */
  async list(
    businessId: string,
    q: {
      branchId?: string;
      productId?: string;
      search?: string;
      /** Products that belong to this supplier (supplier-attribution.ts). */
      supplierId?: string;
    } = {},
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
    if (q.supplierId) {
      where.push(
        productOfSupplier(defectiveLots.productId, businessId, q.supplierId),
      );
    }
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
      /**
       * Moves that concern this supplier: their own supplier is this one, or
       * they have none and carry one of this supplier's products.
       */
      supplierId?: string;
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
    if (q.supplierId) {
      // A move to another supplier is theirs, even for a product both deliver.
      where.push(
        or(
          eq(defectiveMovements.supplierId, q.supplierId),
          and(
            sql`${defectiveMovements.supplierId} IS NULL`,
            sql`EXISTS (SELECT 1 FROM ${defectiveMovementItems} WHERE ${defectiveMovementItems.movementId} = ${defectiveMovements.id} AND ${productOfSupplier(defectiveMovementItems.productId, businessId, q.supplierId)})`,
          ),
        )!,
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
   * Receipts a defective product can go back against, the first being the
   * suggestion. Receipts that list the product come first (newest first),
   * priced at their line. After them (S14), the other open receipts of the
   * suppliers the product belongs to (supplier-attribution.ts): the supplier
   * takes it back off whatever they are still owed, at their own last
   * delivery price for it, or the card's purchase price if they never
   * delivered it — converted to that receipt's currency.
   */
  async supplierCandidates(
    businessId: string,
    productIds: string[],
    /** Only this supplier's receipts (the drawer opened from their page). */
    supplierId?: string,
  ): Promise<{
    items: {
      productId: string;
      candidates: SupplierCandidate[];
      creditPrice: CreditPrice | null;
    }[];
  }> {
    const ids = [...new Set(productIds.filter(Boolean))].slice(0, 200);
    if (!ids.length) return {items: []};
    const openDebt = sql`${goodsReceipts.totalAmount} - ${goodsReceipts.paidAmount} - ${goodsReceipts.returnedAmount} > 0.004`;
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
          openDebt,
          ...(supplierId ? [eq(goodsReceipts.supplierId, supplierId)] : []),
        ),
      )
      .orderBy(
        desc(goodsReceipts.createdAt),
        desc(goodsReceiptItems.createdAt),
      );

    const byProduct = new Map<string, SupplierCandidate[]>();
    // Every open receipt that lists the product, capped list or not — so the
    // off-receipt pass below does not offer the same receipt twice.
    const listedOn = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.productId) continue;
      const listed = listedOn.get(r.productId) ?? new Set<string>();
      listed.add(r.receiptId);
      listedOn.set(r.productId, listed);
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
        onReceipt: true,
        priceSource: 'receipt',
        priceFrom: null,
      });
      byProduct.set(r.productId, list);
    }

    // Off-receipt: the product's own suppliers' other open receipts.
    const links = await supplierLinks(this.db, businessId, ids);
    const owners = new Set<string>();
    for (const set of links.values()) {
      for (const id of set) if (!supplierId || id === supplierId) owners.add(id);
    }
    let prices = new Map<string, OffReceiptPrice>();
    if (owners.size) {
      const [open, offPrices] = await Promise.all([
        this.db
          .select({
            receiptId: goodsReceipts.id,
            supplierId: goodsReceipts.supplierId,
            supplierName: goodsReceipts.supplierName,
            receivedAt: goodsReceipts.createdAt,
            currency: goodsReceipts.currency,
            usdRate: goodsReceipts.usdRate,
            totalAmount: goodsReceipts.totalAmount,
            paidAmount: goodsReceipts.paidAmount,
            returnedAmount: goodsReceipts.returnedAmount,
          })
          .from(goodsReceipts)
          .where(
            and(
              eq(goodsReceipts.businessId, businessId),
              ne(goodsReceipts.status, 'draft'),
              inArray(goodsReceipts.supplierId, [...owners]),
              openDebt,
            ),
          )
          .orderBy(desc(goodsReceipts.createdAt)),
        offReceiptPrices(this.db, businessId, [...owners], ids),
      ]);
      prices = offPrices;
      for (const productId of ids) {
        const mine = links.get(productId);
        if (!mine) continue;
        const list = byProduct.get(productId) ?? [];
        for (const r of open) {
          if (list.length >= CANDIDATES_PER_PRODUCT) break;
          if (!r.supplierId || !mine.has(r.supplierId)) continue;
          if (supplierId && r.supplierId !== supplierId) continue;
          if (listedOn.get(productId)?.has(r.receiptId)) continue;
          const ref = prices.get(`${r.supplierId}:${productId}`);
          if (!ref) continue;
          list.push({
            receiptId: r.receiptId,
            supplierId: r.supplierId,
            supplierName: r.supplierName,
            receivedAt: toIso(r.receivedAt),
            priceIn: priceInReceiptCurrency(ref, r),
            currency: r.currency,
            usdRate: r.usdRate === null ? null : Number(r.usdRate),
            outstanding: round2(
              Number(r.totalAmount) -
                Number(r.paidAmount) -
                Number(r.returnedAmount),
            ),
            onReceipt: false,
            priceSource: ref.source,
            priceFrom: ref.from ? toIso(ref.from) : null,
          });
        }
        byProduct.set(productId, list);
      }
    }
    return {
      items: ids.map((productId) => {
        // What a credit or cash line of it goes back at (S15–S20): only for
        // the drawer locked to one supplier, and only if it is theirs.
        const ref =
          supplierId && links.get(productId)?.has(supplierId)
            ? prices.get(`${supplierId}:${productId}`)
            : undefined;
        return {
          productId,
          candidates: byProduct.get(productId) ?? [],
          creditPrice: ref
            ? {
                price: ref.price,
                currency: ref.currency,
                rate: ref.rate,
                source: ref.source,
                from: ref.from ? toIso(ref.from) : null,
              }
            : null,
        };
      }),
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
   * owed: the excess would silently vanish (settle() puts it on a credit).
   *
   * The receipt need not list every product (S14): one of the supplier's own
   * products can go back off any of their receipts that still carry debt.
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
    const receipt = await this.loadReceipt(businessId, dto.receiptId);
    const info = await this.productInfo(
      businessId,
      lines.map((l) => l.productId),
    );
    const valued = await this.priceOnReceipt(businessId, receipt, lines, info);
    const cashier = await this.resolveCashier(account);
    const branchId = await this.resolveBranch(
      businessId,
      dto.branchId ?? receipt.branchId ?? undefined,
    );
    const movementId = await this.db.transaction((tx) =>
      this.debtReturnTx(tx, {
        businessId,
        receipt,
        branchId,
        lines: valued,
        reasonCode: dto.reasonCode ?? null,
        note: dto.note?.trim() || null,
        cashier,
        info,
      }),
    );
    return this.getMovement(businessId, movementId);
  }

  /**
   * "Agent keldi" (S15–S26): everything handed to one supplier at once, each
   * line its own way — off a receipt's debt, left with them as a credit,
   * handed back in cash, or swapped for good units. One transaction: either
   * every document is written or none is.
   *
   * Credit and cash lines are the supplier's own products (assigned or ever
   * delivered), priced like an off-receipt debt line — their last delivery,
   * else the card — in that price's currency, unless the line carries the
   * total agreed with the agent. One return document per receipt, per
   * credit currency and per cash currency.
   */
  async settle(
    businessId: string,
    dto: DefectiveSettlementDto,
    account?: IAccount,
  ) {
    const lines = this.requireLines(dto.items);
    for (const l of lines) {
      if (l.path !== 'exchange') {
        assertReasonNote(l.reasonCode ?? dto.reasonCode, l.note ?? dto.note);
      }
    }
    const [supplier] = await this.db
      .select({id: suppliers.id, name: suppliers.name})
      .from(suppliers)
      .where(
        and(
          eq(suppliers.businessId, businessId),
          eq(suppliers.id, dto.supplierId),
          eq(suppliers.isActive, true),
        ),
      )
      .limit(1);
    if (!supplier) throw new AppException(ErrorCode.SUPPLIER_NOT_FOUND);
    const info = await this.productInfo(
      businessId,
      lines.map((l) => l.productId),
    );
    for (const l of lines) {
      if (!info.has(l.productId)) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
          productId: l.productId,
        });
      }
    }
    const exchange = lines.filter((l) => l.path === 'exchange');
    if (exchange.length) await this.assertNoStockTake(businessId);
    const cashier = await this.resolveCashier(account);
    const branchId = await this.resolveBranch(businessId, dto.branchId);
    const docReason = dto.reasonCode ?? null;
    const docNote = dto.note?.trim() || null;

    // Off a receipt's debt: one document per receipt, the receipt this
    // supplier's own.
    const byReceipt = new Map<string, typeof lines>();
    for (const l of lines) {
      if (l.path !== 'debt') continue;
      const list = byReceipt.get(l.receiptId!) ?? [];
      list.push(l);
      byReceipt.set(l.receiptId!, list);
    }
    const debt: {
      receipt: GoodsReceipt;
      lines: (DefectiveSettlementLineDto & ValuedLine)[];
    }[] = [];
    for (const [receiptId, group] of byReceipt) {
      const receipt = await this.loadReceipt(businessId, receiptId);
      if (receipt.supplierId !== supplier.id) {
        throw new AppException(ErrorCode.DEFECTIVE_RECEIPT_OTHER_SUPPLIER);
      }
      debt.push({
        receipt,
        lines: await this.priceOnReceipt(businessId, receipt, group, info),
      });
    }

    // Credit / cash: one document per way and currency.
    const moneyLines = lines.filter(
      (l) => l.path === 'credit' || l.path === 'cash',
    );
    const money: MoneyReturn[] = [];
    if (moneyLines.length) {
      const ids = [...new Set(moneyLines.map((l) => l.productId))];
      const [links, prices] = await Promise.all([
        supplierLinks(this.db, businessId, ids),
        offReceiptPrices(this.db, businessId, [supplier.id], ids),
      ]);
      const groups = new Map<string, MoneyReturn>();
      for (const l of moneyLines) {
        const name = info.get(l.productId)!.name;
        if (!links.get(l.productId)?.has(supplier.id)) {
          throw new AppException(ErrorCode.DEFECTIVE_PRODUCT_NOT_FROM_SUPPLIER, {
            product: name,
          });
        }
        const ref = prices.get(`${supplier.id}:${l.productId}`);
        if (!ref) {
          throw new AppException(ErrorCode.DEFECTIVE_PRODUCT_NO_PRICE, {
            product: name,
          });
        }
        const settlement = l.path as 'credit' | 'cash';
        const key = `${settlement}:${ref.currency}`;
        const group = groups.get(key) ?? {
          settlement,
          currency: ref.currency,
          accountId: null,
          lines: [],
        };
        const computed = round2(l.qty * ref.price);
        group.lines.push({
          ...l,
          name,
          computed,
          value: l.amount !== undefined ? round2(l.amount) : computed,
          rate: ref.rate,
        });
        groups.set(key, group);
      }
      for (const g of groups.values()) {
        if (g.settlement === 'cash') {
          const acc = dto.cashAccounts?.find((a) => a.currency === g.currency);
          if (!acc) {
            throw new AppException(ErrorCode.DEFECTIVE_CASH_ACCOUNT_REQUIRED, {
              currency: g.currency,
            });
          }
          g.accountId = acc.accountId;
        }
        money.push(g);
      }
    }

    const movementIds = await this.db.transaction(async (tx) => {
      const ids: string[] = [];
      for (const d of debt) {
        ids.push(
          await this.debtReturnTx(tx, {
            businessId,
            receipt: d.receipt,
            branchId,
            lines: d.lines,
            reasonCode: docReason,
            note: docNote,
            cashier,
            info,
          }),
        );
      }
      for (const m of money) {
        ids.push(
          await this.moneyReturnTx(tx, {
            businessId,
            supplier,
            branchId,
            group: m,
            reasonCode: docReason,
            note: docNote,
            cashier,
            info,
          }),
        );
      }
      if (exchange.length) {
        ids.push(
          await this.releaseTx(tx, {
            businessId,
            type: 'out_exchange',
            branchId,
            lines: exchange,
            note: docNote,
            cashier,
            supplier,
          }),
        );
      }
      return ids;
    });
    return {
      movements: await Promise.all(
        movementIds.map((id) => this.getMovement(businessId, id)),
      ),
    };
  }

  /**
   * Undo a defective supplier return (S23): the goods go back into defective
   * stock at the cost they left at, and the settlement is reversed — the
   * receipt's debt comes back, the credit is taken off (refused when it has
   * already been spent), or the cash kirim is stornoed in Moliya. Nothing is
   * deleted: the return and its movement are marked cancelled, and every
   * report skips them. A cash return also needs receipt:unpay (S24).
   */
  async cancelSupplierReturn(
    businessId: string,
    returnId: string,
    account?: IAccount,
  ) {
    const [head] = await this.db
      .select({settlement: supplierReturns.settlement})
      .from(supplierReturns)
      .where(
        and(
          eq(supplierReturns.id, returnId),
          eq(supplierReturns.businessId, businessId),
          eq(supplierReturns.source, 'defective'),
        ),
      )
      .limit(1);
    if (!head) throw new AppException(ErrorCode.DEFECTIVE_RETURN_NOT_FOUND);
    if (head.settlement === 'cash' && account) {
      await this.permissionService.assert(account, 'receipt:unpay');
    }
    const cashier = await this.resolveCashier(account);

    const movementId = await this.db.transaction(async (tx) => {
      const [ret] = await tx
        .select()
        .from(supplierReturns)
        .where(eq(supplierReturns.id, returnId))
        .for('update')
        .limit(1);
      if (ret.cancelledAt) {
        throw new AppException(ErrorCode.DEFECTIVE_RETURN_ALREADY_CANCELLED);
      }
      const [movement] = await tx
        .select()
        .from(defectiveMovements)
        .where(
          and(
            eq(defectiveMovements.businessId, businessId),
            eq(defectiveMovements.supplierReturnId, ret.id),
          ),
        )
        .for('update')
        .limit(1);
      const total = Number(ret.totalAmount);

      if (ret.settlement === 'credit') {
        if (ret.supplierId) {
          await lockSupplierTx(tx, businessId, ret.supplierId);
          const available = await creditBalanceTx(
            tx,
            businessId,
            ret.supplierId,
            ret.currency,
          );
          if (Math.round(available * 100) < Math.round(total * 100)) {
            throw new AppException(ErrorCode.DEFECTIVE_CREDIT_ALREADY_USED, {
              amount: money(total),
              available: money(Math.max(0, available)),
              currency: ret.currency,
            });
          }
          await addCreditTx(tx, {
            businessId,
            supplierId: ret.supplierId,
            currency: ret.currency,
            amount: -total,
            kind: 'return_cancel',
            supplierReturnId: ret.id,
            cashierId: cashier.id,
            cashierName: cashier.name,
          });
        }
      } else if (ret.settlement === 'cash') {
        if (ret.financeTxId) {
          await this.financeService.reverseTx(
            tx,
            businessId,
            ret.financeTxId,
            cashier,
          );
        }
      } else if (ret.receiptId) {
        const [locked] = await tx
          .select()
          .from(goodsReceipts)
          .where(
            and(
              eq(goodsReceipts.id, ret.receiptId),
              eq(goodsReceipts.businessId, businessId),
            ),
          )
          .for('update')
          .limit(1);
        if (locked) {
          const newReturned = Math.max(
            0,
            round2(Number(locked.returnedAmount) - total),
          );
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
            .where(eq(goodsReceipts.id, locked.id));
        }
      }

      // The goods come back at the cost they left at. The lots they came out
      // of are not rebuilt — one fresh lot per line, marked as a cancelled
      // return, in the branch they left.
      if (movement) {
        const items = await tx
          .select()
          .from(defectiveMovementItems)
          .where(eq(defectiveMovementItems.movementId, movement.id));
        for (const it of items) {
          if (!it.productId || !(it.quantity > 0)) continue;
          await addDefectiveLotTx(tx, {
            businessId,
            productId: it.productId,
            branchId: movement.branchId,
            qty: it.quantity,
            unitCost: Number(it.unitCost),
            source: 'supplier_cancel',
            movementId: movement.id,
          });
        }
        await tx
          .update(defectiveMovements)
          .set({cancelledAt: new Date()})
          .where(eq(defectiveMovements.id, movement.id));
      }
      await tx
        .update(supplierReturns)
        .set({cancelledAt: new Date(), cancelledByName: cashier.name})
        .where(eq(supplierReturns.id, ret.id));
      return movement?.id ?? null;
    });
    return movementId ? this.getMovement(businessId, movementId) : {id: null};
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async loadReceipt(
    businessId: string,
    receiptId: string,
  ): Promise<GoodsReceipt> {
    const [receipt] = await this.db
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
    return receipt;
  }

  /**
   * Price return lines off one receipt, in its currency: the receipt's own
   * line (newest when listed twice), else (S14) the supplier's last delivery
   * of the product or its card price — provided the product is theirs.
   */
  private async priceOnReceipt<
    L extends {
      productId: string;
      qty: number;
      reasonCode?: string | null;
      note?: string | null;
    },
  >(
    businessId: string,
    receipt: GoodsReceipt,
    lines: L[],
    info: Map<string, {id: string; name: string; quantityType: string | null}>,
  ): Promise<(L & ValuedLine)[]> {
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
    // A product the receipt does not list (S14): the supplier takes it back
    // off this receipt's debt all the same, provided it is theirs — priced at
    // their last delivery of it, else the card's purchase price.
    const missing = [
      ...new Set(
        lines.map((l) => l.productId).filter((id) => !priceOf.has(id)),
      ),
    ];
    if (missing.length) {
      if (!receipt.supplierId) {
        throw new AppException(ErrorCode.RECEIPT_PRODUCT_NOT_ON_RECEIPT, {
          productId: missing[0],
        });
      }
      const [links, prices] = await Promise.all([
        supplierLinks(this.db, businessId, missing),
        offReceiptPrices(this.db, businessId, [receipt.supplierId], missing),
      ]);
      for (const productId of missing) {
        const name = info.get(productId)?.name;
        if (!name) {
          throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
            productId,
          });
        }
        if (!links.get(productId)?.has(receipt.supplierId)) {
          throw new AppException(
            ErrorCode.DEFECTIVE_PRODUCT_NOT_FROM_SUPPLIER,
            {product: name},
          );
        }
        const ref = prices.get(`${receipt.supplierId}:${productId}`);
        if (!ref) {
          throw new AppException(ErrorCode.DEFECTIVE_PRODUCT_NO_PRICE, {
            product: name,
          });
        }
        priceOf.set(productId, {
          name,
          price: priceInReceiptCurrency(ref, receipt),
        });
      }
    }
    return lines.map((l) => {
      const p = priceOf.get(l.productId)!;
      return {
        ...l,
        name: p.name,
        price: p.price,
        value: round2(l.qty * p.price),
      };
    });
  }

  /** One debt return inside `tx`; returns the movement id. */
  private async debtReturnTx(
    tx: Tx,
    p: {
      businessId: string;
      receipt: GoodsReceipt;
      branchId: string;
      lines: (ValuedLine & {
        productId: string;
        qty: number;
        reasonCode?: string | null;
        note?: string | null;
      })[];
      reasonCode: string | null;
      note: string | null;
      cashier: {id: string | null; name: string | null};
      info: Map<string, {quantityType: string | null}>;
    },
  ): Promise<string> {
    const {businessId, receipt, branchId, cashier} = p;
    const currency = receipt.currency ?? 'UZS';
    const value = round2(p.lines.reduce((s, l) => s + l.value, 0));
    const movementId = generateId();
    const returnId = generateId();
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
    const {out, itemCount} = await this.takeLines(tx, businessId, branchId, p);
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
      note: p.note,
      cashierId: cashier.id,
      cashierName: cashier.name,
      source: 'defective',
      settlement: 'debt',
      branchId,
    });
    await tx.insert(supplierReturnItems).values(
      p.lines.map((l) => ({
        id: generateId(),
        returnId,
        businessId,
        productId: l.productId,
        productName: l.name,
        priceIn: money(l.price),
        quantity: l.qty,
        lineTotal: money(l.value),
        reasonCode: l.reasonCode ?? p.reasonCode,
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
        reasonCode: p.reasonCode,
        note: p.note,
        receiptId: receipt.id,
        supplierReturnId: returnId,
        supplierId: receipt.supplierId,
        supplierName: receipt.supplierName,
        creditValue: value,
        currency,
        settlement: 'debt',
        cashierId: cashier.id,
        cashierName: cashier.name,
      },
      out,
      itemCount,
    );
    return movementId;
  }

  /**
   * One credit or cash return inside `tx` (S15–S20); returns the movement id.
   * The goods leave defective stock; a credit lands on the supplier's credit
   * ledger, cash as a Moliya kirim on the chosen account.
   */
  private async moneyReturnTx(
    tx: Tx,
    p: {
      businessId: string;
      supplier: {id: string; name: string};
      branchId: string;
      group: MoneyReturn;
      reasonCode: string | null;
      note: string | null;
      cashier: {id: string | null; name: string | null};
      info: Map<string, {quantityType: string | null}>;
    },
  ): Promise<string> {
    const {businessId, supplier, branchId, group, cashier} = p;
    const movementId = generateId();
    const returnId = generateId();
    const {out, itemCount} = await this.takeLines(tx, businessId, branchId, {
      lines: group.lines,
      reasonCode: p.reasonCode,
      info: p.info,
    });
    const total = round2(group.lines.reduce((s, l) => s + l.value, 0));
    const computed = round2(group.lines.reduce((s, l) => s + l.computed, 0));
    // The rate a USD credit is worth in so'm: each line's own delivery rate,
    // weighted by its computed value.
    const usdRate =
      group.currency === 'USD' && computed > 0
        ? group.lines.reduce((s, l) => s + l.computed * l.rate, 0) / computed
        : null;

    let financeTxId: string | null = null;
    if (group.settlement === 'cash') {
      const txn = await this.financeService.recordIncomeTx(tx, businessId, {
        accountId: group.accountId!,
        source: 'supplier_refund',
        amount: total,
        currency: group.currency,
        categoryName: "Yetkazib beruvchidan qaytgan pul",
        note: `Yaroqsiz tovar uchun qaytgan pul: ${supplier.name}`,
        cashierId: cashier.id,
        cashierName: cashier.name,
      });
      financeTxId = txn.id;
    }

    await tx.insert(supplierReturns).values({
      id: returnId,
      businessId,
      receiptId: null,
      supplierId: supplier.id,
      supplierName: supplier.name,
      totalAmount: money(total),
      currency: group.currency,
      itemCount,
      note: p.note,
      cashierId: cashier.id,
      cashierName: cashier.name,
      source: 'defective',
      settlement: group.settlement,
      computedTotal:
        Math.round(computed * 100) !== Math.round(total * 100)
          ? money(computed)
          : null,
      usdRate: usdRate === null ? null : usdRate.toFixed(4),
      branchId,
      financeTxId,
    });
    await tx.insert(supplierReturnItems).values(
      group.lines.map((l) => ({
        id: generateId(),
        returnId,
        businessId,
        productId: l.productId,
        productName: l.name,
        priceIn: money(l.qty > 0 ? l.value / l.qty : 0),
        quantity: l.qty,
        lineTotal: money(l.value),
        reasonCode: l.reasonCode ?? p.reasonCode,
        note: l.note?.trim() || null,
      })),
    );
    if (group.settlement === 'credit') {
      await lockSupplierTx(tx, businessId, supplier.id);
      await addCreditTx(tx, {
        businessId,
        supplierId: supplier.id,
        currency: group.currency,
        amount: total,
        kind: 'return',
        supplierReturnId: returnId,
        note: p.note,
        cashierId: cashier.id,
        cashierName: cashier.name,
      });
    }
    await insertDefectiveMovementTx(
      tx,
      {
        id: movementId,
        businessId,
        branchId,
        type: 'out_supplier',
        reasonCode: p.reasonCode,
        note: p.note,
        supplierReturnId: returnId,
        supplierId: supplier.id,
        supplierName: supplier.name,
        creditValue: total,
        currency: group.currency,
        settlement: group.settlement,
        cashierId: cashier.id,
        cashierName: cashier.name,
      },
      out,
      itemCount,
    );
    return movementId;
  }

  /** Take return lines out of a branch's defective stock, oldest lot first. */
  private async takeLines(
    tx: Tx,
    businessId: string,
    branchId: string,
    p: {
      lines: {
        productId: string;
        qty: number;
        name: string;
        reasonCode?: string | null;
        note?: string | null;
      }[];
      reasonCode: string | null;
      info: Map<string, {quantityType: string | null}>;
    },
  ): Promise<{out: DefectiveMovementLine[]; itemCount: number}> {
    const out: DefectiveMovementLine[] = [];
    let itemCount = 0;
    for (const l of p.lines) {
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
        reasonCode: l.reasonCode ?? p.reasonCode,
        note: l.note?.trim() || null,
      });
      itemCount += p.info.get(l.productId)?.quantityType === 'kg' ? 1 : l.qty;
    }
    return {out, itemCount};
  }

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
    const movementId = await this.db.transaction((tx) =>
      this.releaseTx(tx, {
        businessId,
        type,
        branchId,
        lines,
        note: dto.note?.trim() || null,
        cashier,
        supplier,
      }),
    );
    return this.getMovement(businessId, movementId);
  }

  private async releaseTx(
    tx: Tx,
    p: {
      businessId: string;
      type: Extract<DefectiveMovementType, 'out_to_sale' | 'out_exchange'>;
      branchId: string;
      lines: {productId: string; qty: number}[];
      note: string | null;
      cashier: {id: string | null; name: string | null};
      supplier: {id: string; name: string} | null;
    },
  ): Promise<string> {
    const {businessId, branchId} = p;
    const movementId = generateId();
    const out: DefectiveMovementLine[] = [];
    let itemCount = 0;
    for (const line of p.lines) {
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
      await applyBranchStockDelta(tx, businessId, product.id, branchId, line.qty);
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
        type: p.type,
        note: p.note,
        supplierId: p.supplier?.id ?? null,
        supplierName: p.supplier?.name ?? null,
        cashierId: p.cashier.id,
        cashierName: p.cashier.name,
      },
      out,
      itemCount,
    );
    return movementId;
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
