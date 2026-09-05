import {JsonSchemaObject} from '../providers/llm-provider.interface';

/**
 * What the model is asked to return for one photographed delivery note
 * ("nakladnoy").
 *
 * NOTHING IS NULLABLE, on purpose. The three providers disagree about nullable
 * types in a structured-output schema — Gemini's JSON-Schema subset and
 * OpenAI's strict mode each reject a shape the other accepts — so "unknown" is
 * an empty string or 0 and the prompt says so. The service turns those back
 * into nulls before the frontend sees them.
 */
export const INVOICE_SCHEMA_NAME = 'delivery_note';

export const INVOICE_SCHEMA: JsonSchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'supplierName',
    'documentNumber',
    'documentDate',
    'currency',
    'totalAmount',
    'lines',
  ],
  properties: {
    supplierName: {
      type: 'string',
      description:
        'Supplier / sender company name exactly as printed, or "" if absent.',
    },
    documentNumber: {
      type: 'string',
      description: 'Document number, digits and separators only, or "".',
    },
    documentDate: {
      type: 'string',
      description: 'Document date as YYYY-MM-DD, or "" if none is legible.',
    },
    currency: {
      type: 'string',
      description:
        'Currency code: UZS, USD, RUB or EUR. Use UZS when nothing says otherwise.',
    },
    totalAmount: {
      type: 'number',
      description:
        'The grand total printed on the document (0 if there is none). ' +
        'Copied verbatim, never recomputed — it is the checksum for the lines.',
    },
    lines: {
      type: 'array',
      description: 'One entry per goods row, in the order printed.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'rowNumber',
          'name',
          'barcode',
          'unit',
          'quantity',
          'priceIn',
          'lineTotal',
        ],
        properties: {
          rowNumber: {
            type: 'number',
            description:
              'The № printed at the start of this row on the document ' +
              '(0 when the document has no number column). Copied, never ' +
              'counted — it is what proves the row was read as one line.',
          },
          name: {
            type: 'string',
            description:
              'Product name exactly as written, in its original script.',
          },
          barcode: {
            type: 'string',
            description:
              'Barcode / article / SKU printed on the row, digits only, or "".',
          },
          unit: {
            type: 'string',
            description:
              'Unit as written (dona, kg, litr, quti, шт, кг, л …), or "".',
          },
          quantity: {
            type: 'number',
            description: 'Quantity received. 0 if unreadable.',
          },
          priceIn: {
            type: 'number',
            description:
              'Unit purchase price BEFORE any total. 0 if the row shows only a total.',
          },
          lineTotal: {
            type: 'number',
            description:
              'Row total as printed (0 if absent). Copied, never computed.',
          },
        },
      },
    },
  },
};

/**
 * Persona + rules. Stable text, so it sits in the cacheable system slot.
 *
 * Written against what Uzbek delivery notes actually look like: mixed
 * Latin/Cyrillic, Russian column headers, `1 200 000` and `1.200.000` and
 * `12 500,50` all meaning different things, and a footer block (ЖАМИ / ИТОГО /
 * НДС) that reads exactly like a goods row to a model that was not warned.
 */
export const INVOICE_SYSTEM_PROMPT = `You transcribe supplier delivery notes ("nakladnoy", "накладная", "hisob-faktura") for a retail shop in Uzbekistan.

You are a TRANSCRIBER, not an assistant. Copy what is on the page. Never infer, complete, translate or tidy a value that is not printed.

DOCUMENT REALITY
- Text is Uzbek Latin, Uzbek Cyrillic or Russian, often mixed on one page.
- Column headers vary: Nomi / Mahsulot / Tovar / Наименование / Товар for the name;
  Soni / Miqdori / Кол-во / Количество for quantity;
  Narxi / Narx / Цена for unit price;
  Summa / Сумма / Jami for the row total.
- Pages may be photographed at an angle, creased, stamped, or handwritten.

NUMBERS
- Output plain numbers with a dot decimal separator and no grouping: 1200000, not "1 200 000" or "1.200.000".
- A space, apostrophe or dot used as a thousands separator is NOT a decimal point: "1.200.000" is 1200000; "12 500,50" is 12500.5.
- A comma between digits is a decimal separator: "2,5" is 2.5.

ONE ROW AT A TIME — THE MOST IMPORTANT RULE
- A row is a HORIZONTAL line of the table. Read it whole, left to right, and finish it before you look at the next one.
- Never read a table column-by-column. Taking the names down one column and then the prices down another is how a price ends up one row away from the product it belongs to, and that error is invisible once the numbers leave the page.
- Every value in one output object must come from the SAME horizontal line. If a cell is blank, leave it blank — never fill it from the line above or below.
- Copy the № printed at the start of the row into rowNumber. It is how the row proves which line it came from. If the document has no number column, use 0 for every row.
- Ruled lines, merged cells and a name that wraps onto a second line do not start a new row: a wrapped name belongs to the row above it.

WHAT IS A LINE
- Only rows of actual goods. NEVER emit a line for: ЖАМИ / JAMI / ИТОГО / Всего / Total, НДС / QQS / VAT, delivery or service charges, subtotals, page headers or signature blocks.
- Keep every goods row, including repeats of the same product.
- Preserve the printed order.

UNREADABLE VALUES
- If a value cannot be read, use "" for text and 0 for numbers. Never guess.
- Never invent a product, a price or a quantity that is not on the page.
- If a row shows only a quantity and a total but no unit price, set priceIn to 0 and put the total in lineTotal. Do not divide it yourself.
- totalAmount and lineTotal are copied from the page. They are the checksum used to catch a misread quantity or price, so computing them yourself destroys the only signal that something went wrong.

If the image is not a delivery note at all, return an empty lines array.`;

/** Per-call instruction. Kept short: the rules live in the system prompt. */
export const INVOICE_INSTRUCTION =
  'Read this delivery note and return its header fields and every goods row. ' +
  'When several pages are attached they are ONE document, in order: read them ' +
  'as a single continuous table, keep the row order across the page break, and ' +
  'take the header fields and the grand total from whichever page carries them ' +
  '(the total is usually only on the last page).';

/**
 * Instruction for a page added to a note that is already being reviewed.
 *
 * Sent alone, a second page reads badly: on a real nakladnoy the column
 * headers are printed once, at the top of page 1, so a model handed only page 2
 * has to guess which column is quantity and which is price. Saying outright
 * that this is a continuation is what stops it from inventing a header row —
 * or from reading the page's first goods row AS the header and dropping it.
 */
export const INVOICE_CONTINUATION_INSTRUCTION =
  'This is a CONTINUATION page of a delivery note whose earlier pages have ' +
  'already been read. It probably has no column headers and no supplier block ' +
  'of its own — do not expect them, and do not treat the first goods row as a ' +
  'header. Columns follow the usual order: name, unit, quantity, unit price, ' +
  'row total. Return only the goods rows on THIS page, plus the grand total if ' +
  'this page happens to carry it. Leave the header fields empty otherwise.';

/** The shape `INVOICE_SCHEMA` produces once parsed. */
export interface RawInvoice {
  supplierName: string;
  documentNumber: string;
  documentDate: string;
  currency: string;
  totalAmount: number;
  lines: RawInvoiceLine[];
}

export interface RawInvoiceLine {
  /** The № as printed, or 0 when the document has no number column. */
  rowNumber: number;
  name: string;
  barcode: string;
  unit: string;
  quantity: number;
  priceIn: number;
  lineTotal: number;
}
