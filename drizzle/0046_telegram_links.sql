CREATE TABLE IF NOT EXISTS "telegram_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"account_type" varchar(12) NOT NULL,
	"account_id" varchar(36) NOT NULL,
	"account_login" varchar(100) NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"chat_id" varchar(32) NOT NULL,
	"tg_username" varchar(255),
	"tg_first_name" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_links_chat_id_uq" ON "telegram_links" ("chat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_links_business_idx" ON "telegram_links" ("business_id");
