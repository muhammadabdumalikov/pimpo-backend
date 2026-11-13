import {Inject, Injectable} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {and, asc, desc, eq, inArray, sql, type SQL} from 'drizzle-orm';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {isStockTakeActive} from '../common/stock-take-lock';
import {applyBranchStockDelta, trimLotsToStockTx} from '../common/branch-stock';
import {DatabaseService} from '../database/database.service';
import {
  branchStock,
  branches,
  businesses,
  financialCategories,
  financialTransactions,
  inventoryBatches,
  openingStockItems,
  openingStocks,
  products,
  staff,
  stockTransfers,
  type OpeningStock,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {IAccount} from '../business/types';
import {StockTransferService} from '../stock-transfer/stock-transfer.service';
import {
  CreateOpeningStockDto,
  UpsertOpeningStockItemsDto,
} from './dto/opening-stock.dto';

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

// Capital income category the value of undocumented opening stock is booked
// under (FILIAL-ASSORTIMENT.md Q4): goods the owner brought in, not profit.
const OPENING_STOCK_CATEGORY_NAME = "Boshlang'ich tovar qoldig'i";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface OpeningStockLine {
  id: string;
  productId: string;
  productName: string;
  barcode: string | null;
  code: string | null;
  quantityType: string | null;
  quantity: number;
  /** Typed override; null = the card's priceIn. */
  unitCost: string | null;
  cardPriceIn: number;
  effectiveCost: number;
  lineValue: number;
  /** Source-branch on-hand, 'transfer' documents only. */
  available: number | null;
  short: boolean;
}

export type OpeningStockDetail = OpeningStock & {items: OpeningStockLine[]};

@Injectable()
export class OpeningStockService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly transferService: StockTransferService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  private get db() {
    return this.dbService.db;
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

  // ─── List / detail ──────────────────────────────────────────────────────────

  async list(
    businessId: string,
    opts: {branchId?: string; status?: string; page?: number; limit?: number},
  ): Promise<{items: OpeningStock[]; total: number}> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const where: SQL[] = [eq(openingStocks.businessId, businessId)];
    if (opts.branchId) where.push(eq(openingStocks.branchId, opts.branchId));
    if (opts.status) where.push(eq(openingStocks.status, opts.status));

    const items = await this.db
      .select()
      .from(openingStocks)
      .where(and(...where))
      .orderBy(desc(openingStocks.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);
    const [{value: total}] = await this.db
      .select({value: sql<number>`count(*)::int`})
      .from(openingStocks)
      .where(and(...where));
    return {items, total};
  }

  async getOne(businessId: string, id: string): Promise<OpeningStockDetail> {
    const doc = await this.requireDoc(businessId, id);
    const rows = await this.db
      .select({
        id: openingStockItems.id,
        productId: openingStockItems.productId,
        productName: openingStockItems.productName,
        quantity: openingStockItems.quantity,
        unitCost: openingStockItems.unitCost,
        barcode: products.barcode,
        code: products.code,
        quantityType: products.quantityType,
        cardPriceIn: products.priceIn,
        available: branchStock.quantity,
      })
      .from(openingStockItems)
      .innerJoin(products, eq(products.id, openingStockItems.productId))
      .leftJoin(
        branchStock,
        and(
          eq(branchStock.productId, openingStockItems.productId),
          // No source branch → match nothing; `available` stays null.
          doc.fromBranchId
            ? eq(branchStock.branchId, doc.fromBranchId)
            : sql`false`,
        ),
      )
      .where(eq(openingStockItems.openingStockId, id))
      .orderBy(asc(openingStockItems.createdAt));

    const isTransfer = doc.source === 'transfer';
    const items: OpeningStockLine[] = rows.map((r) => {
      const cardPriceIn = Number(r.cardPriceIn ?? 0);
      const effectiveCost =
        r.unitCost !== null ? Number(r.unitCost) : cardPriceIn;
      const available = isTransfer ? Number(r.available ?? 0) : null;
      return {
        id: r.id,
        productId: r.productId,
        productName: r.productName,
        barcode: r.barcode,
        code: r.code,
        quantityType: r.quantityType,
        quantity: r.quantity,
        unitCost: r.unitCost,
        cardPriceIn,
        effectiveCost,
        lineValue: round2(r.quantity * effectiveCost),
        available,
        short: available !== null && r.quantity > available,
      };
    });
    return {...doc, items};
  }

  // ─── Create draft ───────────────────────────────────────────────────────────

  async create(
    businessId: string,
    dto: CreateOpeningStockDto,
    account?: IAccount,
  ): Promise<OpeningStockDetail> {
    const isTransfer = dto.source === 'transfer';
    if (
      isTransfer &&
      (!dto.fromBranchId || dto.fromBranchId === dto.branchId)
    ) {
      throw new AppException(ErrorCode.OPENING_STOCK_SOURCE_INVALID);
    }
    const wanted = isTransfer
      ? [dto.branchId, dto.fromBranchId!]
      : [dto.branchId];
    const found = await this.db
      .select({id: branches.id, name: branches.name})
      .from(branches)
      .where(
        and(
          eq(branches.businessId, businessId),
          eq(branches.isActive, true),
          inArray(branches.id, wanted),
        ),
      );
    const target = found.find((b) => b.id === dto.branchId);
    const from = isTransfer
      ? found.find((b) => b.id === dto.fromBranchId)
      : undefined;
    if (!target || (isTransfer && !from)) {
      throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
    }

    const cashier = await this.resolveCashier(account);
    const id = generateId();
    await this.db.insert(openingStocks).values({
      id,
      businessId,
      branchId: target.id,
      branchName: target.name,
      source: dto.source,
      fromBranchId: from?.id ?? null,
      fromBranchName: from?.name ?? null,
      status: 'draft',
      createdByCashierId: cashier.id,
      createdByCashierName: cashier.name,
      note: dto.note?.trim() || null,
    });
    return this.getOne(businessId, id);
  }

  // ─── Upsert counted lines ───────────────────────────────────────────────────

  async upsertItems(
    businessId: string,
    id: string,
    dto: UpsertOpeningStockItemsDto,
  ): Promise<OpeningStockDetail> {
    // Last write per product wins, so a batched autosave can't fight itself.
    const byProduct = new Map<
      string,
      {quantity: number; unitCost?: number | null}
    >();
    for (const line of dto.items ?? []) {
      byProduct.set(line.productId, {
        quantity: round3(line.quantity),
        unitCost: line.unitCost,
      });
    }

    await this.db.transaction(async (tx) => {
      const doc = await this.lockDraft(tx, businessId, id);
      if (byProduct.size === 0) return;

      const productIds = [...byProduct.keys()];
      const known = await tx
        .select({id: products.id, name: products.name})
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            inArray(products.id, productIds),
          ),
        );
      const nameById = new Map(known.map((p) => [p.id, p.name]));
      const missing = productIds.find((pid) => !nameById.has(pid));
      if (missing) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
          productId: missing,
        });
      }

      const removed = productIds.filter(
        (pid) => byProduct.get(pid)!.quantity <= 0,
      );
      if (removed.length) {
        await tx
          .delete(openingStockItems)
          .where(
            and(
              eq(openingStockItems.openingStockId, doc.id),
              inArray(openingStockItems.productId, removed),
            ),
          );
      }

      const now = new Date();
      for (const pid of productIds) {
        const line = byProduct.get(pid)!;
        if (line.quantity <= 0) continue;
        // A transfer moves lots at their own cost; a typed cost means nothing.
        const unitCost =
          doc.source === 'transfer' || line.unitCost == null
            ? null
            : line.unitCost.toFixed(2);
        await tx
          .insert(openingStockItems)
          .values({
            id: generateId(),
            openingStockId: doc.id,
            businessId,
            productId: pid,
            productName: nameById.get(pid)!,
            quantity: line.quantity,
            unitCost,
          })
          .onConflictDoUpdate({
            target: [
              openingStockItems.openingStockId,
              openingStockItems.productId,
            ],
            set: {
              quantity: line.quantity,
              // Only touch the cost when the client sent the field.
              ...(line.unitCost !== undefined ? {unitCost} : {}),
              updatedAt: now,
            },
          });
      }

      await this.refreshTotals(tx, doc.id);
    });
    return this.getOne(businessId, id);
  }

  // ─── Complete ───────────────────────────────────────────────────────────────

  async complete(
    businessId: string,
    id: string,
    account?: IAccount,
  ): Promise<OpeningStockDetail> {
    // A full count snapshots book quantities; adding stock under it would
    // desync the snapshot (same rule as receipts and transfers).
    if (await isStockTakeActive(this.cache, this.db, businessId)) {
      throw new AppException(ErrorCode.STOCK_TAKE_IN_PROGRESS);
    }
    const cashier = await this.resolveCashier(account);

    await this.db.transaction(async (tx) => {
      const doc = await this.lockDraft(tx, businessId, id);
      const lines = await tx
        .select({
          productId: openingStockItems.productId,
          productName: openingStockItems.productName,
          quantity: openingStockItems.quantity,
          unitCost: openingStockItems.unitCost,
          cardPriceIn: products.priceIn,
          priceOut: products.priceOut,
        })
        .from(openingStockItems)
        .innerJoin(products, eq(products.id, openingStockItems.productId))
        .where(eq(openingStockItems.openingStockId, doc.id))
        .orderBy(asc(openingStockItems.createdAt));
      if (lines.length === 0) {
        throw new AppException(ErrorCode.OPENING_STOCK_EMPTY);
      }

      if (doc.source === 'transfer') {
        await this.completeAsTransfer(tx, businessId, doc, lines, cashier);
      } else {
        await this.completeUndocumented(tx, businessId, doc, lines, cashier);
      }
    });
    return this.getOne(businessId, id);
  }

  private async completeAsTransfer(
    tx: Tx,
    businessId: string,
    doc: OpeningStock,
    lines: Array<{productId: string; quantity: number}>,
    cashier: {id: string | null; name: string | null},
  ): Promise<void> {
    const dto = {
      fromBranchId: doc.fromBranchId!,
      toBranchId: doc.branchId,
      items: lines.map((l) => ({productId: l.productId, quantity: l.quantity})),
      note: doc.note ?? "Boshlang'ich qoldiq",
    };
    const qtyByProduct = this.transferService.dedupeLines(dto);
    // Shortfalls throw TRANSFER_EXCEEDS_STOCK and roll the whole thing back.
    const transferId = await this.transferService.createInTx(
      tx,
      businessId,
      dto,
      qtyByProduct,
      cashier,
    );
    const [transfer] = await tx
      .select({totalValue: stockTransfers.totalValue})
      .from(stockTransfers)
      .where(eq(stockTransfers.id, transferId))
      .limit(1);

    await tx
      .update(openingStocks)
      .set({
        status: 'completed',
        transferId,
        totalValue: Number(transfer?.totalValue ?? 0).toFixed(2),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(openingStocks.id, doc.id));
  }

  private async completeUndocumented(
    tx: Tx,
    businessId: string,
    doc: OpeningStock,
    lines: Array<{
      productId: string;
      productName: string;
      quantity: number;
      unitCost: string | null;
      cardPriceIn: string;
      priceOut: string;
    }>,
    cashier: {id: string | null; name: string | null},
  ): Promise<void> {
    const costed = lines.map((l) => ({
      ...l,
      cost:
        l.unitCost !== null ? Number(l.unitCost) : Number(l.cardPriceIn ?? 0),
    }));
    // A 0-cost lot would make every later sale of it look like pure profit.
    const uncosted = costed.filter((l) => !(l.cost > 0));
    if (uncosted.length) {
      throw new AppException(ErrorCode.OPENING_STOCK_COST_MISSING, {
        names: uncosted
          .slice(0, 5)
          .map((l) => l.productName)
          .join(', '),
      });
    }

    let totalValue = 0;
    for (const l of costed) {
      // Lock the card: a concurrent sale/receipt must see the new lot whole.
      await tx
        .select({id: products.id})
        .from(products)
        .where(eq(products.id, l.productId))
        .for('update');
      await tx.insert(inventoryBatches).values({
        id: generateId(),
        businessId,
        productId: l.productId,
        branchId: doc.branchId,
        priceIn: l.cost.toFixed(2),
        priceOut: Number(l.priceOut).toFixed(2),
        qtyReceived: l.quantity,
        qtyRemaining: l.quantity,
      });
      await applyBranchStockDelta(
        tx,
        businessId,
        l.productId,
        doc.branchId,
        l.quantity,
      );
      // Stock that was below zero (oversold) absorbs part of this lot.
      await trimLotsToStockTx(tx, businessId, l.productId, doc.branchId);
      // A card with no purchase price takes the counted one (Q12); a card
      // that has one keeps it — the card price is the source of truth.
      if (!(Number(l.cardPriceIn) > 0)) {
        await tx
          .update(products)
          .set({priceIn: l.cost.toFixed(2), updatedAt: new Date()})
          .where(eq(products.id, l.productId));
      }
      totalValue = round2(totalValue + l.quantity * l.cost);
    }

    await this.bookCapital(tx, businessId, doc, totalValue, cashier);

    await tx
      .update(openingStocks)
      .set({
        status: 'completed',
        totalValue: totalValue.toFixed(2),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(openingStocks.id, doc.id));
  }

  /**
   * One capital kirim for the value added: not cash (no account moves) and not
   * P&L (the category is capital) — the owner put goods into the business.
   */
  private async bookCapital(
    tx: Tx,
    businessId: string,
    doc: OpeningStock,
    amount: number,
    cashier: {id: string | null; name: string | null},
  ): Promise<void> {
    if (!(amount > 0)) return;
    let [category] = await tx
      .select({
        id: financialCategories.id,
        isCapital: financialCategories.isCapital,
      })
      .from(financialCategories)
      .where(
        and(
          eq(financialCategories.businessId, businessId),
          eq(financialCategories.name, OPENING_STOCK_CATEGORY_NAME),
          eq(financialCategories.kind, 'income'),
        ),
      )
      .limit(1);
    if (!category) {
      [category] = await tx
        .insert(financialCategories)
        .values({
          id: generateId(),
          businessId,
          name: OPENING_STOCK_CATEGORY_NAME,
          kind: 'income',
          isCapital: true,
        })
        .returning({
          id: financialCategories.id,
          isCapital: financialCategories.isCapital,
        });
    }
    await tx.insert(financialTransactions).values({
      id: generateId(),
      businessId,
      kind: 'income',
      source: 'opening_stock',
      isCash: false,
      amount: amount.toFixed(4),
      currency: 'UZS',
      categoryId: category.id,
      categoryName: OPENING_STOCK_CATEGORY_NAME,
      cashierId: cashier.id,
      cashierName: cashier.name,
      note: `Boshlang'ich qoldiq: ${doc.branchName ?? ''}`.trim(),
      operationDate: new Date(),
    });
  }

  // ─── Cancel ─────────────────────────────────────────────────────────────────

  async cancel(businessId: string, id: string): Promise<OpeningStockDetail> {
    await this.db.transaction(async (tx) => {
      const doc = await this.lockDraft(tx, businessId, id);
      await tx
        .update(openingStocks)
        .set({status: 'cancelled', updatedAt: new Date()})
        .where(eq(openingStocks.id, doc.id));
    });
    return this.getOne(businessId, id);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async requireDoc(
    businessId: string,
    id: string,
  ): Promise<OpeningStock> {
    const [doc] = await this.db
      .select()
      .from(openingStocks)
      .where(
        and(eq(openingStocks.businessId, businessId), eq(openingStocks.id, id)),
      )
      .limit(1);
    if (!doc) throw new AppException(ErrorCode.OPENING_STOCK_NOT_FOUND);
    return doc;
  }

  /** Lock the document row and require it to still be a draft. */
  private async lockDraft(
    tx: Tx,
    businessId: string,
    id: string,
  ): Promise<OpeningStock> {
    const [doc] = await tx
      .select()
      .from(openingStocks)
      .where(
        and(eq(openingStocks.businessId, businessId), eq(openingStocks.id, id)),
      )
      .for('update');
    if (!doc) throw new AppException(ErrorCode.OPENING_STOCK_NOT_FOUND);
    if (doc.status !== 'draft') {
      throw new AppException(ErrorCode.OPENING_STOCK_NOT_DRAFT);
    }
    return doc;
  }

  /**
   * Draft totals. The value is an estimate at the typed cost, else the card's
   * priceIn (what the document header shows); completion overwrites it with
   * the booked value (a transfer's comes from the moved lots).
   */
  private async refreshTotals(tx: Tx, id: string): Promise<void> {
    await tx.execute(sql`
      UPDATE opening_stocks o
         SET item_count = s.n,
             total_qty = s.q,
             total_value = s.v,
             updated_at = now()
        FROM (SELECT count(*)::int AS n,
                     COALESCE(ROUND(SUM(i.quantity)::numeric, 3), 0) AS q,
                     COALESCE(ROUND(SUM(i.quantity::numeric * COALESCE(i.unit_cost, p.price_in)), 2), 0) AS v
                FROM opening_stock_items i
                JOIN products p ON p.id = i.product_id
               WHERE i.opening_stock_id = ${id}) s
       WHERE o.id = ${id}
    `);
  }
}
