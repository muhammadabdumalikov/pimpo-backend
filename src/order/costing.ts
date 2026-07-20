import {and, asc, eq, gt, sql} from 'drizzle-orm';
import {inventoryBatches} from '../database/schema';
import {DatabaseService} from '../database/database.service';

// The transaction handle passed to consumeBatches (same type the db.transaction
// callback receives), so batch reads/writes commit atomically with the sale.
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

export type CostingMethod = 'AVERAGE' | 'FIFO';

export interface LineCosting {
  // COGS for the whole line and its weighted unit cost (the order_items snapshot).
  costTotal: number;
  costIn: number;
  // Revenue for the line and its weighted unit selling price — a line can span
  // batches at different selling prices, so this is computed, not a single price.
  revenueTotal: number;
  priceOut: number;
  // Selling price of the oldest open batch AFTER this consumption, so the caller
  // can keep products.priceOut tracking the next-to-sell price (null if no stock).
  frontPriceOut: string | null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Consume `quantity` units of a product from its open inventory batches,
 * oldest-first (FIFO), and value the COGS for the line.
 *
 * - Selling price is normally taken per batch (`batch.priceOut`). When
 *   `priceOverride` is given (a chosen wholesale/bundle tier), the whole line is
 *   valued at that flat unit price instead — cost and stock are unaffected.
 * - Unit cost depends on the method: FIFO uses each batch's own `priceIn`;
 *   AVERAGE uses the product's current weighted-average cost (`fallbackPriceIn`).
 * - If the batches run dry before the quantity is met (oversell), the shortfall
 *   is valued at the product's current `priceIn` / `priceOut`.
 *
 * The batch rows are locked `FOR UPDATE` so two concurrent sales can't drain the
 * same lot twice.
 */
export async function consumeBatches(
  tx: Tx,
  businessId: string,
  productId: string,
  quantity: number,
  method: CostingMethod,
  fallbackPriceIn: number,
  fallbackPriceOut: number,
  // Draw only from this branch's lots (per-branch FIFO). Null = any lot (legacy
  // / single-branch), so pre-per-branch callers keep working.
  branchId: string | null = null,
  priceOverride?: number | null,
): Promise<LineCosting> {
  const batches = await tx
    .select({
      id: inventoryBatches.id,
      priceIn: inventoryBatches.priceIn,
      priceOut: inventoryBatches.priceOut,
      qtyRemaining: inventoryBatches.qtyRemaining,
    })
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.businessId, businessId),
        eq(inventoryBatches.productId, productId),
        gt(inventoryBatches.qtyRemaining, 0),
        ...(branchId ? [eq(inventoryBatches.branchId, branchId)] : []),
      ),
    )
    .orderBy(asc(inventoryBatches.createdAt))
    .for('update');

  let need = quantity;
  let costTotal = 0;
  let revenueTotal = 0;

  for (const batch of batches) {
    if (need <= 0) break;
    const take = Math.min(need, batch.qtyRemaining);
    const unitCost =
      method === 'FIFO' ? Number(batch.priceIn) : fallbackPriceIn;
    const unitPrice = Number(batch.priceOut);
    costTotal += take * unitCost;
    revenueTotal += take * unitPrice;
    await tx
      .update(inventoryBatches)
      .set({
        qtyRemaining: sql`ROUND((${inventoryBatches.qtyRemaining} - ${take})::numeric, 3)`,
      })
      .where(eq(inventoryBatches.id, batch.id));
    need -= take;
  }

  // Oversell: value the leftover units at the product's current cost/price.
  if (need > 0) {
    costTotal += need * fallbackPriceIn;
    revenueTotal += need * fallbackPriceOut;
  }

  // A chosen tier (wholesale/bundle) prices the whole line flat, replacing the
  // per-batch revenue; COGS and stock consumption above are unaffected.
  if (priceOverride != null) {
    revenueTotal = priceOverride * quantity;
  }

  costTotal = round2(costTotal);
  revenueTotal = round2(revenueTotal);
  const costIn = quantity > 0 ? round2(costTotal / quantity) : 0;
  const priceOut = quantity > 0 ? round2(revenueTotal / quantity) : 0;

  // Oldest open batch left after consuming — the next price the till shows.
  const [front] = await tx
    .select({priceOut: inventoryBatches.priceOut})
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.businessId, businessId),
        eq(inventoryBatches.productId, productId),
        gt(inventoryBatches.qtyRemaining, 0),
        ...(branchId ? [eq(inventoryBatches.branchId, branchId)] : []),
      ),
    )
    .orderBy(asc(inventoryBatches.createdAt))
    .limit(1);

  return {
    costTotal,
    costIn,
    revenueTotal,
    priceOut,
    frontPriceOut: front?.priceOut ?? null,
  };
}
