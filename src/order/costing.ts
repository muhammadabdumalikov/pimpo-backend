import {and, asc, eq, gt, sql} from 'drizzle-orm';
import {inventoryBatches} from '../database/schema';
import {DatabaseService} from '../database/database.service';

// The transaction handle passed to consumeBatches (same type the db.transaction
// callback receives), so batch reads/writes commit atomically with the sale.
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

export type CostingMethod = 'AVERAGE' | 'FIFO';

export interface LineCosting {
  // COGS for the whole line and its weighted unit cost (the order_items snapshot).
  // A line can span lots bought at different costs, so costIn is computed.
  costTotal: number;
  costIn: number;
  // Revenue for the line and its unit selling price. Both come from the product
  // card (or the chosen tier), never from the lots: the shop sets one price and
  // every unit sells at it, whichever delivery it happens to come out of.
  revenueTotal: number;
  priceOut: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Consume `quantity` units of a product from its open inventory batches,
 * oldest-first (FIFO), and value the COGS for the line.
 *
 * - Selling price is the product card's price (`cardPriceOut`), or the flat
 *   `priceOverride` when a wholesale/bundle tier was chosen. The lots carry a
 *   `priceOut` of their own, but it is the price that was written on the
 *   delivery note — a record of that document, not what the shop charges today.
 *   Pricing from it is what used to make a card price wander: a sale valued the
 *   line at the front lot's figure and then snapped the card back to it, so a
 *   hand-set price survived only until the next sale of that product.
 * - Unit cost depends on the method: FIFO uses each batch's own `priceIn`;
 *   AVERAGE uses the product's current weighted-average cost (`fallbackPriceIn`).
 * - If the batches run dry before the quantity is met (oversell), the shortfall
 *   is costed at the product's current `priceIn`. It sells at the same card
 *   price as the rest of the line.
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
  cardPriceOut: number,
  // Draw only from this branch's lots (per-branch FIFO). Null = any lot (legacy
  // / single-branch), so pre-per-branch callers keep working.
  branchId: string | null = null,
  priceOverride?: number | null,
): Promise<LineCosting> {
  const batches = await tx
    .select({
      id: inventoryBatches.id,
      priceIn: inventoryBatches.priceIn,
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

  for (const batch of batches) {
    if (need <= 0) break;
    const take = Math.min(need, batch.qtyRemaining);
    const unitCost =
      method === 'FIFO' ? Number(batch.priceIn) : fallbackPriceIn;
    costTotal += take * unitCost;
    await tx
      .update(inventoryBatches)
      .set({
        qtyRemaining: sql`ROUND((${inventoryBatches.qtyRemaining} - ${take})::numeric, 3)`,
      })
      .where(eq(inventoryBatches.id, batch.id));
    need -= take;
  }

  // Oversell: the units the lots could not cover are costed at the product's
  // current weighted-average cost. They sell at the card price like the rest.
  if (need > 0) {
    costTotal += need * fallbackPriceIn;
  }

  // One price for the whole line: the chosen tier when there is one, the card
  // price otherwise.
  const unitPrice = priceOverride != null ? priceOverride : cardPriceOut;

  costTotal = round2(costTotal);
  const revenueTotal = round2(unitPrice * quantity);
  const costIn = quantity > 0 ? round2(costTotal / quantity) : 0;

  return {
    costTotal,
    costIn,
    revenueTotal,
    priceOut: round2(unitPrice),
  };
}
