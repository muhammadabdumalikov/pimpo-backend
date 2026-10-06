import {Injectable, Logger} from '@nestjs/common';
import {Cron} from '@nestjs/schedule';
import {and, asc, desc, eq, gt, inArray, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  businesses,
  goodsReceipts,
  inventoryBatches,
  productPriceHistory,
  productPriceSteps,
  products,
  staff,
  units,
} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {IAccount} from '../business/types';
import {TelegramNotifyService} from '../telegram/telegram-notify.service';
import {
  applyStepNowTx,
  cancelProductStepsTx,
  settleDuePriceStepsTx,
  type AppliedPriceStep,
} from '../common/price-steps';

/**
 * One price a delivery put in the queue, as the delivery's page shows it:
 * still waiting, taken effect, or dropped — whichever its record says last.
 */
export interface ReceiptPriceStepRow {
  productId: string;
  productName: string;
  /** The product's unit word ("dona", "kg"), when it has one. */
  unit: string | null;
  field: string;
  /** The waiting figure (or, once applied, the figure that went on). */
  price: string;
  status: 'waiting' | 'applied' | 'cancelled';
  /** Why it was dropped ('cancelled' only). */
  reason: string | null;
  /** When it joined the queue, took effect or was dropped. */
  at: Date;
  by: string | null;
  /** The card's figure for the field now. */
  cardPrice: string | null;
  /** Units older than it still to sell ('waiting' only). */
  oldStock: number | null;
}

/** One waiting price as the product card shows it. */
export interface PriceStepView {
  id: string;
  field: string;
  price: string;
  receiptId: string;
  supplierName: string | null;
  receivedAt: Date | null;
  queuedBy: string | null;
  queuedAt: Date;
  // The older stock it waits for: open lots created before its trigger.
  oldStock: {
    total: number;
    branches: {
      branchId: string | null;
      branchName: string | null;
      qty: number;
    }[];
  };
}

/**
 * "Navbatdagi narx" outside the hot paths: settling after a stock movement,
 * the product card's view of the chain, apply-now / cancel, and a sweep that
 * catches the movements nobody settled after (write-offs, counts, …).
 * The rules live in common/price-steps.ts.
 */
@Injectable()
export class PriceStepService {
  private readonly logger = new Logger(PriceStepService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly telegramNotify: TelegramNotifyService,
  ) {}

  /**
   * Apply whatever became due for these products (all of the business when
   * omitted) and tell the shop. Never throws: a price that could not move now
   * moves at the next sale or sweep, and the stock movement that called this
   * has already happened.
   */
  async settle(
    businessId: string,
    productIds?: string[],
  ): Promise<AppliedPriceStep[]> {
    try {
      // Every sale lands here; almost none has a waiting price. One indexed
      // probe instead of a locking transaction keeps the till's path cheap.
      if (productIds) {
        if (productIds.length === 0) return [];
        const [any] = await this.dbService.db
          .select({id: productPriceSteps.id})
          .from(productPriceSteps)
          .where(
            and(
              eq(productPriceSteps.businessId, businessId),
              inArray(productPriceSteps.productId, productIds),
            ),
          )
          .limit(1);
        if (!any) return [];
      }
      const applied = await this.dbService.db.transaction((tx) =>
        settleDuePriceStepsTx(tx, businessId, productIds),
      );
      if (applied.length > 0) {
        this.telegramNotify.notifyPriceChanges(businessId, applied);
      }
      return applied;
    } catch (err) {
      this.logger.error(
        `Settling price steps failed for ${businessId}: ${String(err)}`,
      );
      return [];
    }
  }

  /** The product's waiting prices, chain order, each with the stock it waits for. */
  async list(businessId: string, productId: string): Promise<PriceStepView[]> {
    await this.assertProduct(businessId, productId);
    // A movement nobody settled after must not leave a stale row on screen.
    await this.settle(businessId, [productId]);

    const steps = await this.dbService.db
      .select({
        id: productPriceSteps.id,
        field: productPriceSteps.field,
        price: productPriceSteps.price,
        receiptId: productPriceSteps.receiptId,
        supplierName: goodsReceipts.supplierName,
        receivedAt: goodsReceipts.createdAt,
        queuedBy: productPriceSteps.cashierName,
        queuedAt: productPriceSteps.createdAt,
      })
      .from(productPriceSteps)
      .leftJoin(
        goodsReceipts,
        eq(goodsReceipts.id, productPriceSteps.receiptId),
      )
      .where(
        and(
          eq(productPriceSteps.businessId, businessId),
          eq(productPriceSteps.productId, productId),
        ),
      )
      .orderBy(
        asc(productPriceSteps.field),
        asc(productPriceSteps.triggerAt),
        asc(productPriceSteps.createdAt),
      );
    if (steps.length === 0) return [];

    // Older stock per step and branch, computed against the stored trigger in
    // SQL so no timestamp crosses the driver.
    const res = await this.dbService.db.execute(sql`
      select s.id as step_id, b.branch_id, br.name as branch_name,
             round(sum(b.qty_remaining)::numeric, 3)::float8 as qty
      from product_price_steps s
      join inventory_batches b
        on b.business_id = s.business_id
       and b.product_id = s.product_id
       and b.qty_remaining > 0
       and b.created_at < s.trigger_at
      left join branches br on br.id = b.branch_id
      where s.business_id = ${businessId} and s.product_id = ${productId}
      group by s.id, b.branch_id, br.name
      order by qty desc`);
    const rows =
      (res as {rows?: OldStockRow[]}).rows ?? (res as unknown as OldStockRow[]);
    const byStep = new Map<string, PriceStepView['oldStock']>();
    for (const r of rows) {
      const entry = byStep.get(r.step_id) ?? {total: 0, branches: []};
      const qty = Number(r.qty) || 0;
      entry.total = Math.round((entry.total + qty) * 1000) / 1000;
      entry.branches.push({
        branchId: r.branch_id,
        branchName: r.branch_name,
        qty,
      });
      byStep.set(r.step_id, entry);
    }

    return steps.map((s) => ({
      ...s,
      oldStock: byStep.get(s.id) ?? {total: 0, branches: []},
    }));
  }

  /**
   * Every price this delivery put in the queue and where each stands now,
   * read from its own record (queue_add → waiting, queued → applied,
   * queue_cancel → dropped; the last row of a product+field wins).
   */
  async receiptSteps(
    businessId: string,
    receiptId: string,
  ): Promise<ReceiptPriceStepRow[]> {
    // A movement nobody settled after must not show a stale "waiting".
    const pendingProducts = await this.dbService.db
      .selectDistinct({productId: productPriceSteps.productId})
      .from(productPriceSteps)
      .where(
        and(
          eq(productPriceSteps.businessId, businessId),
          eq(productPriceSteps.receiptId, receiptId),
        ),
      );
    if (pendingProducts.length > 0) {
      await this.settle(
        businessId,
        pendingProducts.map((p) => p.productId),
      );
    }

    const rows = await this.dbService.db
      .select({
        productId: productPriceHistory.productId,
        productName: products.name,
        unit: units.shortName,
        field: productPriceHistory.field,
        source: productPriceHistory.source,
        reason: productPriceHistory.reason,
        price: productPriceHistory.newPrice,
        by: productPriceHistory.cashierName,
        at: productPriceHistory.createdAt,
        priceOut: products.priceOut,
        priceWholesale: products.priceWholesale,
        priceBundle: products.priceBundle,
      })
      .from(productPriceHistory)
      .innerJoin(products, eq(products.id, productPriceHistory.productId))
      .leftJoin(units, eq(units.id, products.unitId))
      .where(
        and(
          eq(productPriceHistory.businessId, businessId),
          eq(productPriceHistory.receiptId, receiptId),
          inArray(productPriceHistory.source, [
            'queue_add',
            'queued',
            'queue_cancel',
          ]),
        ),
      )
      .orderBy(asc(productPriceHistory.createdAt), asc(productPriceHistory.id));
    if (rows.length === 0) return [];

    // Still waiting, with the stock each step waits for (all branches).
    const res = await this.dbService.db.execute(sql`
      select s.product_id, s.field,
             coalesce((
               select round(sum(b.qty_remaining)::numeric, 3)::float8
               from inventory_batches b
               where b.business_id = s.business_id
                 and b.product_id = s.product_id
                 and b.qty_remaining > 0
                 and b.created_at < s.trigger_at), 0) as old_qty
      from product_price_steps s
      where s.business_id = ${businessId} and s.receipt_id = ${receiptId}`);
    const waiting =
      (res as {rows?: WaitingRow[]}).rows ?? (res as unknown as WaitingRow[]);
    const oldByKey = new Map(
      waiting.map((w) => [
        `${w.product_id}|${w.field}`,
        Number(w.old_qty) || 0,
      ]),
    );

    const last = new Map<string, (typeof rows)[number]>();
    for (const r of rows) last.set(`${r.productId}|${r.field}`, r);

    return [...last.entries()].map(([key, r]) => {
      const stillWaiting = oldByKey.has(key);
      const status: ReceiptPriceStepRow['status'] =
        r.source === 'queued'
          ? 'applied'
          : r.source === 'queue_add' && stillWaiting
            ? 'waiting'
            : 'cancelled';
      const card =
        r.field === 'priceWholesale'
          ? r.priceWholesale
          : r.field === 'priceBundle'
            ? r.priceBundle
            : r.priceOut;
      return {
        productId: r.productId,
        productName: r.productName,
        unit: r.unit ?? null,
        field: r.field,
        price: r.price,
        status,
        reason: status === 'cancelled' ? r.reason : null,
        at: r.at,
        by: r.by,
        cardPrice: card,
        oldStock: status === 'waiting' ? (oldByKey.get(key) ?? 0) : null,
      };
    });
  }

  /** "Hozir qo'llash": this step and every one ahead of it in its chain. */
  async applyNow(
    businessId: string,
    productId: string,
    stepId: string,
    account?: IAccount,
  ): Promise<AppliedPriceStep[]> {
    await this.assertProduct(businessId, productId);
    const actor = await this.resolveActor(account);
    const applied = await this.dbService.db.transaction((tx) =>
      applyStepNowTx(tx, businessId, productId, stepId, actor),
    );
    if (applied == null) throw new AppException(ErrorCode.PRICE_STEP_NOT_FOUND);
    return applied;
  }

  /** "Bekor qilish": drop one waiting price, or all of the product's. */
  async cancel(
    businessId: string,
    productId: string,
    stepId?: string,
    account?: IAccount,
  ): Promise<{cancelled: number}> {
    await this.assertProduct(businessId, productId);
    const actor = await this.resolveActor(account);
    const cancelled = await this.dbService.db.transaction((tx) =>
      cancelProductStepsTx(tx, businessId, productId, stepId, {
        reason: 'button',
        actor,
      }),
    );
    if (stepId && cancelled === 0) {
      throw new AppException(ErrorCode.PRICE_STEP_NOT_FOUND);
    }
    return {cancelled};
  }

  /**
   * What the stock on hand cost, grouped by purchase price, dearest first —
   * across every branch, in base UZS. The product form warns with it when a
   * selling price is set below what some of that stock was bought for: a
   * hand-set price goes onto the card at once, waiting for nothing.
   */
  async stockCosts(
    businessId: string,
    productId: string,
  ): Promise<{cost: number; qty: number}[]> {
    await this.assertProduct(businessId, productId);
    const rows = await this.dbService.db
      .select({
        cost: inventoryBatches.priceIn,
        qty: sql<number>`round(sum(${inventoryBatches.qtyRemaining})::numeric, 3)::float8`,
      })
      .from(inventoryBatches)
      .where(
        and(
          eq(inventoryBatches.businessId, businessId),
          eq(inventoryBatches.productId, productId),
          gt(inventoryBatches.qtyRemaining, 0),
        ),
      )
      .groupBy(inventoryBatches.priceIn)
      .orderBy(desc(inventoryBatches.priceIn));
    return rows.map((r) => ({cost: Number(r.cost), qty: Number(r.qty)}));
  }

  /**
   * Backstop: write-offs, counts, supplier returns and the like drain lots
   * too, and not every one of them settles afterwards. Every five minutes,
   * whatever became due anywhere takes effect.
   */
  @Cron('*/5 * * * *', {name: 'price-steps-sweep'})
  async sweep(): Promise<void> {
    try {
      const res = await this.dbService.db.execute(sql`
        select distinct s.business_id
        from product_price_steps s
        where not exists (
          select 1 from inventory_batches b
          where b.business_id = s.business_id
            and b.product_id = s.product_id
            and b.qty_remaining > 0
            and b.created_at < s.trigger_at)`);
      const rows =
        (res as {rows?: {business_id: string}[]}).rows ??
        (res as unknown as {business_id: string}[]);
      for (const r of rows) await this.settle(r.business_id);
    } catch (err) {
      this.logger.error(`Price step sweep failed: ${String(err)}`);
    }
  }

  private async assertProduct(
    businessId: string,
    productId: string,
  ): Promise<void> {
    const [row] = await this.dbService.db
      .select({id: products.id})
      .from(products)
      .where(
        and(eq(products.businessId, businessId), eq(products.id, productId)),
      )
      .limit(1);
    if (!row) throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
  }

  /** Who pressed the button, for the price history. Owner = the business. */
  private async resolveActor(
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
}

interface WaitingRow {
  product_id: string;
  field: string;
  old_qty: number | string;
}

interface OldStockRow {
  step_id: string;
  branch_id: string | null;
  branch_name: string | null;
  qty: number | string;
}
