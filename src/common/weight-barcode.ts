/**
 * Weight-embedded barcode parsing for label-printing scales.
 *
 * A label scale (Rongta RLS, CAS, Digi …) prints its own barcode, and that
 * barcode does not identify a product the way a manufacturer's EAN-13 does. It
 * is a one-off message from the scale to the till:
 *
 *     2 2   0 1 2 3 4   0 0 5 0 0   5
 *     │     │           │           └ EAN-13 check digit
 *     │     │           └ value field: 500 → 0.500 kg (or a total price)
 *     │     └ the PLU the operator pressed on the scale
 *     └ prefix marking this as a scale label at all
 *
 * Field widths are not standardised — every scale lets the shop redraw them in
 * its own menu — so the layout is per-business configuration (`scale_settings`)
 * rather than a constant, and this module only reads a layout it is handed.
 *
 * GS1 reserves prefixes 20–29 for in-store codes, so a scale label can never
 * collide with a manufacturer's barcode. It CAN collide with an in-store
 * barcode the shop minted itself — Pimpo's own `generateBarcode` produces
 * "200…" codes — which is why the till resolves a scan against the catalogue
 * FIRST and only falls back to this parser on a miss.
 */

/** What the value field of a scale label carries. */
export type ScaleValueMode = 'weight' | 'price';

/** One barcode layout a business's scales are configured to print. */
export interface ScaleBarcodeFormat {
  /** Leading digits that mark a scale label, e.g. "22". */
  prefix: string;
  /** Width of the PLU field that follows the prefix. */
  pluDigits: number;
  /** Width of the value field that follows the PLU. */
  valueDigits: number;
  /** Whether the value is an amount or a line total. */
  mode: ScaleValueMode;
  /** Divides the raw value into kg (weight) or so'm (price). 1000 → grams. */
  divisor: number;
  /** Whether a trailing check/filler digit closes the code. */
  checkDigit: boolean;
}

/**
 * The layout used until a business describes its own.
 *
 * Not a textbook guess: read off a real Rongta RLS1100C in a shop here, from
 * two labels whose EAN-13 check digits both verify —
 *
 *     1000089004868  → PLU 89, 486 so'm  (0.270 kg at 1800/kg)
 *     1000096004776  → PLU 96, 477 so'm  (0.265 kg at 1800/kg)
 *
 * Note it carries the LINE TOTAL, not the weight, which is why `mode` is
 * 'price'. That makes the amount only as good as the price agreement between
 * scale and catalogue (see `labelQuantity` in product.service.ts), so a shop
 * whose scale can print weight instead is better off switching and saying so
 * on the settings page. The page's live tester is the authority either way.
 */
export const DEFAULT_SCALE_FORMAT: ScaleBarcodeFormat = {
  prefix: '10',
  pluDigits: 5,
  valueDigits: 5,
  mode: 'price',
  divisor: 1,
  checkDigit: true,
};

export interface ParsedWeightBarcode {
  /** The scale PLU — matched against `products.plu`. */
  plu: number;
  /** Amount in the product's unit (kg); null when the label carries a price. */
  weight: number | null;
  /** Line total in so'm; null when the label carries a weight. */
  price: number | null;
  /** The format that matched, so the caller can explain what it read. */
  format: ScaleBarcodeFormat;
}

/** Standard EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(twelveDigits: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = twelveDigits.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return ((10 - (sum % 10)) % 10).toString();
}

/** Total digit count a format produces. */
export function scaleFormatLength(format: ScaleBarcodeFormat): number {
  return (
    format.prefix.length +
    format.pluDigits +
    format.valueDigits +
    (format.checkDigit ? 1 : 0)
  );
}

/**
 * Cheap "could this be a scale label?" test — same digits-and-prefix screen the
 * parser opens with, without committing to a reading. The till uses it to route
 * a scan straight to the scan resolver instead of the name search.
 */
export function looksLikeScaleLabel(
  code: string,
  formats: ScaleBarcodeFormat[],
): boolean {
  const trimmed = code.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  return formats.some(
    (f) =>
      trimmed.length === scaleFormatLength(f) && trimmed.startsWith(f.prefix),
  );
}

/**
 * Read a scale label into its PLU and amount, or return null when the code is
 * not a label under any of the given formats.
 *
 * Formats are tried in order and the first structurally valid reading wins, so
 * a business that runs a weight format and a price format side by side should
 * keep their prefixes distinct — overlapping prefixes of the same width are
 * genuinely ambiguous and the earlier entry simply takes them.
 */
export function parseWeightBarcode(
  raw: string,
  formats: ScaleBarcodeFormat[],
): ParsedWeightBarcode | null {
  const code = raw.trim();
  if (!/^\d+$/.test(code)) return null;

  for (const format of formats) {
    if (code.length !== scaleFormatLength(format)) continue;
    if (!code.startsWith(format.prefix)) continue;

    // Only EAN-13 closes with a check digit we can verify. Wider in-store codes
    // (the 18-digit layouts) end in a filler digit instead, and checking that
    // would reject every valid label.
    if (format.checkDigit && code.length === 13) {
      if (code[12] !== ean13CheckDigit(code.slice(0, 12))) continue;
    }

    const pluStart = format.prefix.length;
    const valueStart = pluStart + format.pluDigits;
    const plu = Number(code.slice(pluStart, valueStart));
    const rawValue = Number(
      code.slice(valueStart, valueStart + format.valueDigits),
    );

    // An empty PLU field means the operator weighed without selecting an item;
    // a zero value means nothing was on the pan. Neither is a sellable line.
    if (!plu || rawValue <= 0) continue;

    const value = rawValue / (format.divisor || 1);

    return {
      plu,
      weight: format.mode === 'weight' ? value : null,
      price: format.mode === 'price' ? value : null,
      format,
    };
  }

  return null;
}
