import {and, asc, eq, gt, sql} from 'drizzle-orm';
import {branchStock, inventoryBatches, products} from '../database/schema';
import {DatabaseService} from '../database/database.service';
import {generateId} from '../utils/uuid';

// The transaction handle db.transaction hands its callback — same as costing.ts.
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

// Per-branch stock is the source of truth; products.quantity is kept as the sum
// across branches (denormalised) so legacy reads still work during the rollout.
// Every stock write goes through here so the two never drift. Quantities are
// rounded to 3 decimals to match weighed-goods (kg) precision.

/**
 * Add `delta` (can be negative) to a product's stock IN ONE BRANCH, and mirror
 * the same delta onto products.quantity. Upserts the (product, branch) row.
 */
export async function applyBranchStockDelta(
  tx: Tx,
  businessId: string,
  productId: string,
  branchId: string,
  delta: number,
): Promise<void> {
  if (!delta) return;
  await tx
    .insert(branchStock)
    .values({
      id: generateId(),
      businessId,
      productId,
      branchId,
      quantity: delta,
    })
    .onConflictDoUpdate({
      target: [branchStock.productId, branchStock.branchId],
      set: {
        quantity: sql`ROUND((${branchStock.quantity} + ${delta})::numeric, 3)`,
        updatedAt: new Date(),
      },
    });
  await tx
    .update(products)
    .set({
      quantity: sql`ROUND((${products.quantity} + ${delta})::numeric, 3)`,
      updatedAt: new Date(),
    })
    .where(eq(products.id, productId));
}

/**
 * Set a product's stock IN ONE BRANCH to an absolute value (stock-take), moving
 * products.quantity by the difference. Returns the delta applied.
 */
export async function setBranchStock(
  tx: Tx,
  businessId: string,
  productId: string,
  branchId: string,
  newQty: number,
): Promise<number> {
  const [row] = await tx
    .select({quantity: branchStock.quantity})
    .from(branchStock)
    .where(
      and(
        eq(branchStock.productId, productId),
        eq(branchStock.branchId, branchId),
      ),
    )
    .limit(1);
  const current = row ? Number(row.quantity) : 0;
  const delta = Math.round((newQty - current) * 1000) / 1000;
  if (delta === 0 && row) return 0;
  await tx
    .insert(branchStock)
    .values({
      id: generateId(),
      businessId,
      productId,
      branchId,
      quantity: newQty,
    })
    .onConflictDoUpdate({
      target: [branchStock.productId, branchStock.branchId],
      set: {quantity: newQty, updatedAt: new Date()},
    });
  await tx
    .update(products)
    .set({
      quantity: sql`ROUND((${products.quantity} + ${delta})::numeric, 3)`,
      updatedAt: new Date(),
    })
    .where(eq(products.id, productId));
  return delta;
}

/** Read a product's on-hand in a specific branch (0 if no row yet). */
export async function getBranchStock(
  tx: Tx,
  productId: string,
  branchId: string,
): Promise<number> {
  const [row] = await tx
    .select({quantity: branchStock.quantity})
    .from(branchStock)
    .where(
      and(
        eq(branchStock.productId, productId),
        eq(branchStock.branchId, branchId),
      ),
    )
    .limit(1);
  return row ? Number(row.quantity) : 0;
}

/**
 * Trim a branch's open lots down to its stock. A sale may draw more than the
 * lots hold (oversell — the rule for fast-food ingredients, FASTFOOD.md Q4):
 * the lots stop at zero while branch_stock goes negative. When a delivery then
 * lands, its lot would hold the full amount while the stock only rose to what
 * is left after the deficit, and FIFO would later sell the deficit a second
 * time. So after stock arrives, the oldest lots give up whatever exceeds the
 * stock. With the invariant intact (lots = stock) this changes nothing.
 */
export async function trimLotsToStockTx(
  tx: Tx,
  businessId: string,
  productId: string,
  branchId: string,
): Promise<void> {
  const stock = await getBranchStock(tx, productId, branchId);
  const lots = await tx
    .select({id: inventoryBatches.id, qtyRemaining: inventoryBatches.qtyRemaining})
    .from(inventoryBatches)
    .where(
      and(
        eq(inventoryBatches.businessId, businessId),
        eq(inventoryBatches.productId, productId),
        eq(inventoryBatches.branchId, branchId),
        gt(inventoryBatches.qtyRemaining, 0),
      ),
    )
    .orderBy(asc(inventoryBatches.createdAt))
    .for('update');
  const held = lots.reduce((sum, l) => sum + l.qtyRemaining, 0);
  let excess = Math.round((held - Math.max(stock, 0)) * 1000) / 1000;
  for (const lot of lots) {
    if (excess <= 0) break;
    const take = Math.min(excess, lot.qtyRemaining);
    await tx
      .update(inventoryBatches)
      .set({
        qtyRemaining: sql`ROUND((${inventoryBatches.qtyRemaining} - ${take})::numeric, 3)`,
      })
      .where(eq(inventoryBatches.id, lot.id));
    excess = Math.round((excess - take) * 1000) / 1000;
  }
}
