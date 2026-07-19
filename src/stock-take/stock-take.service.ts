import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import {
  setStockTakeActive,
  clearStockTakeActive,
} from '../common/stock-take-lock';
import {and, asc, desc, eq, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  stockTakes,
  stockTakeItems,
  products,
  inventoryBatches,
  staff,
  businesses,
  type StockTake,
  type StockTakeItem,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {consumeBatches} from '../order/costing';
import {IAccount} from '../business/types';
import {CreateStockTakeDto} from './dto/create-stock-take.dto';
import {CountItemsDto} from './dto/count-items.dto';
import {CompleteStockTakeDto} from './dto/complete-stock-take.dto';

// The transaction handle type, same one db.transaction hands its callback.
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

@Injectable()
export class StockTakeService {
  private readonly logger = new Logger(StockTakeService.name);

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ─── Acting cashier (owner or staff) — mirrors ShiftService ────────────────
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

  // ─── List ──────────────────────────────────────────────────────────────────
  async list(
    businessId: string,
    opts: {page?: number; limit?: number} = {},
  ): Promise<{items: StockTake[]; total: number}> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const offset = (page - 1) * limit;

    const rows = await this.dbService.db
      .select()
      .from(stockTakes)
      .where(eq(stockTakes.businessId, businessId))
      .orderBy(desc(stockTakes.createdAt))
      .limit(limit)
      .offset(offset);

    const [{value: total}] = await this.dbService.db
      .select({value: sql<number>`count(*)::int`})
      .from(stockTakes)
      .where(eq(stockTakes.businessId, businessId));

    return {items: rows, total};
  }

  // ─── Detail (with counted rows) ─────────────────────────────────────────────
  async getOne(
    businessId: string,
    id: string,
  ): Promise<StockTake & {items: StockTakeItem[]}> {
    const stockTake = await this.requireStockTake(businessId, id);
    const items = await this.dbService.db
      .select()
      .from(stockTakeItems)
      .where(eq(stockTakeItems.stockTakeId, id))
      .orderBy(asc(stockTakeItems.productName));
    return {...stockTake, items};
  }

  // ─── Start ───────────────────────────────────────────────────────────────
  // 'full'  → snapshots the whole active catalog (unscanned rows stay counted=0
  //           → shortage at completion). 'partial' → starts empty; rows are
  //           added as products are scanned.
  async start(
    businessId: string,
    dto: CreateStockTakeDto,
    account?: IAccount,
  ): Promise<StockTake> {
    // Only one active count at a time — otherwise two snapshots of book qty
    // would race and the freeze-on-sale guard would be ambiguous.
    const [active] = await this.dbService.db
      .select({id: stockTakes.id})
      .from(stockTakes)
      .where(
        and(
          eq(stockTakes.businessId, businessId),
          eq(stockTakes.status, 'in_progress'),
        ),
      )
      .limit(1);
    if (active) {
      throw new AppException(ErrorCode.STOCK_TAKE_IN_PROGRESS);
    }

    const cashier = await this.resolveCashier(account);
    const now = new Date();
    const name =
      dto.name?.trim() ||
      `Inventarizatsiya ${now.toISOString().slice(0, 16).replace('T', ' ')}`;
    const id = generateId();

    await this.dbService.db.transaction(async (tx) => {
      await tx.insert(stockTakes).values({
        id,
        businessId,
        name,
        storeId: dto.storeId ?? null,
        type: dto.type,
        status: 'in_progress',
        createdByCashierId: cashier.id,
        createdByCashierName: cashier.name,
        note: dto.note ?? null,
        startedAt: now,
      });

      // Full count: snapshot every active product's current stock as book qty.
      if (dto.type === 'full') {
        const catalog = await tx
          .select({
            id: products.id,
            name: products.name,
            quantity: products.quantity,
          })
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.isActive, true),
            ),
          );
        if (catalog.length > 0) {
          // Insert in chunks so a very large catalog doesn't blow the query size.
          const CHUNK = 500;
          for (let i = 0; i < catalog.length; i += CHUNK) {
            const slice = catalog.slice(i, i + CHUNK);
            await tx.insert(stockTakeItems).values(
              slice.map((p) => ({
                id: generateId(),
                stockTakeId: id,
                businessId,
                productId: p.id,
                productName: p.name,
                bookQty: p.quantity,
                countedQty: 0,
                diffQty: -p.quantity,
              })),
            );
          }
        }
      }
    });

    // A count just opened — set the in-memory flag so the hot sale/shift path
    // freezes without querying the DB (cleared on completion).
    await setStockTakeActive(this.cache, businessId);
    return this.requireStockTake(businessId, id);
  }

  // ─── Count (upsert scanned rows) ────────────────────────────────────────────
  async count(
    businessId: string,
    id: string,
    dto: CountItemsDto,
  ): Promise<{updated: number}> {
    const stockTake = await this.requireStockTake(businessId, id);
    if (stockTake.status !== 'in_progress') {
      throw new AppException(ErrorCode.STOCK_TAKE_ALREADY_COMPLETED);
    }

    let updated = 0;
    await this.dbService.db.transaction(async (tx) => {
      for (const line of dto.items) {
        const [existing] = await tx
          .select()
          .from(stockTakeItems)
          .where(
            and(
              eq(stockTakeItems.stockTakeId, id),
              eq(stockTakeItems.productId, line.productId),
            ),
          )
          .limit(1);

        if (existing) {
          await tx
            .update(stockTakeItems)
            .set({
              countedQty: line.countedQty,
              diffQty: line.countedQty - existing.bookQty,
            })
            .where(eq(stockTakeItems.id, existing.id));
          updated++;
          continue;
        }

        // Partial count: first time this product is scanned — snapshot its
        // current stock as book qty now.
        const [product] = await tx
          .select({
            id: products.id,
            name: products.name,
            quantity: products.quantity,
          })
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, line.productId),
            ),
          )
          .limit(1);
        if (!product) {
          throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, { productId: line.productId });
        }
        await tx.insert(stockTakeItems).values({
          id: generateId(),
          stockTakeId: id,
          businessId,
          productId: product.id,
          productName: product.name,
          bookQty: product.quantity,
          countedQty: line.countedQty,
          diffQty: line.countedQty - product.quantity,
        });
        updated++;
      }
    });

    return {updated};
  }

  // ─── Complete (adjust stock + batches + finance) ────────────────────────────
  // One atomic transaction:
  //  - surplus (counted > book)  → add a new batch at the LAST priceIn
  //  - shortage (counted < book) → consume batches FIFO (COGS-valued)
  //  - products.quantity := countedQty (sales are frozen, so book == current)
  //  - net diffValue (COGS) → a single financial_transaction (guarded)
  async complete(
    businessId: string,
    id: string,
    dto: CompleteStockTakeDto,
    account?: IAccount,
  ): Promise<StockTake & {items: StockTakeItem[]}> {
    const stockTake = await this.requireStockTake(businessId, id);
    if (stockTake.status !== 'in_progress') {
      throw new AppException(ErrorCode.STOCK_TAKE_ALREADY_COMPLETED);
    }

    const cashier = await this.resolveCashier(account);

    await this.dbService.db.transaction(async (tx) => {
      const items = await tx
        .select()
        .from(stockTakeItems)
        .where(eq(stockTakeItems.stockTakeId, id));

      let surplusQty = 0;
      let shortageQty = 0;
      let netDiffValue = 0;

      for (const item of items) {
        if (!item.productId) continue;
        const diffQty = item.countedQty - item.bookQty;
        // Unchanged lines (counted == book) need no costing and no stock change:
        // the quantity already matches (sales are frozen during a count) and the
        // diff is zero. They're zeroed together in one bulk statement after the
        // loop, so skip the per-row work here — this is the bulk of a full count.
        if (diffQty === 0) continue;

        let unitCost = 0;
        let diffValue = 0;

        if (diffQty > 0) {
          // Surplus: value at the last purchase price and open a new FIFO lot.
          unitCost = await this.lastPriceIn(tx, businessId, item.productId);
          const priceOut = await this.currentPriceOut(
            tx,
            businessId,
            item.productId,
          );
          await tx.insert(inventoryBatches).values({
            id: generateId(),
            businessId,
            productId: item.productId,
            priceIn: unitCost.toFixed(2),
            priceOut: priceOut.toFixed(2),
            qtyReceived: diffQty,
            qtyRemaining: diffQty,
          });
          diffValue = round2(diffQty * unitCost);
          surplusQty += diffQty;
        } else if (diffQty < 0) {
          // Shortage: draw down the FIFO batch queue and value the COGS lost.
          const costing = await consumeBatches(
            tx,
            businessId,
            item.productId,
            -diffQty,
            'FIFO',
            await this.lastPriceIn(tx, businessId, item.productId),
            0,
          );
          unitCost = costing.costIn;
          diffValue = round2(-costing.costTotal);
          shortageQty += -diffQty;
        }

        netDiffValue = round2(netDiffValue + diffValue);

        // Only changed lines reach here, so this runs a handful of times, not
        // once per catalog row.
        await tx
          .update(stockTakeItems)
          .set({
            diffQty,
            unitCost: unitCost.toFixed(2),
            diffValue: diffValue.toFixed(2),
          })
          .where(eq(stockTakeItems.id, item.id));
      }

      // Snap on-hand to the counted reality for every CHANGED line in a single
      // set-based UPDATE — no per-row round-trips. Unchanged lines already match
      // (sales are frozen during a count), so they're left untouched.
      await tx.execute(sql`
        UPDATE products AS p
        SET quantity = sti.counted_qty, updated_at = now()
        FROM stock_take_items AS sti
        WHERE sti.stock_take_id = ${id}
          AND sti.product_id = p.id
          AND p.business_id = ${businessId}
          AND sti.counted_qty <> sti.book_qty
      `);

      // Zero the costing fields on the untouched lines in one statement so their
      // stored diff reads 0 without a per-row write.
      await tx.execute(sql`
        UPDATE stock_take_items
        SET diff_qty = 0, unit_cost = '0.00', diff_value = '0.00'
        WHERE stock_take_id = ${id} AND counted_qty = book_qty
      `);

      await tx
        .update(stockTakes)
        .set({
          status: 'completed',
          completedAt: new Date(),
          surplusQty: surplusQty.toFixed(3),
          shortageQty: shortageQty.toFixed(3),
          diffValue: netDiffValue.toFixed(2),
          note: dto.note ?? stockTake.note,
        })
        .where(eq(stockTakes.id, id));

      // Finance: net COGS diff → income (surplus) / expense (shortage).
      await this.writeFinanceDiff(tx, {
        businessId,
        stockTakeName: stockTake.name,
        netDiffValue,
        cashierId: cashier.id,
        cashierName: cashier.name,
      });
    });

    // Count finished — drop the lock so sales/shifts resume immediately.
    await clearStockTakeActive(this.cache, businessId);
    return this.getOne(businessId, id);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────
  private async requireStockTake(
    businessId: string,
    id: string,
  ): Promise<StockTake> {
    const [row] = await this.dbService.db
      .select()
      .from(stockTakes)
      .where(and(eq(stockTakes.businessId, businessId), eq(stockTakes.id, id)))
      .limit(1);
    if (!row) throw new AppException(ErrorCode.STOCK_TAKE_NOT_FOUND);
    return row;
  }

  // Last purchase price = most recent batch's priceIn, else the product's
  // current (weighted-average) priceIn.
  private async lastPriceIn(
    tx: Tx,
    businessId: string,
    productId: string,
  ): Promise<number> {
    const [batch] = await tx
      .select({priceIn: inventoryBatches.priceIn})
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          eq(inventoryBatches.productId, productId),
        ),
      )
      .orderBy(desc(inventoryBatches.createdAt))
      .limit(1);
    if (batch) return Number(batch.priceIn);
    const [product] = await tx
      .select({priceIn: products.priceIn})
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    return Number(product?.priceIn ?? 0);
  }

  private async currentPriceOut(
    tx: Tx,
    businessId: string,
    productId: string,
  ): Promise<number> {
    const [product] = await tx
      .select({priceOut: products.priceOut})
      .from(products)
      .where(
        and(eq(products.businessId, businessId), eq(products.id, productId)),
      )
      .limit(1);
    return Number(product?.priceOut ?? 0);
  }

  // Writes the aggregate stock-take diff to the finance ledger IF the finance
  // module is present. Guarded by to_regclass so this module stays independent
  // of MOLIYA's rollout (see AGENT-SYNC.md). Contract: MOLIYA.md §4.4.
  private async writeFinanceDiff(
    tx: Tx,
    p: {
      businessId: string;
      stockTakeName: string;
      netDiffValue: number;
      cashierId: string | null;
      cashierName: string | null;
    },
  ): Promise<void> {
    if (!p.netDiffValue) return;
    try {
      // db.execute() returns a bare row array or a { rows } object depending on
      // the driver — normalise both before indexing.
      const regResult = (await tx.execute(
        sql`SELECT to_regclass('public.financial_transactions') AS t`,
      )) as unknown;
      const regRows =
        (regResult as {rows?: Array<{t: string | null}>}).rows ??
        (regResult as Array<{t: string | null}>);
      if (!regRows?.[0]?.t) return; // finance module not migrated yet — skip

      const kind = p.netDiffValue > 0 ? 'income' : 'expense';
      const amount = Math.abs(p.netDiffValue).toFixed(4);
      const note = `Inventarizatsiya: ${p.stockTakeName}`;
      await tx.execute(sql`
        INSERT INTO financial_transactions
          (id, business_id, kind, is_cash, amount, currency,
           cashier_id, cashier_name, note, operation_date, created_at)
        VALUES
          (${generateId()}, ${p.businessId}, ${kind}, false, ${amount}, 'UZS',
           ${p.cashierId}, ${p.cashierName}, ${note}, now(), now())
      `);
    } catch (err) {
      // Never fail the stock-take because finance is mid-migration/renamed.
      this.logger.warn(
        `Skipped finance write for stock-take (${(err as Error).message})`,
      );
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
