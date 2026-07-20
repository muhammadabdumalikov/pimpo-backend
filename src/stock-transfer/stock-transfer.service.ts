import {Injectable, Logger} from '@nestjs/common';
import {Inject} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {isStockTakeActive} from '../common/stock-take-lock';
import {and, asc, desc, eq, gt, inArray, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  stockTransfers,
  stockTransferItems,
  products,
  inventoryBatches,
  branches,
  staff,
  businesses,
  type StockTransfer,
  type StockTransferItem,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {applyBranchStockDelta, getBranchStock} from '../common/branch-stock';
import {IAccount} from '../business/types';
import {CreateStockTransferDto} from './dto/create-stock-transfer.dto';

// The transaction handle type, same one db.transaction hands its callback.
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class StockTransferService {
  private readonly logger = new Logger(StockTransferService.name);

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ─── Acting cashier (owner or staff) — mirrors StockTakeService ────────────
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
  ): Promise<{items: StockTransfer[]; total: number}> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const offset = (page - 1) * limit;

    const rows = await this.dbService.db
      .select()
      .from(stockTransfers)
      .where(eq(stockTransfers.businessId, businessId))
      .orderBy(desc(stockTransfers.createdAt))
      .limit(limit)
      .offset(offset);

    const [{value: total}] = await this.dbService.db
      .select({value: sql<number>`count(*)::int`})
      .from(stockTransfers)
      .where(eq(stockTransfers.businessId, businessId));

    return {items: rows, total};
  }

  // ─── Detail (with moved rows) ───────────────────────────────────────────────
  async getOne(
    businessId: string,
    id: string,
  ): Promise<StockTransfer & {items: StockTransferItem[]}> {
    const transfer = await this.requireTransfer(businessId, id);
    const items = await this.dbService.db
      .select()
      .from(stockTransferItems)
      .where(eq(stockTransferItems.transferId, id))
      .orderBy(asc(stockTransferItems.productName));
    return {...transfer, items};
  }

  // ─── Create (move stock + batches between branches) ─────────────────────────
  // One atomic transaction per document:
  //  - each line: draw the source branch's FIFO lots and re-open them in the
  //    destination branch (same cost/price/age), so per-branch FIFO/COGS holds
  //  - branch_stock[from] -= qty, branch_stock[to] += qty (products.quantity net
  //    unchanged — a transfer only moves stock, it doesn't create or destroy it)
  //  - NO finance line: no money changes hands, the value stays in inventory
  // Blocked while a stock-take is open (would desync its book snapshot, same as
  // receipts / write-offs).
  async create(
    businessId: string,
    dto: CreateStockTransferDto,
    account?: IAccount,
  ): Promise<StockTransfer & {items: StockTransferItem[]}> {
    if (!dto.items?.length) {
      throw new AppException(ErrorCode.TRANSFER_EMPTY);
    }
    if (dto.fromBranchId === dto.toBranchId) {
      throw new AppException(ErrorCode.TRANSFER_SAME_BRANCH);
    }
    if (await isStockTakeActive(this.cache, this.dbService.db, businessId)) {
      throw new AppException(ErrorCode.STOCK_TAKE_IN_PROGRESS);
    }

    // Dedupe by product (sum quantities) so a repeated row can't fight itself
    // and the per-product locks/reads below stay one-per-product.
    const qtyByProduct = new Map<string, number>();
    for (const line of dto.items) {
      if (!line.productId) continue;
      qtyByProduct.set(
        line.productId,
        (qtyByProduct.get(line.productId) ?? 0) + line.quantity,
      );
    }
    const productIds = [...qtyByProduct.keys()];
    if (productIds.length === 0) {
      throw new AppException(ErrorCode.TRANSFER_EMPTY);
    }

    const cashier = await this.resolveCashier(account);
    const now = new Date();
    const id = generateId();

    await this.dbService.db.transaction(async (tx) => {
      // Both branches must exist and belong to this business.
      const branchRows = await tx
        .select({id: branches.id, name: branches.name})
        .from(branches)
        .where(
          and(
            eq(branches.businessId, businessId),
            inArray(branches.id, [dto.fromBranchId, dto.toBranchId]),
          ),
        );
      const fromBranch = branchRows.find((b) => b.id === dto.fromBranchId);
      const toBranch = branchRows.find((b) => b.id === dto.toBranchId);
      if (!fromBranch || !toBranch) {
        throw new AppException(ErrorCode.BRANCH_NOT_FOUND);
      }

      let totalQty = 0;
      let totalValue = 0;
      const itemRows: (typeof stockTransferItems.$inferInsert)[] = [];

      for (const productId of productIds) {
        const qty =
          Math.round((qtyByProduct.get(productId) ?? 0) * 1000) / 1000;
        // Lock the product so a concurrent sale can't let the source over-draw.
        const [product] = await tx
          .select({id: products.id, name: products.name})
          .from(products)
          .where(
            and(
              eq(products.businessId, businessId),
              eq(products.id, productId),
            ),
          )
          .for('update')
          .limit(1);
        if (!product) {
          throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
            productId,
          });
        }

        const available = await getBranchStock(
          tx,
          product.id,
          dto.fromBranchId,
        );
        if (qty > available) {
          throw new AppException(ErrorCode.TRANSFER_EXCEEDS_STOCK, {
            qty,
            name: product.name,
            available,
          });
        }

        const {costTotal, unitCost} = await this.moveBatchesFifo(
          tx,
          businessId,
          product.id,
          dto.fromBranchId,
          dto.toBranchId,
          qty,
        );

        // Move the per-branch on-hand: leaves source, arrives at destination.
        // The two deltas cancel on products.quantity (no net stock change).
        await applyBranchStockDelta(
          tx,
          businessId,
          product.id,
          dto.fromBranchId,
          -qty,
        );
        await applyBranchStockDelta(
          tx,
          businessId,
          product.id,
          dto.toBranchId,
          qty,
        );

        totalQty = Math.round((totalQty + qty) * 1000) / 1000;
        totalValue = round2(totalValue + costTotal);
        itemRows.push({
          id: generateId(),
          transferId: id,
          businessId,
          productId: product.id,
          productName: product.name,
          quantity: qty,
          unitCost: unitCost.toFixed(2),
          lineTotal: costTotal.toFixed(2),
        });
      }

      await tx.insert(stockTransfers).values({
        id,
        businessId,
        fromBranchId: dto.fromBranchId,
        fromBranchName: fromBranch.name,
        toBranchId: dto.toBranchId,
        toBranchName: toBranch.name,
        status: 'completed',
        itemCount: itemRows.length,
        totalQty: totalQty.toFixed(3),
        totalValue: totalValue.toFixed(2),
        createdByCashierId: cashier.id,
        createdByCashierName: cashier.name,
        note: dto.note ?? null,
        createdAt: now,
      });
      await tx.insert(stockTransferItems).values(itemRows);
    });

    return this.getOne(businessId, id);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  // Draw `qty` from the source branch's open FIFO lots (oldest first) and mirror
  // each consumed slice into the destination branch as a new lot carrying the
  // same priceIn/priceOut and original createdAt — so the destination's FIFO
  // order and COGS reflect the true age/cost of the goods. Rows are locked FOR
  // UPDATE so a concurrent sale can't drain the same lot twice. Returns the total
  // cost value moved and its weighted unit cost.
  private async moveBatchesFifo(
    tx: Tx,
    businessId: string,
    productId: string,
    fromBranchId: string,
    toBranchId: string,
    qty: number,
  ): Promise<{costTotal: number; unitCost: number}> {
    const batches = await tx
      .select({
        id: inventoryBatches.id,
        priceIn: inventoryBatches.priceIn,
        priceOut: inventoryBatches.priceOut,
        qtyRemaining: inventoryBatches.qtyRemaining,
        createdAt: inventoryBatches.createdAt,
      })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          eq(inventoryBatches.productId, productId),
          eq(inventoryBatches.branchId, fromBranchId),
          gt(inventoryBatches.qtyRemaining, 0),
        ),
      )
      .orderBy(asc(inventoryBatches.createdAt))
      .for('update');

    let need = qty;
    let costTotal = 0;
    const newLots: (typeof inventoryBatches.$inferInsert)[] = [];

    for (const batch of batches) {
      if (need <= 0) break;
      const take = Math.min(need, batch.qtyRemaining);
      costTotal += take * Number(batch.priceIn);
      await tx
        .update(inventoryBatches)
        .set({
          qtyRemaining: sql`ROUND((${inventoryBatches.qtyRemaining} - ${take})::numeric, 3)`,
        })
        .where(eq(inventoryBatches.id, batch.id));
      newLots.push({
        id: generateId(),
        businessId,
        productId,
        receiptItemId: null,
        branchId: toBranchId,
        priceIn: batch.priceIn,
        priceOut: batch.priceOut,
        qtyReceived: take,
        qtyRemaining: take,
        createdAt: batch.createdAt,
      });
      need = Math.round((need - take) * 1000) / 1000;
    }

    // Shortfall: branch_stock said the qty was available but the source lots
    // summed to less (legacy/drifted data). Still open a destination lot for the
    // remainder — valued at the product's last purchase price — so the
    // destination's batch sum matches the branch_stock we add below.
    if (need > 0) {
      const priceIn = await this.lastPriceIn(tx, businessId, productId);
      const priceOut = await this.currentPriceOut(tx, businessId, productId);
      costTotal += need * priceIn;
      newLots.push({
        id: generateId(),
        businessId,
        productId,
        receiptItemId: null,
        branchId: toBranchId,
        priceIn: priceIn.toFixed(2),
        priceOut: priceOut.toFixed(2),
        qtyReceived: need,
        qtyRemaining: need,
        createdAt: new Date(),
      });
      this.logger.warn(
        `Transfer shortfall for product ${productId}: ${need} unbacked by source lots; valued at last priceIn`,
      );
    }

    if (newLots.length > 0) {
      await tx.insert(inventoryBatches).values(newLots);
    }

    costTotal = round2(costTotal);
    return {costTotal, unitCost: qty > 0 ? round2(costTotal / qty) : 0};
  }

  private async requireTransfer(
    businessId: string,
    id: string,
  ): Promise<StockTransfer> {
    const [row] = await this.dbService.db
      .select()
      .from(stockTransfers)
      .where(
        and(
          eq(stockTransfers.businessId, businessId),
          eq(stockTransfers.id, id),
        ),
      )
      .limit(1);
    if (!row) throw new AppException(ErrorCode.TRANSFER_NOT_FOUND);
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
}
