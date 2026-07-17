CREATE TABLE IF NOT EXISTS "receipt_templates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"print_type" varchar(20) DEFAULT 'receipt' NOT NULL,
	"register_id" varchar(36),
	"show_logo" boolean DEFAULT true NOT NULL,
	"logo_url" varchar(500),
	"extra_image_url" varchar(500),
	"show_customer_balance" boolean DEFAULT false NOT NULL,
	"show_customer_debt" boolean DEFAULT false NOT NULL,
	"show_product_attributes" boolean DEFAULT false NOT NULL,
	"show_powered_by" boolean DEFAULT true NOT NULL,
	"info_fields" jsonb,
	"footer_links" jsonb,
	"footer_text" varchar(2000),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipt_templates" ADD CONSTRAINT "receipt_templates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "receipt_templates" ADD CONSTRAINT "receipt_templates_register_id_cash_registers_id_fk" FOREIGN KEY ("register_id") REFERENCES "public"."cash_registers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Seed one default business-wide template per business, carrying over the
-- name/logo from the existing single receipt_settings row where present.
INSERT INTO "receipt_templates" (
	"id", "business_id", "name", "print_type", "register_id",
	"show_logo", "logo_url", "show_powered_by",
	"info_fields", "footer_links", "footer_text", "is_default"
)
SELECT
	gen_random_uuid()::text,
	b."id",
	COALESCE(rs."receipt_name", 'Standart'),
	'receipt',
	NULL,
	COALESCE(rs."show_logo", true),
	rs."logo_url",
	true,
	'[{"key":"storeName","enabled":true},{"key":"date","enabled":true},{"key":"workTime","enabled":false},{"key":"seller","enabled":false},{"key":"cashier","enabled":true},{"key":"customer","enabled":true},{"key":"contacts","enabled":false},{"key":"customerPhone","enabled":false},{"key":"saleComment","enabled":false},{"key":"inn","enabled":false},{"key":"legalName","enabled":false},{"key":"address","enabled":false},{"key":"productCount","enabled":true},{"key":"showProducts","enabled":true},{"key":"itemDiscounts","enabled":false},{"key":"itemSums","enabled":true},{"key":"receiptDiscounts","enabled":true},{"key":"receiptSums","enabled":true}]'::jsonb,
	'[{"key":"facebook","enabled":false,"value":""},{"key":"instagram","enabled":false,"value":""},{"key":"telegram","enabled":false,"value":""},{"key":"website","enabled":false,"value":""},{"key":"barcode","enabled":true,"value":""}]'::jsonb,
	'Спасибо за вашу покупку!',
	true
FROM "businesses" b
LEFT JOIN "receipt_settings" rs ON rs."business_id" = b."id"
WHERE NOT EXISTS (
	SELECT 1 FROM "receipt_templates" rt WHERE rt."business_id" = b."id"
);
