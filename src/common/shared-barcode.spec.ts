import {isSharedBarcode} from './shared-barcode';

describe('isSharedBarcode', () => {
  it.each([
    ['4780000000007', true], // Uzbekistan GS1 (478)
    ['5449000000996', true], // Coca-Cola EAN-13
    ['012345678905', true], // UPC-A → 0012345678905
    ['96385074', true], // EAN-8
    ['14780000000004', true], // GTIN-14 → 4780000000004
  ])('%s is a manufacturer code', (code, ok) => {
    expect(isSharedBarcode(code)).toBe(ok);
  });

  it.each([
    '2001234567893', // Pimpo's own in-store code
    '2000000000017', // another system's in-store numbering
    '2912345000007', // scale label range
    '0212345678900', // 020–029 restricted
    '0412345678906', // 040–049 restricted
    '212345678906', // UPC-A number system 2 (random weight)
    '412345678903', // UPC-A number system 4 (in-store)
    '02345673', // EAN-8 leading 0
    '20123451', // EAN-8 leading 2
    'SKU-001',
    '12345',
    '',
  ])('%s stays in its shop', (code) => {
    expect(isSharedBarcode(code)).toBe(false);
  });

  it('treats null as not shared', () => {
    expect(isSharedBarcode(null)).toBe(false);
  });
});
