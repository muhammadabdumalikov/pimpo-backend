import {
  DEFAULT_SCALE_FORMAT,
  ean13CheckDigit,
  looksLikeScaleLabel,
  parseWeightBarcode,
  scaleFormatLength,
  type ScaleBarcodeFormat,
} from './weight-barcode';

// A weight-mode layout, declared here rather than taken from the shipped
// default: these tests are about how a weight label is read, and must keep
// meaning that even when the default changes to match real hardware.
const WEIGHT_FORMAT: ScaleBarcodeFormat = {
  prefix: '22',
  pluDigits: 5,
  valueDigits: 5,
  mode: 'weight',
  divisor: 1000,
  checkDigit: true,
};
const DEFAULTS = [WEIGHT_FORMAT];

// Builds a well-formed label for that layout, so a test can say what it means
// ("PLU 1234, 500 g") instead of spelling out digits.
function label(plu: number, grams: number): string {
  const body =
    WEIGHT_FORMAT.prefix +
    String(plu).padStart(WEIGHT_FORMAT.pluDigits, '0') +
    String(grams).padStart(WEIGHT_FORMAT.valueDigits, '0');
  return body + ean13CheckDigit(body);
}

describe('ean13CheckDigit', () => {
  it('computes the standard EAN-13 check digit', () => {
    expect(ean13CheckDigit('220123400500')).toBe('9');
    expect(ean13CheckDigit('978020137962')).toBe('4');
  });
});

describe('parseWeightBarcode', () => {
  it('reads PLU and weight out of a default-format label', () => {
    // 22 | 01234 | 00500 | 9 → PLU 1234 weighing 0.500 kg.
    const parsed = parseWeightBarcode('2201234005009', DEFAULTS);
    expect(parsed).toMatchObject({plu: 1234, weight: 0.5, price: null});
  });

  it('agrees with a label built from the format itself', () => {
    expect(parseWeightBarcode(label(1234, 500), DEFAULTS)?.weight).toBe(0.5);
    expect(parseWeightBarcode(label(7, 2340), DEFAULTS)).toMatchObject({
      plu: 7,
      weight: 2.34,
    });
  });

  it('rejects a label whose check digit does not add up', () => {
    expect(parseWeightBarcode('2201234005000', DEFAULTS)).toBeNull();
  });

  it("leaves a manufacturer's barcode alone", () => {
    expect(parseWeightBarcode('4780051070066', DEFAULTS)).toBeNull();
  });

  it('ignores non-numeric and wrong-length scans', () => {
    expect(parseWeightBarcode('PRD-0042', DEFAULTS)).toBeNull();
    expect(parseWeightBarcode('220123400500', DEFAULTS)).toBeNull();
    expect(parseWeightBarcode('', DEFAULTS)).toBeNull();
  });

  it('refuses a label with no PLU or nothing on the pan', () => {
    expect(parseWeightBarcode(label(0, 500), DEFAULTS)).toBeNull();
    expect(parseWeightBarcode(label(1234, 0), DEFAULTS)).toBeNull();
  });

  it('reads a price-mode label as a line total, not an amount', () => {
    const priceFormat: ScaleBarcodeFormat = {
      ...WEIGHT_FORMAT,
      prefix: '23',
      mode: 'price',
      divisor: 1,
    };
    const body = '23' + '01234' + '12500';
    const parsed = parseWeightBarcode(body + ean13CheckDigit(body), [
      priceFormat,
    ]);
    expect(parsed).toMatchObject({plu: 1234, weight: null, price: 12500});
  });

  it('reads an 18-digit layout, where the trailing digit is not a check digit', () => {
    const wide: ScaleBarcodeFormat = {
      prefix: '39',
      pluDigits: 6,
      valueDigits: 9,
      mode: 'price',
      divisor: 100,
      checkDigit: true,
    };
    expect(scaleFormatLength(wide)).toBe(18);
    // 39 | 001234 | 000012500 | 0 → PLU 1234, 125.00 so'm. The final 0 would
    // fail an EAN-13 check; at this width there is nothing to check.
    expect(parseWeightBarcode('390012340000125000', [wide])).toMatchObject({
      plu: 1234,
      price: 125,
    });
  });

  it('takes the first matching format when several are configured', () => {
    const price: ScaleBarcodeFormat = {
      ...WEIGHT_FORMAT,
      prefix: '23',
      mode: 'price',
      divisor: 1,
    };
    const parsed = parseWeightBarcode(label(1234, 500), [price, WEIGHT_FORMAT]);
    expect(parsed?.weight).toBe(0.5);
  });

  // Pimpo mints its own in-store barcodes with a "200" prefix, which lands
  // inside the 20–29 range scales print into. Configuring a "20" prefix
  // therefore makes every internally generated barcode readable as a label —
  // the reason the scan resolver matches the catalogue before it parses.
  it('cannot tell a "20"-prefixed in-store barcode from a label', () => {
    const twenty: ScaleBarcodeFormat = {...WEIGHT_FORMAT, prefix: '20'};
    const generated = '200' + '123456789';
    const parsed = parseWeightBarcode(
      generated + ean13CheckDigit(generated),
      [twenty],
    );
    expect(parsed).not.toBeNull();
  });
});

describe('looksLikeScaleLabel', () => {
  it('accepts what the parser accepts, by shape alone', () => {
    expect(looksLikeScaleLabel(label(1234, 500), DEFAULTS)).toBe(true);
    // Right shape, bad check digit — the cheap screen lets it through and the
    // parser is what rejects it.
    expect(looksLikeScaleLabel('2201234005000', DEFAULTS)).toBe(true);
  });

  it('rejects other codes', () => {
    expect(looksLikeScaleLabel('4780051070066', DEFAULTS)).toBe(false);
    expect(looksLikeScaleLabel('PRD-0042', DEFAULTS)).toBe(false);
  });
});

// The field widths are not a guess — they were read off a Rongta RLS1100C in a
// shop, from labels whose check digits verify. These are that evidence, kept as
// a test so the layout can never drift away from the machine it describes.
//
// Declared with the prefix the machine actually shipped on (10) rather than
// taken from DEFAULT_SCALE_FORMAT: the default deliberately moved to a GS1
// in-store prefix (see the constant), and these labels are about whether the
// parser reads real hardware, not about which prefix we ship.
const OBSERVED_FORMAT: ScaleBarcodeFormat = {
  ...DEFAULT_SCALE_FORMAT,
  prefix: '10',
};

describe('real Rongta RLS1100C labels', () => {
  const DEFAULTS_REAL = [OBSERVED_FORMAT];
  const PRICE_PER_KG = 1800;

  it.each([
    ['1000089004868', 89, 486, 0.27],
    ['1000096004776', 96, 477, 0.265],
    // A heavy weigh-out: proves the value field really is five digits wide
    // (09801 keeps its leading zero) and that PLU 89 lands in the same place
    // whatever the total.
    ['1000089098010', 89, 9801, 5.445],
  ])('reads %s as PLU %i for %i so\'m', (code, plu, price, kg) => {
    const parsed = parseWeightBarcode(code as string, DEFAULTS_REAL);
    expect(parsed).toMatchObject({plu, price, weight: null});
    // The till recovers the amount by dividing; these labels must land exactly
    // on the weight the scale showed, with no rounding drift.
    expect(Math.round(((parsed!.price as number) / PRICE_PER_KG) * 1000) / 1000).toBe(kg);
  });

  it('is 13 digits, so the check digit is actually enforced', () => {
    expect(scaleFormatLength(OBSERVED_FORMAT)).toBe(13);
    // Same label, last digit nudged: a misread must not reach the cart.
    expect(parseWeightBarcode('1000089004860', DEFAULTS_REAL)).toBeNull();
  });

  it('leaves ordinary barcodes alone', () => {
    for (const code of ['4780051070066', '2001234567890', '1000089004868'.slice(1)]) {
      expect(parseWeightBarcode(code, DEFAULTS_REAL)).toBeNull();
    }
  });
});

describe('DEFAULT_SCALE_FORMAT', () => {
  it('keeps the widths read off the real machine', () => {
    // Only the prefix was allowed to move; a shop adopting the default still
    // gets the layout its hardware prints.
    expect(DEFAULT_SCALE_FORMAT).toMatchObject({
      pluDigits: OBSERVED_FORMAT.pluDigits,
      valueDigits: OBSERVED_FORMAT.valueDigits,
      mode: OBSERVED_FORMAT.mode,
      divisor: OBSERVED_FORMAT.divisor,
      checkDigit: OBSERVED_FORMAT.checkDigit,
    });
    expect(scaleFormatLength(DEFAULT_SCALE_FORMAT)).toBe(13);
  });

  it('sits in a GS1 restricted-circulation range', () => {
    // The whole point of the prefix change. 200-299 is reserved for in-store
    // codes, so a default label can never be some manufacturer's real GTIN —
    // which, on a catalogue miss, would resolve to the wrong product.
    const first3 = Number(DEFAULT_SCALE_FORMAT.prefix.padEnd(3, '0'));
    const last3 = Number(DEFAULT_SCALE_FORMAT.prefix.padEnd(3, '9'));
    expect(first3).toBeGreaterThanOrEqual(200);
    expect(last3).toBeLessThanOrEqual(299);
  });

  it('does not shadow the "200" barcodes Pimpo mints itself', () => {
    // Both live in 20-29; overlapping heads would make an in-store barcode and
    // a scale label indistinguishable by shape.
    expect(DEFAULT_SCALE_FORMAT.prefix.startsWith('200')).toBe(false);
    expect('200'.startsWith(DEFAULT_SCALE_FORMAT.prefix)).toBe(false);
  });
});
