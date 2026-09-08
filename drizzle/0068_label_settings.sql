-- Price-tag / barcode label layout ("Etiketka"), one row per business.
--
-- A shop prints shelf labels on a thermal label printer (Xprinter 365B and the
-- like); the roll it loaded decides the layout. The row holds the label stock
-- in millimetres plus what is allowed on it, and the frontend renders both the
-- live preview and the printout from it. A business with no row prints on the
-- defaults below, so nothing has to be backfilled.
CREATE TABLE IF NOT EXISTS "label_settings" (
  "business_id" varchar(36) PRIMARY KEY NOT NULL
    REFERENCES "businesses"("id") ON DELETE CASCADE,
  "width_mm" integer NOT NULL DEFAULT 58,
  "height_mm" integer NOT NULL DEFAULT 40,
  "padding_mm" integer NOT NULL DEFAULT 2,
  "show_store_name" boolean NOT NULL DEFAULT false,
  "show_name" boolean NOT NULL DEFAULT true,
  "name_lines" integer NOT NULL DEFAULT 2,
  "show_price" boolean NOT NULL DEFAULT true,
  "show_code" boolean NOT NULL DEFAULT false,
  "show_barcode_text" boolean NOT NULL DEFAULT true,
  "barcode_height_mm" integer NOT NULL DEFAULT 12,
  "font_scale" integer NOT NULL DEFAULT 100,
  "copies" integer NOT NULL DEFAULT 1,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
