import {SQL, sql} from 'drizzle-orm';
import type {AnyColumn} from 'drizzle-orm';

/**
 * Whether a barcode names the same product in every shop — so it may feed and
 * read the shared catalogue (global_barcodes).
 *
 * Only manufacturer GTINs do. GS1 reserves "restricted circulation" ranges for
 * codes a shop or a system mints for itself, and those repeat from shop to
 * shop: Pimpo's own "200…" codes are random but only unique within a shop, and
 * other tills, Billz imports and label scales number from 2000000000017 up. A
 * shared picture or name on such a code would land on another shop's
 * unrelated product.
 *
 * Restricted, as an EAN-13 (UPC-A gets a leading 0, GTIN-14 drops its packing
 * digit): 020–029, 040–049, 200–299. EAN-8: leading 0 or 2. Anything that is
 * not 8/12/13/14 digits (internal SKUs, short codes) is the shop's own too.
 */
export function isSharedBarcode(
  raw: string | null | undefined,
): raw is string {
  const code = (raw ?? '').trim();
  if (/^\d{8}$/.test(code)) return !/^[02]/.test(code);
  if (!/^\d{12,14}$/.test(code)) return false;
  const ean13 =
    code.length === 12 ? `0${code}` : code.length === 14 ? code.slice(1) : code;
  return !/^(02|04|2)/.test(ean13);
}

/** The same test in SQL, for queries that join global_barcodes. */
export function sharedBarcodeSql(column: AnyColumn | SQL): SQL {
  return sql`(
    (${column} ~ '^[0-9]{8}$' AND ${column} !~ '^[02]')
    OR (${column} ~ '^[0-9]{12,14}$' AND (CASE length(${column})
          WHEN 12 THEN '0' || ${column}
          WHEN 14 THEN substr(${column}, 2)
          ELSE ${column} END) !~ '^(02|04|2)')
  )`;
}
