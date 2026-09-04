import {parseScannedCode} from './gs1';

describe('parseScannedCode', () => {
  it('passes a plain EAN-13 through untouched', () => {
    const r = parseScannedCode('4780051070066');
    expect(r.isGs1).toBe(false);
    expect(r.gtin).toBeNull();
    expect(r.candidates).toEqual(['4780051070066']);
  });

  it('extracts the GTIN and serial from a marking DataMatrix', () => {
    const r = parseScannedCode('010478005107006621A7X9K2M4P');
    expect(r.isGs1).toBe(true);
    expect(r.gtin).toBe('04780051070066');
    expect(r.serial).toBe('A7X9K2M4P');
    // The EAN-13 the catalogue actually stores comes first.
    expect(r.candidates).toContain('4780051070066');
  });

  it('stops the serial at a group separator', () => {
    const r = parseScannedCode('010478005107006621A7X9K2M4P\x1d91EE06\x1dsomething');
    expect(r.serial).toBe('A7X9K2M4P');
  });

  it('strips a symbology identifier', () => {
    const r = parseScannedCode(']d2010478005107006621A7X9K2M4P');
    expect(r.gtin).toBe('04780051070066');
  });

  it('strips a leading literal FNC1', () => {
    const r = parseScannedCode('\x1d010478005107006621ABC');
    expect(r.gtin).toBe('04780051070066');
  });

  it('caps the serial at the GS1 limit of 20 characters', () => {
    const r = parseScannedCode(`010478005107006621${'X'.repeat(30)}`);
    expect(r.serial).toHaveLength(20);
  });

  it('handles a GTIN with no serial element', () => {
    const r = parseScannedCode('0104780051070066');
    expect(r.gtin).toBe('04780051070066');
    expect(r.serial).toBeNull();
  });

  it('expands a UPC-A GTIN down to 12 digits', () => {
    // UPC-A 036000291452 is padded to GTIN-14 as "00036000291452".
    const r = parseScannedCode('0100036000291452');
    expect(r.gtin).toBe('00036000291452');
    expect(r.candidates).toEqual([
      '00036000291452',
      '0036000291452', // the EAN-13 rendering of the same UPC
      '036000291452',
    ]);
  });

  it('keeps meaningful leading digits on a case GTIN', () => {
    const r = parseScannedCode('0114780051070066');
    expect(r.gtin).toBe('14780051070066');
    // "1" is the packaging indicator, not padding — nothing shorter is implied.
    expect(r.candidates).toEqual(['14780051070066']);
  });

  it('expands a bare 14-digit scan the same way', () => {
    const r = parseScannedCode('04780051070066');
    expect(r.isGs1).toBe(false);
    expect(r.candidates).toContain('4780051070066');
  });

  it('does not mistake a short code starting with 01 for GS1', () => {
    const r = parseScannedCode('0123456789');
    expect(r.isGs1).toBe(false);
    expect(r.candidates).toEqual(['0123456789']);
  });

  it('falls back to a plain code when the GTIN slot is not numeric', () => {
    const r = parseScannedCode('01ABCDEFGHIJKLMN21X');
    expect(r.isGs1).toBe(false);
    expect(r.gtin).toBeNull();
  });

  it('trims surrounding whitespace from a wedge scanner', () => {
    expect(parseScannedCode('  4780051070066\n').candidates).toEqual([
      '4780051070066',
    ]);
  });
});
