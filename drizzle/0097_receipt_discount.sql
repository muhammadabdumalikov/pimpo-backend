-- Receipt-level supplier discount ("Скидка" under a nakladnoy's lines).
--
-- goods_receipts.total_amount becomes what is owed AFTER the discount
-- ("К оплате"); the gross is total_amount + discount_amount. Each line's
-- price_in is the NET unit cost (its share of the discount taken off), so
-- lots, averages, returns and reports need no change; doc_price_in keeps the
-- printed price for the document view.
--
-- Idempotent; additive only. Existing rows: discount 0, doc_price_in null
-- (= price_in), so the old code keeps serving through the rollout.

ALTER TABLE "goods_receipts" ADD COLUMN IF NOT EXISTS "discount_amount" numeric(12, 2) DEFAULT '0' NOT NULL;
ALTER TABLE "goods_receipts" ADD COLUMN IF NOT EXISTS "discount_pct" numeric(7, 4);
ALTER TABLE "goods_receipt_items" ADD COLUMN IF NOT EXISTS "doc_price_in" numeric(10, 2);
