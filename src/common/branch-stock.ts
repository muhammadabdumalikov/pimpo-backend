import {and, eq, sql} from 'drizzle-orm';
import {branchStock, products} from '../database/schema';
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
