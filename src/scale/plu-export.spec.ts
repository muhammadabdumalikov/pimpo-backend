import {
  DEFAULT_SCALE_FORMAT,
  type ScaleBarcodeFormat,
} from '../common/weight-barcode';
import {
  PLU_EXPORT_HEADER,
  PLU_NAME_MAX,
  buildPluExport,
  pluBarcodeCoding,
} from './plu-export';

// The shape a genuine PLU Manager export has on disk (rlsexcel.xls, 112 PLUs
// from the vendor's own File → Export). Every assertion about layout below is
// checking we still match that file, not a manual.
const REAL_EXPORT = {
  headerColumns: 24,
  dataColumns: 23,
  // "Chinese cabbage", PLU 1, 0.9 per kg, department 21, barcode type 2.
  sampleRow:
    '1\tChinese cabbage\t1\t1\t2\t 0.900\t4\t0\t21\t 0.000\t15\t0\t 0.000\t0\t0\t0\t0\t0\t0\t\t0\t0\t0',
};

/** Decode what the endpoint actually sends back into inspectable lines. */
function readBack(file: Buffer): {bom: Buffer; lines: string[]} {
  const bom = file.subarray(0, 2);
  const text = file.subarray(2).toString('utf16le');
  // Trailing CRLF closes the last record, so the split leaves an empty tail.
  const lines = text.split('\r\n');
  expect(lines.pop()).toBe('');
  return {bom, lines};
}

/** The layout the shop's own scale prints — prefix 10, price-mode, 5+5. */
const OBSERVED_FORMAT: ScaleBarcodeFormat = {
  ...DEFAULT_SCALE_FORMAT,
  prefix: '10',
};

const CODING = {barcodeType: 2, department: '10'};

describe('pluBarcodeCoding', () => {
  it('maps the shop’s live layout to barcode type 02, department 10', () => {
    // The layout the shop's RLS1100C actually shipped on: prefix 10, 5-digit
    // PLU, 5-digit total price. In the vendor's coding table that is row 02
    // (DD + IIIII + PPPPP + C) with the leading "10" as the department. The
    // shipped default has since moved off prefix 10 for GS1 reasons, but a
    // shop still running it has to export correctly.
    expect(pluBarcodeCoding(OBSERVED_FORMAT)).toEqual({
      barcodeType: 2,
      department: '10',
    });
  });

  it('maps the shipped default to type 02, department 22', () => {
    expect(pluBarcodeCoding(DEFAULT_SCALE_FORMAT)).toEqual({
      barcodeType: 2,
      department: '22',
    });
  });

  it('maps the same widths in weight mode to type 07', () => {
    // This is the pair that matters: switching the scale to print weight keeps
    // every field width and only moves the coding table row, so the migration
    // is one setting on each side rather than a re-layout.
    const weight: ScaleBarcodeFormat = {
      ...OBSERVED_FORMAT,
      mode: 'weight',
      divisor: 1000,
    };
    expect(pluBarcodeCoding(weight)).toEqual({
      barcodeType: 7,
      department: '10',
    });
  });

  it('reads a single-digit prefix as a one-digit department', () => {
    const format: ScaleBarcodeFormat = {
      prefix: '2',
      pluDigits: 6,
      valueDigits: 5,
      mode: 'price',
      divisor: 1,
      checkDigit: true,
    };
    expect(pluBarcodeCoding(format)).toEqual({
      barcodeType: 22,
      department: '2',
    });
  });

  it('refuses a layout the vendor’s table has no row for', () => {
    // An 18-digit in-store layout: real hardware, but not something this file
    // format can describe. Better to fail the download than to write a file
    // whose labels would come out unreadable.
    const wide: ScaleBarcodeFormat = {
      prefix: '220',
      pluDigits: 6,
      valueDigits: 5,
      mode: 'price',
      divisor: 1,
      checkDigit: false,
    };
    expect(pluBarcodeCoding(wide)).toBeNull();
  });

  it('refuses a value width the table cannot carry', () => {
    const odd: ScaleBarcodeFormat = {
      ...DEFAULT_SCALE_FORMAT,
      valueDigits: 3,
    };
    expect(pluBarcodeCoding(odd)).toBeNull();
  });
});

describe('buildPluExport', () => {
  const rows = [
    {plu: 89, name: 'Kartoshka', price: 1800},
    {plu: 96, name: 'Piyoz', price: 1800},
  ];

  it('opens with a UTF-16LE BOM', () => {
    // This byte pair is what makes the .xls name work: Excel sniffs it, opens
    // the file as a tab-delimited sheet, and PLU Manager imports from there.
    const {bom} = readBack(buildPluExport(rows, CODING));
    expect([...bom]).toEqual([0xff, 0xfe]);
  });

  it('writes the vendor’s header verbatim', () => {
    const {lines} = readBack(buildPluExport(rows, CODING));
    expect(lines[0].split('\t')).toEqual([...PLU_EXPORT_HEADER]);
    expect(lines[0].split('\t')).toHaveLength(REAL_EXPORT.headerColumns);
  });

  it('stops data rows one column short of the header, as the vendor does', () => {
    // Not a bug being copied for its own sake — the import wizard maps by
    // position, and the file we round-trip against ends at "nutrition".
    const {lines} = readBack(buildPluExport(rows, CODING));
    expect(REAL_EXPORT.sampleRow.split('\t')).toHaveLength(
      REAL_EXPORT.dataColumns,
    );
    for (const line of lines.slice(1)) {
      expect(line.split('\t')).toHaveLength(REAL_EXPORT.dataColumns);
    }
  });

  it('reproduces a real row field for field', () => {
    const file = buildPluExport(
      [{plu: 1, name: 'Chinese cabbage', price: 0.9}],
      {barcodeType: 2, department: '21'},
    );
    const {lines} = readBack(file);
    expect(lines[1]).toBe(REAL_EXPORT.sampleRow);
  });

  it('puts the PLU in the field the printed label carries', () => {
    // Hotkey / LFCode / Code all hold it, matching the vendor export, but Code
    // is the one that ends up between the department digits and the price.
    const {lines} = readBack(buildPluExport(rows, CODING));
    const fields = lines[1].split('\t');
    expect(fields[0]).toBe('89'); // Hotkey
    expect(fields[2]).toBe('89'); // LFCode
    expect(fields[3]).toBe('89'); // Code
  });

  it('writes prices in the vendor’s %6.3f field', () => {
    const file = buildPluExport(
      [
        {plu: 1, name: 'Under ten', price: 0.5},
        {plu: 2, name: 'Two digits', price: 22},
        {plu: 3, name: 'So‘m', price: 18000},
      ],
      CODING,
    );
    const {lines} = readBack(file);
    // Right-aligned in six characters, overflowing rather than truncating —
    // so'm prices simply run wider than the yuan ones in the sample file.
    expect(lines[1].split('\t')[5]).toBe(' 0.500');
    expect(lines[2].split('\t')[5]).toBe('22.000');
    expect(lines[3].split('\t')[5]).toBe('18000.000');
  });

  it('writes the barcode type without a leading zero', () => {
    // The vendor's own export says "2", not "02". Padding it would make our
    // file differ from the one the shop already has, for no gain.
    const {lines} = readBack(buildPluExport(rows, CODING));
    expect(lines[1].split('\t')[4]).toBe('2');
    expect(lines[1].split('\t')[8]).toBe('10'); // department keeps its width
  });

  it('marks every row as sold by the kilogram', () => {
    const {lines} = readBack(buildPluExport(rows, CODING));
    expect(lines[1].split('\t')[6]).toBe('4');
  });

  it('flattens tabs and newlines in a name instead of shifting the row', () => {
    // The format has no escaping, so a stray tab would push the price into the
    // unit-weight column and the scale would print nonsense.
    const {lines} = readBack(
      buildPluExport([{plu: 1, name: 'Olma\tqizil\nnavi', price: 5}], CODING),
    );
    const fields = lines[1].split('\t');
    expect(fields).toHaveLength(REAL_EXPORT.dataColumns);
    expect(fields[1]).toBe('Olma qizil navi');
  });

  it('truncates a name to what the PLU record holds', () => {
    const long = 'A'.repeat(PLU_NAME_MAX + 20);
    const {lines} = readBack(
      buildPluExport([{plu: 1, name: long, price: 5}], CODING),
    );
    expect(lines[1].split('\t')[1]).toHaveLength(PLU_NAME_MAX);
  });

  it('gives .txt the same bytes as .xls — only the name differs', () => {
    // The two are one file under two names: .xls is what Excel opens on a
    // double click, .txt is for reading it. A divergence here would mean the
    // shop imported something different from what they inspected.
    expect(buildPluExport(rows, CODING, 'txt')).toEqual(
      buildPluExport(rows, CODING, 'xls'),
    );
  });

  it('terminates every record with CRLF, including the last', () => {
    const text = buildPluExport(rows, CODING).subarray(2).toString('utf16le');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.split('\r\n')).toHaveLength(rows.length + 2); // header + tail
  });
});

describe('buildPluExport — TXP', () => {
  const rows = [
    {plu: 89, name: 'Kartoshka', price: 1800},
    {plu: 96, name: 'Piyoz', price: 1800},
  ];

  /** TXP is plain bytes, not UTF-16 — read it back as the records it is. */
  const records = (file: Buffer) => {
    const text = file.toString('utf8');
    expect(text.endsWith('\r\n')).toBe(true);
    return text.slice(0, -2).split('\r\n');
  };

  it('writes one fixed-width 119-byte record per product', () => {
    // 101 bytes of columns plus one space after each of the 18 of them.
    const lines = records(buildPluExport(rows, CODING, 'txp'));
    expect(lines).toHaveLength(rows.length);
    for (const line of lines) expect(Buffer.byteLength(line)).toBe(119);
  });

  it('right-aligns every column and closes each with a space', () => {
    const [first] = records(buildPluExport(rows, CODING, 'txp'));
    expect(first.startsWith('   1 ')).toBe(true); // PLU No., width 4
    expect(first.endsWith(' ')).toBe(true);
    // Name occupies bytes 5-40, right-aligned inside its 36.
    expect(first.slice(5, 41)).toBe('Kartoshka'.padStart(36, ' '));
  });

  it('writes the price as an integer, not the spreadsheet’s decimals', () => {
    // TXP stores implied decimals ("12.34" → 1234); with the software's
    // decimal position at 0 a so'm price goes in as itself.
    const [first] = records(buildPluExport(rows, CODING, 'txp'));
    expect(first.slice(63, 71)).toBe('1800'.padStart(8, ' '));
  });

  it('keeps columns aligned when a name is not plain ASCII', () => {
    // A fixed-width reader counts bytes. Padding by characters would let "go'sht"
    // in Cyrillic push the price into the unit-weight column.
    const lines = records(
      buildPluExport([{plu: 1, name: 'Гўшт', price: 20000}], CODING, 'txp'),
    );
    expect(Buffer.byteLength(lines[0])).toBe(119);
  });

  it('truncates an over-long name on a byte boundary', () => {
    const lines = records(
      buildPluExport(
        [{plu: 1, name: 'Я'.repeat(40), price: 5}], CODING, 'txp',
      ),
    );
    // Never a half-encoded character, and never past the column.
    expect(Buffer.byteLength(lines[0])).toBe(119);
    expect(lines[0]).not.toContain('�');
  });

  it('carries the same PLU and barcode coding as the spreadsheet', () => {
    const [first] = records(buildPluExport(rows, CODING, 'txp'));
    expect(first.slice(49, 59)).toBe('89'.padStart(10, ' ')); // Code
    expect(first.slice(60, 62)).toBe(' 2'); // Barcode Type
    expect(first.slice(72, 73)).toBe('4'); // Weight Unit — kg
    expect(first.slice(74, 76)).toBe('10'); // Department
  });
});
