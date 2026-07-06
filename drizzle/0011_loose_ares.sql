CREATE TABLE IF NOT EXISTS "global_barcodes" (
	"barcode" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"category_name" varchar(255),
	"image" varchar(500),
	"source" varchar(50) DEFAULT 'community' NOT NULL,
	"times_used" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
