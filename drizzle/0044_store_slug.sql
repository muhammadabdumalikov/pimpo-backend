ALTER TABLE "businesses" ADD COLUMN "store_slug" varchar(63);--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "store_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_store_slug_unique" UNIQUE("store_slug");
