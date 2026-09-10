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

/** The shapes this catalogue can be handed to the shop in. */
export type PluExportFormat = 'xls' | 'txt' | 'txp';

/** Download name and content type per format. */
export const PLU_EXPORT_FILES: Record<
  PluExportFormat,
  {filename: string; contentType: string}
> = {
  xls: {filename: 'pimpo-plu.xls', contentType: 'application/vnd.ms-excel'},
  txt: {filename: 'pimpo-plu.txt', contentType: 'text/plain; charset=utf-16le'},
  txp: {filename: 'pimpo-plu.txp', contentType: 'text/plain; charset=utf-8'},
};

/**
 * Build the catalogue file, in whichever shape the shop's workflow needs.
 *
 * `xls` and `txt` are the SAME bytes under different names — the vendor's own
 * tab-separated export. The name is not cosmetic: only `.xls` opens in Excel on
 * a double click, which is the one thing PLU Manager's "Import from Excel"
 * requires. `.txt` is for reading the file, or for feeding it somewhere else.
 *
 * `txp` is a different format entirely — the fixed-width record PLU Manager
 * opens directly through File → Open PLU file, no Excel in the loop.
 */
export function buildPluExport(
  rows: PluExportRow[],
  coding: PluBarcodeCoding,
  format: PluExportFormat = 'xls',
): Buffer {
  return format === 'txp' ? buildTxp(rows, coding) : buildTsv(rows, coding);
}

/**
 * The vendor's tab-separated export.
 *
 * Returns UTF-16LE bytes with a BOM, which is what makes the `.xls` name work:
 * Excel sniffs the BOM, opens it as a tab-delimited sheet, and the import
 * wizard reads it from there.
 */
function buildTsv(rows: PluExportRow[], coding: PluBarcodeCoding): Buffer {
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

/**
 * Column widths of one TXP record, in the order Appendix I lists them. Every
 * field is right-aligned in its width with a single space after it, and the
 * record closes with CRLF — 101 bytes of columns plus their 18 spaces, so 119
 * bytes a line.
 */
const TXP_WIDTHS = {
  pluNo: 4,
  name: 36,
  lfCode: 6,
  code: 10,
  barcodeType: 2,
  unitPrice: 8,
  weightUnit: 1,
  department: 2,
  tare: 6,
  shelfTime: 3,
  packageType: 1,
  packageWeight: 6,
  tolerance: 2,
  message1: 3,
  message2: 3,
  multiLabel: 3,
  rebate: 3,
  pcsType: 2,
} as const;

/** Longest prefix of `value` that still fits `max` UTF-8 bytes. */
function truncateToBytes(value: string, max: number): string {
  if (Buffer.byteLength(value) <= max) return value;
  let out = '';
  for (const ch of value) {
    if (Buffer.byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/**
 * Right-align into a fixed column, measured in BYTES rather than characters.
 * A fixed-width reader counts bytes, so a name carrying anything outside ASCII
 * would otherwise push every later field along and the record would be read as
 * a different product entirely.
 */
function padBytes(value: string, width: number): string {
  const text = truncateToBytes(value, width);
  return ' '.repeat(width - Buffer.byteLength(text)) + text;
}

/**
 * The fixed-width PLU record PLU Manager opens directly (File → Open PLU file).
 *
 * ⚠️ Unlike the tab-separated export, this layout comes from the vendor's
 * manual rather than from a file the software itself wrote, so it has not been
 * round-tripped against real output. Check it against the `demo.txp` shipped in
 * the software's own Demos folder before loading a full catalogue.
 *
 * Note the price is written differently here: an integer with implied decimals
 * ("12.34" is stored as 1234), not the three-decimal field the spreadsheet
 * uses. That means it depends on the software's "System decimal position"
 * being 0 — which is what a so'm catalogue wants anyway.
 */
function buildTxp(rows: PluExportRow[], coding: PluBarcodeCoding): Buffer {
  const w = TXP_WIDTHS;

  const lines = rows.map((row, i) =>
    (
      [
        // "It is reserved to be compatible with old version and has no real
        // meaning" — the operator presses Code, not this.
        [String(i + 1), w.pluNo],
        [cleanName(row.name), w.name],
        ['0', w.lfCode],
        [String(row.plu), w.code], // what the printed label carries
        [String(coding.barcodeType), w.barcodeType],
        [String(Math.round(row.price)), w.unitPrice],
        [UNIT_WEIGHT_KG, w.weightUnit],
        [coding.department, w.department],
        ['0', w.tare], // the scale's own tare key handles containers
        ['15', w.shelfTime], // days, vendor default
        ['0', w.packageType], // normal weighing
        ['0', w.packageWeight],
        ['5', w.tolerance], // vendor default
        ['0', w.message1],
        ['0', w.message2],
        ['0', w.multiLabel],
        ['0', w.rebate],
        ['0', w.pcsType],
      ] as [string, number][]
    )
      .map(([value, width]) => padBytes(value, width))
      // A space after EVERY column, the last one included.
      .join(' ') + ' ',
  );

  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}
