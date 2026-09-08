/**
 * PLU export for the scale vendor's Windows software — "PLU Manager", the
 * Link32 engine Rongta ships with the RLS series (RLS1000/RLS1100).
 *
 * This is the second half of the scale integration: `weight-barcode.ts` reads
 * the labels the scale prints, this writes the catalogue the scale prints them
 * from. The shop's PC does the last hop (PLU Manager → network download), so
 * Pimpo only has to hand it a file it already knows how to open.
 *
 * The software's own File → Export writes a file named `.xls` that is not a
 * workbook at all: UTF-16LE with a BOM, tab-separated, CRLF-terminated. It
 * reads that same shape back through File → Import from Excel, so a
 * byte-compatible file is the whole integration — no TCP protocol, no vendor
 * SDK, no fixed-width TXP guessing.
 *
 * Every constant below was read off a real export (112 PLUs) rather than a
 * manual, including the parts a manual would not have told us:
 *   - `Barcode Type` is written WITHOUT a leading zero (`2`, not `02`)
 *   - numbers carry three decimals in a %6.3f field (`' 0.500'`, `'22.000'`)
 *   - the data rows stop one column short of the header (23 vs 24)
 * Reproducing those exactly is cheap and means the file round-trips.
 */

import {type ScaleBarcodeFormat} from '../common/weight-barcode';

/**
 * Header row, verbatim from a PLU Manager export — duplicate "Account" and the
 * untranslated "sPluFieldTitle20" included, because the import wizard maps
 * columns by position and a tidied-up header would only make ours differ from
 * the file the shop already has on disk.
 */
export const PLU_EXPORT_HEADER = [
  'Hotkey',
  'Name',
  'LFCode',
  'Code',
  'Barcode Type',
  'Unit Price',
  'Unit Weight',
  'Unit Amount',
  'Department',
  'PT Weight',
  'Shelf Time',
  'Pack Type',
  'Tare',
  'Error(%)',
  'Message1',
  'Message2',
  'Label',
  'Discount/Table',
  'Account',
  'sPluFieldTitle20',
  'Account',
  'Recommend days',
  'nutrition',
  'Ice(%)',
] as const;

/** `Unit Weight` code for kilograms (1:g, 2:10g, 3:100g, 4:kg, 5:oz, 6:lb …). */
const UNIT_WEIGHT_KG = '4';

/** Longest name a PLU record holds; the scale truncates anything past this. */
export const PLU_NAME_MAX = 36;

/** One weighed product on its way to the scale. */
export interface PluExportRow {
  /** `products.plu` — the number the operator presses, and what the label carries. */
  plu: number;
  /** `products.name`, truncated to what the record holds. */
  name: string;
  /** Selling price per kg, in the shop's currency. */
  price: number;
}

/** How a barcode layout is spelled in PLU Manager's own fields. */
export interface PluBarcodeCoding {
  /** `Barcode Type` column — the row of the vendor's barcode coding table. */
  barcodeType: number;
  /** `Department` column — the digits the label opens with. */
  department: string;
}

/**
 * Vendor barcode coding table, for layouts whose department code is the leading
 * TWO digits. Keyed by `${pluDigits}:${valueDigits}` for price layouts and
 * `${pluDigits}:${valueDigits}:${divisor}` for weight ones, since a weight
 * field of the same width means a different type at each scale factor.
 */
const CODING_2_DIGIT_DEPT = {
  price: {'6:4': 1, '5:5': 2, '4:6': 3, '3:7': 4},
  weight: {'6:4:1000': 5, '6:4:100': 6, '5:5:1000': 7, '5:5:10': 8, '5:5:1': 9},
} as const;

/** The same table for layouts whose department code is a single leading digit. */
const CODING_1_DIGIT_DEPT = {
  price: {'7:4': 21, '6:5': 22, '5:6': 23, '4:7': 24},
  weight: {
    '7:4:1000': 25,
    '7:4:100': 26,
    '6:5:1000': 27,
    '6:5:10': 28,
    '6:5:1': 29,
  },
} as const;

/**
 * Translate a Pimpo barcode layout into the `Barcode Type` + `Department` pair
 * PLU Manager stores, or null when the vendor's table has no row for it.
 *
 * The two sides describe the same label from opposite ends: Pimpo names the
 * field widths because it is reading labels, the scale names a table row
 * because it is printing them. Deriving one from the other (rather than asking
 * the shop to type a barcode type it has no way to look up) keeps the settings
 * page the single place a layout is described.
 *
 * A null here is not a bug — a shop running the 18-digit layouts, or a prefix
 * wider than two digits, genuinely has no export until someone extends the
 * table, and saying so beats writing a file the scale would mis-print.
 */
export function pluBarcodeCoding(
  format: ScaleBarcodeFormat,
): PluBarcodeCoding | null {
  const table =
    format.prefix.length === 2
      ? CODING_2_DIGIT_DEPT
      : format.prefix.length === 1
        ? CODING_1_DIGIT_DEPT
        : null;
  if (!table) return null;

  const key =
    format.mode === 'price'
      ? `${format.pluDigits}:${format.valueDigits}`
      : `${format.pluDigits}:${format.valueDigits}:${format.divisor || 1}`;

  const barcodeType = (table[format.mode] as Record<string, number>)[key];
  if (barcodeType === undefined) return null;

  return {barcodeType, department: format.prefix};
}

/**
 * A number as PLU Manager writes one: three decimals, right-aligned in six
 * characters, overflowing rather than truncating. `0.5` → `" 0.500"`,
 * `22` → `"22.000"`, `18000` → `"18000.000"`.
 */
function decimal(value: number): string {
  return value.toFixed(3).padStart(6, ' ');
}

/**
 * A name the tab-separated format can carry. Tabs and newlines would shift
 * every later column of the row into the wrong field, so they are collapsed to
 * spaces rather than escaped — the format has no escaping.
 */
function cleanName(name: string): string {
  return name.replace(/[\t\r\n]+/g, ' ').trim().slice(0, PLU_NAME_MAX);
}

/**
 * Build the file PLU Manager imports.
 *
 * Returns UTF-16LE bytes with a BOM, which is what makes the `.xls` name work:
 * Excel sniffs the BOM, opens it as a tab-delimited sheet, and the import
 * wizard reads it from there.
 */
export function buildPluExport(
  rows: PluExportRow[],
  coding: PluBarcodeCoding,
): Buffer {
  const barcodeType = String(coding.barcodeType);

  const lines = rows.map((row) => {
    const plu = String(row.plu);
    return [
      plu, // Hotkey — the export we copied keeps these three in step, and a
      cleanName(row.name), // hotkey that matches the PLU is one less number
      plu, // LFCode      for staff to memorise.
      plu, // Code — this is what the printed label actually carries.
      barcodeType,
      decimal(row.price),
      UNIT_WEIGHT_KG,
      '0', // Unit Amount
      coding.department,
      decimal(0), // PT Weight — no fixed-weight packages
      '15', // Shelf Time (days) — vendor default
      '0', // Pack Type — normal weighing
      decimal(0), // Tare — the scale's own tare key handles containers
      '0', // Error(%)
      '0', // Message1
      '0', // Message2
      '0', // Label — index 0, the layout designed in Label Editor
      '0', // Discount/Table
      '0', // Account
      '', // sPluFieldTitle20
      '0', // Account
      '0', // Recommend days
      '0', // nutrition
      // No 24th field: the vendor's own export stops here too.
    ].join('\t');
  });

  const text =
    [PLU_EXPORT_HEADER.join('\t'), ...lines].join('\r\n') + '\r\n';

  return Buffer.concat([
    Buffer.from([0xff, 0xfe]), // UTF-16LE BOM
    Buffer.from(text, 'utf16le'),
  ]);
}
