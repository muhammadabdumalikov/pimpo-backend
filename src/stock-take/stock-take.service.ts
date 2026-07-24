import {Inject, Injectable, Logger} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {
  isStockTakeActive,
  setStockTakeActive,
  clearStockTakeActive,
} from '../common/stock-take-lock';
import {and, asc, desc, eq, inArray, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  stockTakes,
  stockTakeItems,
  products,
  inventoryBatches,
  branchStock,
  branches,
  staff,
  businesses,
  type StockTake,
  type StockTakeItem,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {consumeBatches} from '../order/costing';
import {applyBranchStockDelta, getBranchStock} from '../common/branch-stock';
import {IAccount} from '../business/types';
import {CreateStockTakeDto} from './dto/create-stock-take.dto';
import {CountItemsDto} from './dto/count-items.dto';
import {CheckItemsDto} from './dto/check-items.dto';
import {CompleteStockTakeDto} from './dto/complete-stock-take.dto';
import {CreateWriteOffDto} from './dto/create-write-off.dto';

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

  // The branch a count adjusts: its storeId, else the default branch (legacy
  // counts started before the store became required).
  private async resolveBranch(
    tx: Tx,
    businessId: string,
    storeId: string | null,
  ): Promise<string> {
    if (storeId) return storeId;
    const [def] = await tx
      .select({id: branches.id})
      .from(branches)
      .where(
        and(eq(branches.businessId, businessId), eq(branches.isDefault, true)),
      )
      .limit(1);
    if (def) return def.id;
    const [any] = await tx
      .select({id: branches.id})
      .from(branches)
      .where(eq(branches.businessId, businessId))
      .limit(1);
    if (any) return any.id;
    throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
  }

  // ─── List ──────────────────────────────────────────────────────────────────
  async list(
    businessId: string,
    opts: {page?: number; limit?: number} = {},
  ): Promise<{
    items: (StockTake & {itemCount: number; checkedCount: number})[];
    total: number;
  }> {
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

    // Per-take review progress (reviewed rows / total rows) for the list badge.
    // One grouped query over just the page's takes, not a query per row.
    const ids = rows.map((r) => r.id);
    const statsByTake = new Map<
      string,
      {itemCount: number; checkedCount: number}
    >();
    if (ids.length > 0) {
      const stats = await this.dbService.db
        .select({
          stockTakeId: stockTakeItems.stockTakeId,
          itemCount: sql<number>`count(*)::int`,
          checkedCount: sql<number>`count(*) filter (where ${stockTakeItems.checked})::int`,
        })
        .from(stockTakeItems)
        .where(inArray(stockTakeItems.stockTakeId, ids))
        .groupBy(stockTakeItems.stockTakeId);
      for (const s of stats) {
        statsByTake.set(s.stockTakeId, {
          itemCount: s.itemCount,
          checkedCount: s.checkedCount,
        });
      }
    }

    const items = rows.map((r) => ({
      ...r,
      itemCount: statsByTake.get(r.id)?.itemCount ?? 0,
      checkedCount: statsByTake.get(r.id)?.checkedCount ?? 0,
    }));

    return {items, total};
  }

  // ─── Detail (with counted rows) ─────────────────────────────────────────────
  async getOne(
    businessId: string,
    id: string,
  ): Promise<StockTake & {items: StockTakeItem[]}> {
    const stockTake = await this.requireStockTake(businessId, id);
    const rows = await this.dbService.db
      .select({
        item: stockTakeItems,
        priceIn: products.priceIn,
      })
      .from(stockTakeItems)
      .leftJoin(products, eq(stockTakeItems.productId, products.id))
      .where(eq(stockTakeItems.stockTakeId, id))
      .orderBy(asc(stockTakeItems.productName));
    // While a count is in progress unit_cost is still null (the real COGS is
    // written on completion). Surface the product's current cost as unitCost so
    // the client can show a running "farq summasi" (diff value) as it counts.
    const items = rows.map(({item, priceIn}) => ({
      ...item,
      unitCost: item.unitCost ?? priceIn ?? null,
    }));
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

      // Full count: snapshot every active product STOCKED IN the chosen branch —
      // i.e. it has a branch_stock row there (its home branch, or any branch it
      // was transferred into). The book qty is that branch's on-hand. Without a
      // store the whole active catalogue is taken at products.quantity (legacy).
      if (dto.type === 'full') {
        const storeId = dto.storeId;
        const catalog = storeId
          ? await tx
              .select({
                id: products.id,
                name: products.name,
                quantity: branchStock.quantity,
              })
              .from(products)
              .innerJoin(
                branchStock,
                and(
                  eq(branchStock.productId, products.id),
                  eq(branchStock.branchId, storeId),
                ),
              )
              .where(
                and(
                  eq(products.businessId, businessId),
                  eq(products.isActive, true),
                ),
              )
          : await tx
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

    // Dedupe by product (last line wins) so an Excel with a repeated row can't
    // fight itself, and so the set-based reads/writes below stay one-per-product.
    const lineByProduct = new Map<string, (typeof dto.items)[number]>();
    for (const line of dto.items) {
      if (line.productId) lineByProduct.set(line.productId, line);
    }
    const productIds = [...lineByProduct.keys()];
    if (productIds.length === 0) return {updated: 0};

    let updated = 0;
    await this.dbService.db.transaction(async (tx) => {
      // ONE read of the rows already in this count (instead of a SELECT per line).
      const existingRows = await tx
        .select({
          id: stockTakeItems.id,
          productId: stockTakeItems.productId,
          bookQty: stockTakeItems.bookQty,
        })
        .from(stockTakeItems)
        .where(
          and(
            eq(stockTakeItems.stockTakeId, id),
            inArray(stockTakeItems.productId, productIds),
          ),
        );
      const existingByProduct = new Map(
        existingRows.map((r) => [r.productId as string, r]),
      );

      // Split into updates (already counted) and inserts (first time seen).
      const toUpdate: {
        id: string;
        countedQty: number;
        diffQty: number;
        reason: string | null;
      }[] = [];
      const newIds: string[] = [];
      for (const productId of productIds) {
        const line = lineByProduct.get(productId)!;
        const ex = existingByProduct.get(productId);
        if (ex) {
          toUpdate.push({
            id: ex.id,
            countedQty: line.countedQty,
            diffQty: Math.round((line.countedQty - ex.bookQty) * 1000) / 1000,
            reason: line.reason ?? null,
          });
        } else {
          newIds.push(productId);
        }
      }

      // ONE read of the products needed to snapshot the new rows' book qty —
      // taken from THIS COUNT'S BRANCH stock (branch_stock), not the sum.
      const insertRows: (typeof stockTakeItems.$inferInsert)[] = [];
      if (newIds.length > 0) {
        const branchId = await this.resolveBranch(
          tx,
          businessId,
          stockTake.storeId,
        );
        const productRows = await tx
          .select({
            id: products.id,
            name: products.name,
            quantity: sql<number>`COALESCE(${branchStock.quantity}, 0)`,
          })
          .from(products)
          .leftJoin(
            branchStock,
            and(
              eq(branchStock.productId, products.id),
              eq(branchStock.branchId, branchId),
            ),
          )
          .where(
            and(
              eq(products.businessId, businessId),
              inArray(products.id, newIds),
            ),
          );
        const productMap = new Map(productRows.map((p) => [p.id, p]));
        for (const productId of newIds) {
          const p = productMap.get(productId);
          if (!p) {
            throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
              productId,
            });
          }
          const line = lineByProduct.get(productId)!;
          insertRows.push({
            id: generateId(),
            stockTakeId: id,
            businessId,
            productId: p.id,
            productName: p.name,
            bookQty: p.quantity,
            countedQty: line.countedQty,
            diffQty: Math.round((line.countedQty - p.quantity) * 1000) / 1000,
            reason: line.reason ?? null,
          });
        }
      }

      // Bulk INSERT the new rows (chunked so a huge import stays under limits).
      if (insertRows.length > 0) {
        const CHUNK = 1000;
        for (let i = 0; i < insertRows.length; i += CHUNK) {
          await tx
            .insert(stockTakeItems)
            .values(insertRows.slice(i, i + CHUNK));
        }
      }

      // Batch UPDATE the existing rows in ONE statement via a VALUES join
      // (instead of an UPDATE per line). reason is only overwritten when sent.
      if (toUpdate.length > 0) {
        const tuples = toUpdate.map(
          // double precision (not integer) so weighed goods keep fractional
          // counted/diff quantities (e.g. 0.25 kg).
          (u) =>
            sql`(${u.id}::varchar, ${u.countedQty}::double precision, ${u.diffQty}::double precision, ${u.reason}::varchar)`,
        );
        await tx.execute(sql`
          UPDATE stock_take_items AS s
          SET counted_qty = v.counted,
              diff_qty = v.diff,
              reason = COALESCE(v.reason, s.reason)
          FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, counted, diff, reason)
          WHERE s.id = v.id
        `);
      }

      updated = toUpdate.length + insertRows.length;
    });

    return {updated};
  }

  // ─── Check (mark rows reviewed/"tekshirildi") ──────────────────────────────
  // Flips the per-row `checked` flag so a counter can track which products have
  // been verified and filter the list. Independent of the counted quantity.
  async setChecked(
    businessId: string,
    id: string,
    dto: CheckItemsDto,
  ): Promise<{updated: number}> {
    const stockTake = await this.requireStockTake(businessId, id);
    if (stockTake.status !== 'in_progress') {
      throw new AppException(ErrorCode.STOCK_TAKE_ALREADY_COMPLETED);
    }

    // Dedupe by product (last value wins) so a noisy client can't fight itself.
    const checkedByProduct = new Map<string, boolean>();
    for (const line of dto.items) {
      if (line.productId) checkedByProduct.set(line.productId, line.checked);
    }
    const productIds = [...checkedByProduct.keys()];
    if (productIds.length === 0) return {updated: 0};

    // Group the ids by target value → at most two UPDATEs (set true / set false).
    const toTrue = productIds.filter((p) => checkedByProduct.get(p));
    const toFalse = productIds.filter((p) => !checkedByProduct.get(p));

    await this.dbService.db.transaction(async (tx) => {
      const apply = async (ids: string[], value: boolean) => {
        if (ids.length === 0) return;
        await tx
          .update(stockTakeItems)
          .set({checked: value})
          .where(
            and(
              eq(stockTakeItems.stockTakeId, id),
              inArray(stockTakeItems.productId, ids),
            ),
          );
      };
      await apply(toTrue, true);
      await apply(toFalse, false);
    });

    return {updated: productIds.length};
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
      // Lock the row and re-check status inside the tx: two concurrent completes
      // must not both pass the pre-check above and double-consume batches /
      // double-post finance. The loser sees 'completed' and aborts.
      const [locked] = await tx
        .select({status: stockTakes.status})
        .from(stockTakes)
        .where(
          and(eq(stockTakes.businessId, businessId), eq(stockTakes.id, id)),
        )
        .for('update');
      if (!locked || locked.status !== 'in_progress') {
        throw new AppException(ErrorCode.STOCK_TAKE_ALREADY_COMPLETED);
      }

      // Every adjustment below targets this count's branch.
      const branchId = await this.resolveBranch(
        tx,
        businessId,
        stockTake.storeId,
      );

      const items = await tx
        .select()
        .from(stockTakeItems)
        .where(eq(stockTakeItems.stockTakeId, id));

      let surplusQty = 0;
      let shortageQty = 0;
      // Gross values kept apart so a mixed count's shrinkage isn't hidden by
      // netting it against surplus (each posts its own finance line below).
      let surplusValue = 0;
      let shortageValue = 0;

      for (const item of items) {
        if (!item.productId) continue;
        // Round to whole grams so weighed-goods diffs stay clean (0.3 - 0.1
        // float noise → 0.2), which also makes the `=== 0` skip reliable.
        const diffQty =
          Math.round((item.countedQty - item.bookQty) * 1000) / 1000;
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
            branchId,
            priceIn: unitCost.toFixed(2),
            priceOut: priceOut.toFixed(2),
            qtyReceived: diffQty,
            qtyRemaining: diffQty,
          });
          diffValue = round2(diffQty * unitCost);
          surplusQty += diffQty;
          surplusValue = round2(surplusValue + diffValue);
        } else if (diffQty < 0) {
          // Shortage: draw down THIS branch's FIFO queue and value the COGS lost.
          const costing = await consumeBatches(
            tx,
            businessId,
            item.productId,
            -diffQty,
            'FIFO',
            await this.lastPriceIn(tx, businessId, item.productId),
            0,
            branchId,
          );
          unitCost = costing.costIn;
          diffValue = round2(-costing.costTotal);
          shortageQty += -diffQty;
          shortageValue = round2(shortageValue + costing.costTotal);
        }

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

        // Snap THIS branch's stock to the counted reality: bookQty was this
        // branch's on-hand at start and sales are frozen, so applying diffQty
        // lands branch_stock at countedQty and moves products.quantity (the
        // cross-branch sum) by the same amount.
        await applyBranchStockDelta(
          tx,
          businessId,
          item.productId,
          branchId,
          diffQty,
        );
      }

      // (products.quantity + branch_stock were adjusted per changed line above.)

      // Zero the costing fields on the untouched lines in one statement so their
      // stored diff reads 0 without a per-row write.
      await tx.execute(sql`
        UPDATE stock_take_items
        SET diff_qty = 0, unit_cost = '0.00', diff_value = '0.00'
        WHERE stock_take_id = ${id} AND counted_qty = book_qty
      `);

      // Net is still stored as the document's headline figure (list/report),
      // but the two gross legs are what post to finance.
      const netDiffValue = round2(surplusValue - shortageValue);

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

      // Finance: surplus and shortage post as SEPARATE ledger lines (income /
      // expense) so a mixed count records both, not just the net.
      await this.writeFinanceLines(tx, {
        businessId,
        cashierId: cashier.id,
        cashierName: cashier.name,
        lines: [
          {
            kind: 'income',
            amount: surplusValue,
            categoryName: 'Inventarizatsiya ortiqchasi',
            note: `Inventarizatsiya (ortiqcha): ${stockTake.name}`,
          },
          {
            kind: 'expense',
            amount: shortageValue,
            categoryName: 'Inventarizatsiya kamomadi',
            note: `Inventarizatsiya (kamomad): ${stockTake.name}`,
          },
        ],
      });
    });

    // Count finished — drop the lock so sales/shifts resume immediately.
    await clearStockTakeActive(this.cache, businessId);
    return this.getOne(businessId, id);
  }

  // ─── Cancel (abandon an in-progress count, release the freeze) ──────────────
  // A 'full' count freezes ALL sales/shifts/receipts; without this the only way
  // out is to complete it. Marks the count 'cancelled', drops its snapshot rows
  // (they adjust nothing), and clears the lock so the till resumes.
  async cancel(businessId: string, id: string): Promise<StockTake> {
    const stockTake = await this.requireStockTake(businessId, id);
    if (stockTake.status !== 'in_progress') {
      throw new AppException(ErrorCode.STOCK_TAKE_NOT_IN_PROGRESS);
    }

    await this.dbService.db.transaction(async (tx) => {
      // Lock + re-check so a cancel can't race a complete (or another cancel).
      const [locked] = await tx
        .select({status: stockTakes.status})
        .from(stockTakes)
        .where(
          and(eq(stockTakes.businessId, businessId), eq(stockTakes.id, id)),
        )
        .for('update');
      if (!locked || locked.status !== 'in_progress') {
        throw new AppException(ErrorCode.STOCK_TAKE_NOT_IN_PROGRESS);
      }
      await tx.delete(stockTakeItems).where(eq(stockTakeItems.stockTakeId, id));
      await tx
        .update(stockTakes)
        .set({status: 'cancelled', completedAt: new Date()})
        .where(eq(stockTakes.id, id));
    });

    await clearStockTakeActive(this.cache, businessId);
    return this.requireStockTake(businessId, id);
  }

  // ─── Write-off (immediate stock reduction — no count, no freeze) ────────────
  // The simplified "hisobdan chiqarish" flow: damaged/lost goods leave stock
  // right away in one atomic transaction — drawn down FIFO (COGS-valued), stock
  // reduced, an expense line posted. Recorded as a completed stock_take of
  // type 'writeoff' so it shows in the list and the movement report's
  // "written-off" column. Blocked while a count is open (would desync its
  // book snapshot, same reason receipts are frozen).
  async writeOff(
    businessId: string,
    dto: CreateWriteOffDto,
    account?: IAccount,
  ): Promise<StockTake & {items: StockTakeItem[]}> {
    if (!dto.items?.length) {
      throw new AppException(ErrorCode.WRITE_OFF_EMPTY);
    }
    if (await isStockTakeActive(this.cache, this.dbService.db, businessId)) {
      throw new AppException(ErrorCode.STOCK_TAKE_IN_PROGRESS);
    }

    const cashier = await this.resolveCashier(account);
    const now = new Date();
    const name =
      dto.name?.trim() ||
      `Hisobdan chiqarish ${now.toISOString().slice(0, 16).replace('T', ' ')}`;
    const id = generateId();

    await this.dbService.db.transaction(async (tx) => {
      await tx.insert(stockTakes).values({
        id,
        businessId,
        name,
        type: 'writeoff',
        status: 'completed',
        createdByCashierId: cashier.id,
        createdByCashierName: cashier.name,
        note: dto.note ?? null,
        startedAt: now,
        completedAt: now,
      });

      let shortageQty = 0;
      let shortageValue = 0;

      for (const line of dto.items) {
        // Lock the product row so a concurrent sale can't let us over-draw.
        const [product] = await tx
          .select({
            id: products.id,
            name: products.name,
            branchId: products.branchId,
          })
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, line.productId),
            ),
          )
          .for('update')
          .limit(1);
        if (!product) {
          throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
            productId: line.productId,
          });
        }
        // Write off from the product's home branch's stock.
        const branchId = await this.resolveBranch(
          tx,
          businessId,
          product.branchId,
        );
        const available = await getBranchStock(tx, product.id, branchId);
        if (line.qty > available) {
          throw new AppException(ErrorCode.WRITE_OFF_EXCEEDS_STOCK, {
            qty: line.qty,
            name: product.name,
            available,
          });
        }

        const costing = await consumeBatches(
          tx,
          businessId,
          product.id,
          line.qty,
          'FIFO',
          await this.lastPriceIn(tx, businessId, product.id),
          0,
          branchId,
        );
        const diffValue = round2(-costing.costTotal);
        shortageQty += line.qty;
        shortageValue = round2(shortageValue + costing.costTotal);

        await tx.insert(stockTakeItems).values({
          id: generateId(),
          stockTakeId: id,
          businessId,
          productId: product.id,
          productName: product.name,
          bookQty: available,
          countedQty: available - line.qty,
          diffQty: -line.qty,
          unitCost: costing.costIn.toFixed(2),
          diffValue: diffValue.toFixed(2),
          reason: line.reason ?? dto.reason ?? null,
        });

        await applyBranchStockDelta(
          tx,
          businessId,
          product.id,
          branchId,
          -line.qty,
        );
      }

      await tx
        .update(stockTakes)
        .set({
          surplusQty: '0.000',
          shortageQty: shortageQty.toFixed(3),
          diffValue: round2(-shortageValue).toFixed(2),
        })
        .where(eq(stockTakes.id, id));

      await this.writeFinanceLines(tx, {
        businessId,
        cashierId: cashier.id,
        cashierName: cashier.name,
        lines: [
          {
            kind: 'expense',
            amount: shortageValue,
            categoryName: 'Hisobdan chiqarish',
            note: `Hisobdan chiqarish: ${name}`,
          },
        ],
      });
    });

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

  // Writes stock-take finance legs to the ledger IF the finance module is
  // present. Guarded by to_regclass so this module stays independent of MOLIYA's
  // rollout (see AGENT-SYNC.md). Contract: MOLIYA.md §4.4. Surplus and shortage
  // are written as SEPARATE lines (income + expense) so gross shrinkage isn't
  // hidden by netting; zero-amount legs are dropped.
  private async writeFinanceLines(
    tx: Tx,
    p: {
      businessId: string;
      cashierId: string | null;
      cashierName: string | null;
      lines: Array<{
        kind: 'income' | 'expense';
        amount: number; // positive magnitude; 0 is skipped
        categoryName: string;
        note: string;
      }>;
    },
  ): Promise<void> {
    const lines = p.lines.filter((l) => l.amount > 0);
    if (lines.length === 0) return;
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

      for (const line of lines) {
        await tx.execute(sql`
          INSERT INTO financial_transactions
            (id, business_id, kind, is_cash, amount, currency,
             category_name, cashier_id, cashier_name, note, operation_date, created_at)
          VALUES
            (${generateId()}, ${p.businessId}, ${line.kind}, false,
             ${line.amount.toFixed(4)}, 'UZS', ${line.categoryName},
             ${p.cashierId}, ${p.cashierName}, ${line.note}, now(), now())
        `);
      }
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
