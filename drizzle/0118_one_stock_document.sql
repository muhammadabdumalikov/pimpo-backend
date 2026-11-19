-- One tool for putting stock into a branch without a supplier
-- (FILIAL-ASSORTIMENT.md, "Soddalashtirish 2026-11-19").
--
-- "Ko'chirish" and "Boshlang'ich qoldiq" used to be two screens with two
-- permissions and two lists. They are one now: every move between branches and
-- every paperless intake is a row in opening_stocks, written with
-- transfer:manage. Two things have to follow the code for that to hold on
-- existing data. Data only — no table or column changes; idempotent.

-- 1. Permission. The document endpoints asked for stocktake:manage and now ask
--    for transfer:manage. A role that could count stock in could already move
--    it between branches through a 'transfer' document, so giving it the
--    transfer permission takes nothing new out of the owner's hands — it keeps
--    those roles working.
UPDATE "roles"
   SET "permissions" = "permissions" || '["transfer:manage"]'::jsonb
 WHERE "permissions" ? 'stocktake:manage'
   AND NOT "permissions" ? 'transfer:manage';

-- 2. History. Transfers made on the old "Ko'chirish" screen (and by the
--    transfer suggestions report) have a stock_transfers row but no document.
--    Give each one a completed document, dated as the transfer was, so the
--    merged list shows them. A transfer that already came from a document is
--    left alone.
INSERT INTO "opening_stocks" (
  "id", "business_id", "branch_id", "branch_name", "source",
  "from_branch_id", "from_branch_name", "status",
  "item_count", "total_qty", "total_value", "transfer_id",
  "created_by_cashier_id", "created_by_cashier_name", "note",
  "completed_at", "created_at", "updated_at"
)
SELECT gen_random_uuid()::text, t."business_id", t."to_branch_id", t."to_branch_name", 'transfer',
       t."from_branch_id", t."from_branch_name", 'completed',
       t."item_count", t."total_qty", t."total_value", t."id",
       t."created_by_cashier_id", t."created_by_cashier_name", t."note",
       t."created_at", t."created_at", t."created_at"
  FROM "stock_transfers" t
 WHERE NOT EXISTS (
         SELECT 1 FROM "opening_stocks" o WHERE o."transfer_id" = t."id"
       );

-- The lines of the documents made above (a document that has lines already is
-- one the shop counted itself). The join on products skips a line whose card
-- has since been deleted outright: opening_stock_items requires the card.
INSERT INTO "opening_stock_items" (
  "id", "opening_stock_id", "business_id", "product_id", "product_name",
  "quantity", "created_at", "updated_at"
)
SELECT gen_random_uuid()::text, o."id", i."business_id", i."product_id", i."product_name",
       i."quantity", i."created_at", i."created_at"
  FROM "stock_transfer_items" i
  JOIN "opening_stocks" o ON o."transfer_id" = i."transfer_id"
  JOIN "products" p ON p."id" = i."product_id"
 WHERE NOT EXISTS (
         SELECT 1 FROM "opening_stock_items" x WHERE x."opening_stock_id" = o."id"
       )
ON CONFLICT ("opening_stock_id", "product_id") DO NOTHING;
