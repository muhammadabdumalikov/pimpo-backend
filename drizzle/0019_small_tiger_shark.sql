CREATE TABLE IF NOT EXISTS "account_balances" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"account_id" varchar(36) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"balance" numeric(14, 4) DEFAULT '0' NOT NULL,
	"frozen" numeric(14, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(10) NOT NULL,
	"register_id" varchar(36),
	"store_id" varchar(36),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "financial_categories" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "financial_transactions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"kind" varchar(12) NOT NULL,
	"account_id" varchar(36),
	"account_name" varchar(255),
	"to_account_id" varchar(36),
	"to_account_name" varchar(255),
	"is_cash" boolean DEFAULT true NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"currency" varchar(3) DEFAULT 'UZS' NOT NULL,
	"to_amount" numeric(14, 4),
	"to_currency" varchar(3),
	"rate" numeric(14, 4),
	"subtype" varchar(12),
	"category_id" varchar(36),
	"category_name" varchar(255),
	"cashier_id" varchar(36),
	"cashier_name" varchar(255),
	"note" varchar(500),
	"operation_date" timestamp,
	"order_id" varchar(36),
	"shift_id" varchar(36),
	"cash_movement_id" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_take_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"stock_take_id" varchar(36) NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"product_id" varchar(36),
	"product_name" varchar(255) NOT NULL,
	"book_qty" integer NOT NULL,
	"counted_qty" integer NOT NULL,
	"diff_qty" integer NOT NULL,
	"unit_cost" numeric(10, 2),
	"diff_value" numeric(12, 2),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_takes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"store_id" varchar(36),
	"type" varchar(10) NOT NULL,
	"status" varchar(12) DEFAULT 'in_progress' NOT NULL,
	"surplus_qty" numeric(14, 3),
	"shortage_qty" numeric(14, 3),
	"diff_value" numeric(14, 2),
	"created_by_cashier_id" varchar(36),
	"created_by_cashier_name" varchar(255),
	"note" varchar(500),
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financial_categories" ADD CONSTRAINT "financial_categories_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_take_items" ADD CONSTRAINT "stock_take_items_stock_take_id_stock_takes_id_fk" FOREIGN KEY ("stock_take_id") REFERENCES "public"."stock_takes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_balances_account_currency_idx" ON "account_balances" USING btree ("account_id","currency");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "financial_transactions_business_created_idx" ON "financial_transactions" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "financial_transactions_account_idx" ON "financial_transactions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_take_items_take_idx" ON "stock_take_items" USING btree ("stock_take_id");