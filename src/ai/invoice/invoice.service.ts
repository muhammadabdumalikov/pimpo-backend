import {Injectable, Logger} from '@nestjs/common';
import {and, eq} from 'drizzle-orm';
import {AppException} from '../../common/errors/app.exception';
import {ErrorCode} from '../../common/errors/error-codes';
import {DatabaseService} from '../../database/database.service';
import {products} from '../../database/schema';
import {AiSettingsService} from '../ai-settings.service';
import {CatalogEntry, CatalogIndex, MatchCandidate} from './invoice-match';
import {
  INVOICE_CONTINUATION_INSTRUCTION,
  INVOICE_INSTRUCTION,
  INVOICE_SCHEMA,
  INVOICE_SCHEMA_NAME,
  INVOICE_SYSTEM_PROMPT,
  RawInvoice,
  RawInvoiceLine,
} from './invoice-schema';

/** Wall-clock budget for one document. Long enough for a slow PDF, not a hang. */
const PARSE_BUDGET_MS = 120_000;

/**
 * Rows we will look at. A real delivery note tops out well under this; a
 * hallucinated tail or a scanned catalogue page is what the cap is for.
 */
const MAX_LINES = 200;

/**
 * Products loaded for code matching.
 *
 * The whole (trimmed) catalogue is pulled in one query and indexed in memory
 * rather than one round trip per invoice row: a 60-line note would otherwise
 * be 60 queries against a remote Postgres.
 */
const MAX_CATALOG_ROWS = 20_000;

/**
 * How far `quantity × priceIn` may drift from the printed row total before the
 * row is flagged. One so'm of rounding per side is normal; anything more means
 * a digit was misread.
 */
const TOTAL_TOLERANCE = 1;

export interface ParsedInvoiceLine {
  /** Position on the document, 1-based — the order the owner sees. */
  index: number;
  /**
   * The № printed at the start of the row, or null when the document has no
   * number column.
   *
   * Asked for mainly to keep the model honest: a table read column-by-column
   * puts one row's price against another row's product, and requiring the
   * printed number forces each output object to be anchored to one physical
   * line. It also lets the owner cite a row the way the paper numbers it.
   */
  rowNumber: number | null;
  /**
   * The printed numbering advanced as it should. `false` means this row
   * repeats or goes back on the one before it — the model lost its place, and
   * every value on the row is suspect. Null when the document is unnumbered.
   */
  sequenceOk: boolean | null;
  /** The name as printed, kept verbatim for the confirm screen. */
  rawName: string;
  barcode: string | null;
  unit: string | null;
  quantity: number;
  priceIn: number;
  /** Row total as printed, or null when the document showed none. */
  lineTotal: number | null;
  /**
   * `quantity × priceIn` agrees with the printed row total.
   *
   * The cheapest verifier there is: it catches a misread digit using only
   * numbers already on the page, with no second model call. Null when the row
   * carried no total to check against.
   */
  totalsMatch: boolean | null;
  /** Best catalogue hit, or null when nothing scored high enough. */
  match: MatchCandidate | null;
  /** Runners-up for the dropdown. Empty after an exact barcode hit. */
  alternatives: MatchCandidate[];
}

export interface ParsedInvoice {
  supplierName: string | null;
  documentNumber: string | null;
  /** ISO date (YYYY-MM-DD), or null when none was legible. */
  documentDate: string | null;
  currency: string | null;
  /** Grand total as printed, or null. */
  totalAmount: number | null;
  /** Sum of the row totals we read. Compare against `totalAmount`. */
  linesTotal: number;
  /** The two totals agree. Null when the document printed no grand total. */
  totalsMatch: boolean | null;
  lines: ParsedInvoiceLine[];
  /**
   * Every row's printed № advanced. Null when the document carries no number
   * column, so there was nothing to check against.
   */
  sequenceOk: boolean | null;
  /** Rows the model produced but we dropped as unusable (no name, no amounts). */
  skippedLines: number;
  model: string;
  usage: {inputTokens: number; outputTokens: number};
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly settings: AiSettingsService,
    private readonly database: DatabaseService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Reads a photographed delivery note and lines it up against the shop's own
   * catalogue.
   *
   * The bytes are never persisted: they arrive in memory from multer, go
   * straight to the provider as base64, and are gone when this returns. There
   * is nothing in S3 to leak and nothing for the owner to clean up.
   */
  async parse(
    businessId: string,
    files: {buffer: Buffer; mimetype: string}[],
    opts: {model?: string; continuation?: boolean} = {},
  ): Promise<ParsedInvoice> {
    const modelOverride = opts.model;
    const provider = await this.settings.resolveProvider(
      businessId,
      modelOverride,
    );
    const model =
      modelOverride ?? (await this.settings.getView(businessId)).model;

    const controller = new AbortController();
    const budget = setTimeout(() => controller.abort(), PARSE_BUDGET_MS);
    const startedAt = Date.now();

    let raw: RawInvoice;
    let usage: {inputTokens: number; outputTokens: number};
    try {
      const result = await provider.extractDocument({
        system: INVOICE_SYSTEM_PROMPT,
        // A page added to a review already in progress is read on its own, so
        // it has to be told it is a continuation — see the constant for why.
        instruction: opts.continuation
          ? INVOICE_CONTINUATION_INSTRUCTION
          : INVOICE_INSTRUCTION,
        // Every page in one call: the model then reads them as one table, keeps
        // the row order across the break, and finds the grand total wherever it
        // is printed (usually only on the last page).
        documents: files.map((f) => ({
          mimeType: f.mimetype,
          data: f.buffer.toString('base64'),
        })),
        schema: INVOICE_SCHEMA,
        schemaName: INVOICE_SCHEMA_NAME,
        signal: controller.signal,
      });
      raw = normaliseRaw(result.data);
      usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AppException(ErrorCode.AI_TIMEOUT);
      }
      throw this.settings.toAppException(err);
    } finally {
      clearTimeout(budget);
    }

    // Billed whatever the outcome — the tokens were spent even if the page
    // turned out to be unreadable.
    await this.settings.recordUsage(businessId, {
      input: usage.inputTokens,
      output: usage.outputTokens,
      model,
    });

    const usable = raw.lines
      .slice(0, MAX_LINES)
      .filter((line) => isUsableLine(line));
    if (!usable.length) {
      this.logger.warn(
        `invoice.parse business=${businessId} model=${model} produced no usable lines`,
      );
      throw new AppException(ErrorCode.AI_INVOICE_UNREADABLE);
    }

    const index = new CatalogIndex(await this.loadCatalog(businessId));
    const lines = usable.map((line, i) => this.toParsedLine(line, i, index));
    const sequenceOk = markSequence(lines);

    const linesTotal = round2(
      lines.reduce((sum, l) => sum + (l.lineTotal ?? l.quantity * l.priceIn), 0),
    );
    const totalAmount = raw.totalAmount > 0 ? round2(raw.totalAmount) : null;

    this.logger.log(
      `invoice.parse business=${businessId} model=${model} ms=${Date.now() - startedAt}` +
        ` pages=${files.length}${opts.continuation ? ' (continuation)' : ''}` +
        ` in=${usage.inputTokens} out=${usage.outputTokens} lines=${lines.length}` +
        ` matched=${lines.filter((l) => l.match).length}` +
        ` sequence=${sequenceOk === null ? 'n/a' : sequenceOk ? 'ok' : 'BROKEN'}` +
        ` catalog=${index.size}`,
    );

    return {
      supplierName: blankToNull(raw.supplierName),
      documentNumber: blankToNull(raw.documentNumber),
      documentDate: isoDateOrNull(raw.documentDate),
      currency: blankToNull(raw.currency)?.toUpperCase() ?? null,
      totalAmount,
      linesTotal,
      totalsMatch:
        totalAmount === null
          ? null
          : Math.abs(totalAmount - linesTotal) <= TOTAL_TOLERANCE,
      lines,
      sequenceOk,
      skippedLines: Math.min(raw.lines.length, MAX_LINES) - usable.length,
      model,
      usage,
    };
  }

  private toParsedLine(
    line: RawInvoiceLine,
    i: number,
    index: CatalogIndex,
  ): ParsedInvoiceLine {
    const quantity = round3(Math.abs(line.quantity));
    const priceIn = round2(Math.abs(line.priceIn));
    const lineTotal = line.lineTotal > 0 ? round2(line.lineTotal) : null;
    const barcode = blankToNull(line.barcode);

    // Exact code only. A row whose note printed no barcode arrives unmatched
    // and the owner picks the product — see invoice-match for why no name-based
    // guess is offered here.
    const matched = index.find(barcode);

    return {
      index: i + 1,
      rowNumber: line.rowNumber > 0 ? Math.round(line.rowNumber) : null,
      sequenceOk: null, // filled by markSequence once the whole run is known
      rawName: line.name.trim(),
      barcode,
      unit: blankToNull(line.unit),
      quantity,
      priceIn,
      lineTotal,
      totalsMatch:
        lineTotal === null
          ? null
          : Math.abs(quantity * priceIn - lineTotal) <= TOTAL_TOLERANCE,
      match: matched,
      // Kept on the wire so the review's shape does not change; nothing fills
      // it now that only exact matches are made.
      alternatives: [],
    };
  }

  /** The shop's active catalogue, trimmed to the columns matching needs. */
  private async loadCatalog(businessId: string): Promise<CatalogEntry[]> {
    const rows = await this.db
      .select({
        id: products.id,
        name: products.name,
        barcode: products.barcode,
        code: products.code,
        quantityType: products.quantityType,
        priceIn: products.priceIn,
        priceOut: products.priceOut,
      })
      .from(products)
      .where(
        and(eq(products.businessId, businessId), eq(products.isActive, true)),
      )
      .limit(MAX_CATALOG_ROWS);

    return rows.map((row) => ({
      ...row,
      // `decimal` columns come back as strings from the driver.
      priceIn: Number(row.priceIn) || 0,
      priceOut: Number(row.priceOut) || 0,
    }));
  }
}

/**
 * Coerces the provider's JSON into the declared shape.
 *
 * Structured output constrains the schema, not the semantics: a field can still
 * arrive as a numeric string, and a truncated array can arrive short. Every
 * value is therefore re-read defensively rather than cast.
 */
function normaliseRaw(data: unknown): RawInvoice {
  const obj = (data ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(obj.lines) ? obj.lines : [];

  return {
    supplierName: asString(obj.supplierName),
    documentNumber: asString(obj.documentNumber),
    documentDate: asString(obj.documentDate),
    currency: asString(obj.currency),
    totalAmount: asNumber(obj.totalAmount),
    lines: lines.map((entry): RawInvoiceLine => {
      const line = (entry ?? {}) as Record<string, unknown>;
      return {
        rowNumber: asNumber(line.rowNumber),
        name: asString(line.name),
        barcode: asString(line.barcode),
        unit: asString(line.unit),
        quantity: asNumber(line.quantity),
        priceIn: asNumber(line.priceIn),
        lineTotal: asNumber(line.lineTotal),
      };
    }),
  };
}

/**
 * Checks the printed numbering and marks the rows that break it.
 *
 * Only a number that fails to ADVANCE is treated as a fault — a repeat or a
 * step backwards, which means the model lost its place in the table and the
 * whole row is suspect. Gaps are deliberately not flagged: we drop unusable
 * rows ourselves, so a hole in the run is at least as likely to be our own
 * doing as the model's, and crying wolf on it would train the owner to ignore
 * the warning that matters.
 *
 * Returns null when nothing was numbered — most handwritten notes.
 */
function markSequence(lines: ParsedInvoiceLine[]): boolean | null {
  if (!lines.some((l) => l.rowNumber !== null)) return null;

  let ok = true;
  let previous = 0;
  for (const line of lines) {
    // A row with no number in a numbered document is itself a lost place.
    const advanced = line.rowNumber !== null && line.rowNumber > previous;
    line.sequenceOk = advanced;
    if (!advanced) ok = false;
    if (line.rowNumber !== null) previous = line.rowNumber;
  }
  return ok;
}

/**
 * A row worth showing. Needs a name and some money or count attached — a row
 * with a name and nothing else is a section header the model mistook for goods.
 */
function isUsableLine(line: RawInvoiceLine): boolean {
  if (!line.name.trim()) return false;
  return line.quantity > 0 || line.priceIn > 0 || line.lineTotal > 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Accepts the numeric strings a model occasionally emits despite the schema. */
function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Keeps a date only when it is really YYYY-MM-DD and really exists. */
function isoDateOrNull(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const date = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Rejects 2026-02-31, which `Date` would silently roll into March.
  return date.toISOString().slice(0, 10) === trimmed ? trimmed : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
