/**
 * Scanned-code parsing for the till.
 *
 * A plain retail barcode (EAN-13) says WHICH PRODUCT. An "Asl belgi" marking
 * DataMatrix — mandatory on drinks, tobacco, medicines and other marked goods —
 * says WHICH INDIVIDUAL ITEM, and carries the barcode inside it as a GS1
 * element string:
 *
 *     01 04780051070066 21 A7X9K2M4P ...
 *     │  └ GTIN-14 (= the EAN-13 with a leading 0)
 *     └ AI 01          └ AI 21, the per-item serial
 *
 * Scanning that raw string against `products.barcode` never matches, so a till
 * without this parser simply reports "no product for code" for every marked
 * bottle in the shop.
 *
 * This is deliberately NOT a full GS1 parser. Without the GS separators (many
 * scanners strip them) variable-length AIs are ambiguous, and guessing wrong
 * would be worse than not guessing. We extract only what the till needs — the
 * GTIN, which is fixed-length and unambiguous, plus the serial when it is the
 * next element — and leave everything else alone.
 */

/** ASCII group separator: the GS1 field terminator for variable-length AIs. */
const GS = '\x1d';

export interface ScannedCode {
  /** The scan exactly as it arrived. */
  raw: string;
  /** True when the scan was a GS1 element string, not a bare barcode. */
  isGs1: boolean;
  /** 14-digit GTIN from AI 01, when present. */
  gtin: string | null;
  /**
   * AI 21 serial — identifies this one physical item. Needed later to report
   * the item as sold to the marking system and to put it on the fiscal receipt
   * line; nothing consumes it yet.
   */
  serial: string | null;
  /**
   * Barcode forms to try against `products.barcode`, most likely first. A GTIN
   * is zero-padded to 14, so the same item can be catalogued as EAN-13, UPC-A
   * or EAN-8 depending on where the barcode was typed in from.
   */
  candidates: string[];
}

/**
 * Expands a GTIN-14 into the shorter forms it may be stored as. Only strips a
 * prefix that is entirely zeros — "04780051070066" yields "4780051070066", but
 * "14780051070066" (a case/pallet GTIN) yields nothing shorter, because those
 * digits are meaningful.
 */
function barcodeCandidates(gtin: string): string[] {
  const out = [gtin];
  for (const length of [13, 12, 8]) {
    const prefixLength = gtin.length - length;
    if (prefixLength > 0 && /^0+$/.test(gtin.slice(0, prefixLength))) {
      out.push(gtin.slice(prefixLength));
    }
  }
  return [...new Set(out)];
}

export function parseScannedCode(input: string): ScannedCode {
  const raw = input.trim();

  // Scanners may prefix a symbology identifier (]d2 DataMatrix, ]C1 GS1-128,
  // ]Q3 QR) and/or emit the leading FNC1 as a literal GS.
  const body = raw.replace(/^\][A-Za-z]\d/, '').replace(/^\x1d+/, '');

  const plain = (): ScannedCode => ({
    raw,
    isGs1: false,
    gtin: null,
    serial: null,
    // A bare 14-digit scan is still a GTIN and deserves the same expansion.
    candidates: /^\d{14}$/.test(raw) ? barcodeCandidates(raw) : [raw],
  });

  if (!body.startsWith('01') || body.length < 16) return plain();

  const gtin = body.slice(2, 16);
  if (!/^\d{14}$/.test(gtin)) return plain();

  // The serial is only read when AI 21 follows the GTIN directly — the common
  // Asl belgi layout. Anywhere else it would need full AI-table parsing.
  let serial: string | null = null;
  const rest = body.slice(16);
  if (rest.startsWith('21')) {
    const after = rest.slice(2);
    const end = after.indexOf(GS);
    // GS1 caps AI 21 at 20 characters.
    serial = (end >= 0 ? after.slice(0, end) : after).slice(0, 20) || null;
  }

  return {raw, isGs1: true, gtin, serial, candidates: barcodeCandidates(gtin)};
}
