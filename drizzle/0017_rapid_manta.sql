CREATE TABLE IF NOT EXISTS "mxik_classifier" (
	"mxik_code" varchar(17) PRIMARY KEY NOT NULL,
	"name" varchar(500) NOT NULL,
	"barcode" varchar(20),
	"group_name" varchar(255),
	"brand" varchar(255),
	"unit_name" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mxik_classifier_barcode_idx" ON "mxik_classifier" USING btree ("barcode");