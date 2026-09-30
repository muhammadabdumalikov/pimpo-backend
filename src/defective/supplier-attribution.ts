import {and, eq, inArray, ne, sql, type SQL, type AnyColumn} from 'drizzle-orm';
import {
  goodsReceiptItems,
  goodsReceipts,
  products,
  suppliers,
} from '../database/schema';
import type {DatabaseService} from '../database/database.service';

type Db = DatabaseService['db'];

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Defective stock keeps no record of which supplier a unit came from (a lot
 * knows its product and cost, not its receipt). So "this supplier's defective
 * goods" is decided per product: a product belongs to every supplier that is
 * its assigned default (`products.supplier_id`) or has ever delivered it on a
 * received (non-draft) receipt. A product two suppliers deliver shows under
 * both — the person returning it picks the one; see YOQOTISHLAR.md S3/S13.
 *
 * `productId` is the column holding the product id in the outer query. It
 * must not be `products.id` itself: the subquery's own FROM products would
 * shadow it and the test would match every row.
 */
export function productOfSupplier(
  productId: AnyColumn | SQL,
  businessId: string,
  supplierId: string,
): SQL {
  return sql`(
    EXISTS (
      SELECT 1 FROM ${products}
      WHERE ${products.id} = ${productId}
        AND ${products.businessId} = ${businessId}
        AND ${products.supplierId} = ${supplierId}
    )
    OR EXISTS (
      SELECT 1 FROM ${goodsReceiptItems}
      INNER JOIN ${goodsReceipts} ON ${goodsReceipts.id} = ${goodsReceiptItems.receiptId}
      WHERE ${goodsReceiptItems.productId} = ${productId}
        AND ${goodsReceipts.businessId} = ${businessId}
        AND ${goodsReceipts.supplierId} = ${supplierId}
        AND ${goodsReceipts.status} <> 'draft'
    )
  )`;
}

/** The same rule in bulk: productId → the active suppliers it belongs to. */
export async function supplierLinks(
  db: Db,
  businessId: string,
  productIds: string[],
): Promise<Map<string, Set<string>>> {
  const links = new Map<string, Set<string>>();
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return links;
  const add = (productId: string | null, supplierId: string | null) => {
    if (!productId || !supplierId) return;
    const set = links.get(productId) ?? new Set<string>();
    set.add(supplierId);
    links.set(productId, set);
  };
  const [assigned, received] = await Promise.all([
    db
      .select({productId: products.id, supplierId: suppliers.id})
      .from(products)
      .innerJoin(suppliers, eq(suppliers.id, products.supplierId))
      .where(
        and(
          eq(products.businessId, businessId),
          inArray(products.id, ids),
          eq(suppliers.isActive, true),
        ),
      ),
    db
      .selectDistinct({
        productId: goodsReceiptItems.productId,
        supplierId: suppliers.id,
      })
      .from(goodsReceiptItems)
      .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.receiptId))
      .innerJoin(suppliers, eq(suppliers.id, goodsReceipts.supplierId))
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          ne(goodsReceipts.status, 'draft'),
          inArray(goodsReceiptItems.productId, ids),
          eq(suppliers.isActive, true),
        ),
      ),
  ]);
  for (const r of assigned) add(r.productId, r.supplierId);
  for (const r of received) add(r.productId, r.supplierId);
  return links;
}

/**
 * A price for a product that is not on the receipt it goes back against
 * (YOQOTISHLAR.md S14): the supplier's own last delivery of it, or failing
 * that the card's purchase price. `rate` turns `price` into base UZS.
 */
export interface OffReceiptPrice {
  price: number;
  currency: string;
  rate: number;
  source: 'last_delivery' | 'card';
  /** last_delivery: when that receipt came in. */
  from: Date | null;
}

/** `${supplierId}:${productId}` → the price to use off-receipt; absent = none (no price). */
export async function offReceiptPrices(
  db: Db,
  businessId: string,
  supplierIds: string[],
  productIds: string[],
): Promise<Map<string, OffReceiptPrice>> {
  const out = new Map<string, OffReceiptPrice>();
  const sIds = [...new Set(supplierIds.filter(Boolean))];
  const pIds = [...new Set(productIds.filter(Boolean))];
  if (!sIds.length || !pIds.length) return out;
  const [lastLines, cards] = await Promise.all([
    db
      .selectDistinctOn([goodsReceipts.supplierId, goodsReceiptItems.productId], {
        supplierId: goodsReceipts.supplierId,
        productId: goodsReceiptItems.productId,
        priceIn: goodsReceiptItems.priceIn,
        currency: goodsReceipts.currency,
        usdRate: goodsReceipts.usdRate,
        createdAt: goodsReceipts.createdAt,
      })
      .from(goodsReceiptItems)
      .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.receiptId))
      .where(
        and(
          eq(goodsReceipts.businessId, businessId),
          ne(goodsReceipts.status, 'draft'),
          inArray(goodsReceipts.supplierId, sIds),
          inArray(goodsReceiptItems.productId, pIds),
        ),
      )
      .orderBy(
        goodsReceipts.supplierId,
        goodsReceiptItems.productId,
        sql`${goodsReceipts.createdAt} desc`,
        sql`${goodsReceiptItems.createdAt} desc`,
      ),
    db
      .select({id: products.id, priceIn: products.priceIn})
      .from(products)
      .where(and(eq(products.businessId, businessId), inArray(products.id, pIds))),
  ]);
  for (const r of lastLines) {
    if (!r.supplierId || !r.productId) continue;
    const price = Number(r.priceIn);
    if (!(price > 0)) continue;
    out.set(`${r.supplierId}:${r.productId}`, {
      price,
      currency: r.currency,
      rate: r.currency === 'USD' ? Number(r.usdRate ?? 1) || 1 : 1,
      source: 'last_delivery',
      from: r.createdAt,
    });
  }
  const card = new Map(cards.map((c) => [c.id, Number(c.priceIn)]));
  for (const s of sIds) {
    for (const p of pIds) {
      const key = `${s}:${p}`;
      const price = card.get(p) ?? 0;
      if (out.has(key) || !(price > 0)) continue;
      out.set(key, {price, currency: 'UZS', rate: 1, source: 'card', from: null});
    }
  }
  return out;
}

/**
 * An off-receipt price in the target receipt's currency. Same currency: as
 * is. Otherwise through so'm, at the rates each receipt was booked at.
 */
export function priceInReceiptCurrency(
  ref: {price: number; currency: string; rate: number},
  target: {currency: string; usdRate: number | string | null},
): number {
  if (ref.currency === target.currency) return round2(ref.price);
  const uzs = ref.price * ref.rate;
  if (target.currency === 'USD') {
    return round2(uzs / (Number(target.usdRate ?? 1) || 1));
  }
  return round2(uzs);
}
