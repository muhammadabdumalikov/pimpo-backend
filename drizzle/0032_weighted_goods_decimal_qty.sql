ALTER TABLE "goods_receipt_items" ALTER COLUMN "quantity" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "inventory_batches" ALTER COLUMN "qty_received" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "inventory_batches" ALTER COLUMN "qty_remaining" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "quantity" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "quantity" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "low_stock_threshold" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "stock_take_items" ALTER COLUMN "book_qty" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "stock_take_items" ALTER COLUMN "counted_qty" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "stock_take_items" ALTER COLUMN "diff_qty" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "supplier_return_items" ALTER COLUMN "quantity" SET DATA TYPE double precision;