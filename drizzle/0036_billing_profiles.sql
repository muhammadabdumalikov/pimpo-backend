CREATE TABLE IF NOT EXISTS "billing_profiles" (
	"business_id" varchar(36) PRIMARY KEY NOT NULL,
	"balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"legal_name" varchar(255),
	"inn" varchar(20),
	"contract_number" varchar(50),
	"contract_date" timestamp with time zone,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_discounts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"business_id" varchar(36) NOT NULL,
	"label" varchar(255) NOT NULL,
	"percent" integer NOT NULL,
	"valid_until" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscription_discounts" ADD CONSTRAINT "subscription_discounts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_discounts_business_idx" ON "subscription_discounts" ("business_id");
