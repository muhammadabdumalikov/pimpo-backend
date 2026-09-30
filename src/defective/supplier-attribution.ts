import {sql, type SQL, type AnyColumn} from 'drizzle-orm';
import {goodsReceiptItems, goodsReceipts, products} from '../database/schema';

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
