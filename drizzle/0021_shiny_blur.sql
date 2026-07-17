ALTER TABLE "goods_receipt_items" ADD COLUMN "price_out" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD COLUMN "price_wholesale" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "price_wholesale" numeric(10, 2);