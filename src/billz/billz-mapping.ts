// PURE, no-DB raw-reading logic for BiLLZ list responses and records.
//
// This is the SINGLE SOURCE OF TRUTH for how a raw BiLLZ record is turned into
// the fields KPOS cares about. Both the import worker's LOAD phase and the MG2
// `GET /billz/probe` preview call these functions, so the preview can never
// drift from what the real import reads.
//
// Everything here is defensive: the BiLLZ 2.0 API is documented (MIGRATSIYA.md
// §4A) but several field names are still UNCONFIRMED — the probe (MG2) exists
// precisely to confirm them against real JSON. Each reader below documents the
// candidate keys it falls back through.

// ── Small parsing primitives (shared with the worker) ───────────────────────

/** Narrow to a plain object (not array, not null). */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Coerce strings/finite numbers to a string; anything else → undefined. */
export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** Coerce to a finite number, else 0 (used for money/stock sums). */
function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** First argument that is an array, else null. */
function firstArray(...cands: unknown[]): unknown[] | null {
  for (const c of cands) if (Array.isArray(c)) return c as unknown[];
  return null;
}

/** First argument coercible to a finite number, else null. */
function firstNumber(...cands: unknown[]): number | null {
  for (const c of cands) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && c.trim() !== '') {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function round3(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 1000) / 1000;
}

function decStr(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/** Digits only, keeping any leading country code (MIGRATSIYA §5). */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

// ── List envelope + total detection ─────────────────────────────────────────

export interface ExtractedList {
  /** The record array (empty when the last page is empty OR none was found). */
  records: unknown[];
  /** Total the API reports for the entity, or null if not detected. */
  total: number | null;
  /** Top-level keys of the response object (for confirming the array envelope). */
  envelopeKeys: string[];
  /**
   * true when a record array was located (body itself an array, or one of the
   * known envelope keys held an array — even an empty one). false means NO
   * array was found under any known key: the worker treats this as a fatal
   * unexpected-shape error; the probe surfaces it as a warning instead.
   */
  arrayFound: boolean;
}

/**
 * Pull the record array + optional total out of a list response, trying the
 * shapes BiLLZ list endpoints plausibly use, and report the envelope keys.
 *
 * Unlike a throwing parser, this never throws: `arrayFound` lets each caller
 * decide. The worker throws on `!arrayFound` so a renamed/unexpected shape
 * surfaces loudly (rather than silently importing nothing); the probe turns it
 * into a human-readable warning.
 */
export function extractList(body: unknown): ExtractedList {
  if (Array.isArray(body)) {
    return {records: body, total: null, envelopeKeys: [], arrayFound: true};
  }
  const b = asRecord(body);
  if (!b) {
    return {records: [], total: null, envelopeKeys: [], arrayFound: false};
  }
  const envelopeKeys = Object.keys(b);
  const data = asRecord(b.data);
  const records = firstArray(
    b.products,
    b.items,
    b.results,
    b.list,
    b.clients,
    b.categories,
    b.data,
    data?.products,
    data?.clients,
    data?.categories,
    data?.items,
    data?.results,
    data?.list,
  );
  const pagination = asRecord(b.pagination);
  const meta = asRecord(b.meta);
  const total = firstNumber(
    b.count,
    b.total,
    b.total_count,
    b.totalCount,
    pagination?.total,
    pagination?.count,
    pagination?.total_count,
    meta?.total,
    meta?.total_count,
    data?.count,
    data?.total,
    data?.total_count,
  );
  if (!records) {
    return {records: [], total, envelopeKeys, arrayFound: false};
  }
  return {records, total, envelopeKeys, arrayFound: true};
}

// ── Product record → KPOS fields ────────────────────────────────────────────

export interface ProductMapping {
  billzId: string | null;
  /** Base product name (trimmed), null if empty. Candidate: `name`. */
  name: string | null;
  /** Candidate: `sku`. */
  sku: string | null;
  /** Candidate: `barcode`. */
  barcode: string | null;
  /** Supply/cost price, always a "0.00"-style decimal string (defaults "0.00"). */
  priceIn: string;
  /** Retail price, always a "0.00"-style decimal string (defaults "0.00"). */
  priceOut: string;
  /** Summed stock across shop_measurement_values[] (defaults 0). */
  stock: number;
  /** Candidate: `brand_name`. */
  brandName: string | null;
  /**
   * BiLLZ category id from `categories[0].id`. Used DIRECTLY as the KPOS category
   * id (KPOS `categories.id` is a free business-scoped varchar), so the product
   * links to its real BiLLZ category without a name match.
   */
  categoryId: string | null;
  /** Candidate: `categories[0].name`. */
  categoryName: string | null;
  /** Candidate: `measurement_unit.name`. */
  unitName: string | null;
  /** Candidate: `measurement_unit.short_name` (worker needs it for find-or-create). */
  unitShortName: string | null;
  /**
   * Display name with variant attribute suffix appended, e.g.
   * "Air Jordan 1 (42, Qora)" — from `product_attributes[].attribute_value`.
   * Equal to `name` when there are no attributes; null when name is empty.
   * Capped at 255 chars (products.name length).
   */
  variantName: string | null;
}

/**
 * Collapse BiLLZ per-shop `shop_prices[]` to KPOS's single price pair. Both
 * fields are MG2-confirmed against real JSON:
 *  - priceIn  ← first shop's `supply_price`
 *  - priceOut ← first shop's `retail_price` (then `price` as a fallback)
 * Prices are per-shop but identical across shops in practice, so the first
 * non-zero shop wins (KPOS is single-price). Currency is UZS for this tenant;
 * cross-currency conversion is out of scope (MIGRATSIYA §5.1).
 */
function summariseShopPrices(raw: unknown): {
  priceIn: string;
  priceOut: string;
} {
  const arr = Array.isArray(raw) ? raw : [];
  let priceIn = 0;
  let priceOut = 0;
  let gotIn = false;
  let gotOut = false;
  for (const item of arr) {
    const sp = asRecord(item);
    if (!sp) continue;
    if (!gotIn) {
      const v = num(sp.supply_price);
      if (v) {
        priceIn = v;
        gotIn = true;
      }
    }
    if (!gotOut) {
      const v = num(sp.retail_price ?? sp.price);
      if (v) {
        priceOut = v;
        gotOut = true;
      }
    }
  }
  return {priceIn: decStr(priceIn), priceOut: decStr(priceOut)};
}

/**
 * Stock (qoldiq) lives in the `shop_measurement_values[]` array (per shop),
 * summed across shops — MG2-confirmed against real staged JSON. The FIELD NAME
 * differs by endpoint:
 *  - POST /v2/product-search-with-filters (the import path): `total_active_
 *    measurement_value` (sellable on-hand), then `total_measurement_value`.
 *  - GET /v2/products (the MG2 probe path): `active_measurement_value`.
 * We try all, in that order, then fall back to the older `shop_prices[]` stock
 * keys if the array is absent entirely.
 */
function sumStock(rec: Record<string, unknown>): number {
  const smv = Array.isArray(rec.shop_measurement_values)
    ? rec.shop_measurement_values
    : [];
  let stock = 0;
  let found = false;
  for (const item of smv) {
    const s = asRecord(item);
    if (!s) continue;
    const v = firstNumber(
      s.total_active_measurement_value,
      s.total_measurement_value,
      s.active_measurement_value,
      s.measurement_value,
    );
    if (v != null) {
      stock += v;
      found = true;
    }
  }
  if (!found) {
    const sp = Array.isArray(rec.shop_prices) ? rec.shop_prices : [];
    for (const item of sp) {
      const s = asRecord(item);
      if (!s) continue;
      stock += num(s.stock ?? s.quantity ?? s.measurement_value);
    }
  }
  return round3(stock);
}

/**
 * Read one raw BiLLZ product record into KPOS fields (no DB access). The worker
 * consumes the brandName/categoryName/unitName strings to find-or-create ids.
 */
export function mapProduct(raw: unknown): ProductMapping {
  const rec = asRecord(raw) ?? {};

  const billzId = str(rec.id) ?? null;
  const name = (str(rec.name) ?? '').trim() || null;
  const sku = (str(rec.sku) ?? '').trim() || null;
  const barcode = (str(rec.barcode) ?? '').trim() || null;
  const brandName = (str(rec.brand_name) ?? '').trim() || null;

  // KPOS categories are FLAT — take categories[0] (id + name).
  const cats = Array.isArray(rec.categories) ? rec.categories : [];
  const cat0 = asRecord(cats[0]);
  const categoryId = cat0 ? (str(cat0.id) ?? '').trim() || null : null;
  const categoryName = cat0 ? (str(cat0.name) ?? '').trim() || null : null;

  const mu = asRecord(rec.measurement_unit);
  const unitName = mu ? (str(mu.name) ?? '').trim() || null : null;
  const unitShortName = mu ? (str(mu.short_name) ?? '').trim() || null : null;

  const {priceIn, priceOut} = summariseShopPrices(rec.shop_prices);
  const stock = sumStock(rec);

  // Variant (v1 strategy, §5.1): append attribute values to the base name so
  // each variant row imports as its own product → "Air Jordan 1 (42, Qora)".
  const attrs = Array.isArray(rec.product_attributes)
    ? rec.product_attributes
    : [];
  const attrVals = attrs
    .map((a) => (str(asRecord(a)?.attribute_value) ?? '').trim())
    .filter((v): v is string => v.length > 0);
  let variantName: string | null = null;
  const base = name ?? '';
  if (base || attrVals.length > 0) {
    variantName = (
      attrVals.length > 0 ? `${base} (${attrVals.join(', ')})` : base
    ).slice(0, 255);
    if (!variantName) variantName = null;
  }

  return {
    billzId,
    name,
    sku,
    barcode,
    priceIn,
    priceOut,
    stock,
    brandName,
    categoryId,
    categoryName,
    unitName,
    unitShortName,
    variantName,
  };
}

// ── Customer record → KPOS fields ───────────────────────────────────────────

export interface CustomerMapping {
  billzId: string | null;
  /**
   * Trimmed name, null if empty. MG2-confirmed: BiLLZ 2.0 clients have no single
   * `name`; the name is built from `first_name` + `last_name` + `middle_name`
   * (with `name`/`full_name` preferred if a tenant happens to expose them).
   */
  name: string | null;
  /**
   * Digits-only phone (country code kept), null if empty. MG2-confirmed: phone
   * is an array `phone_numbers[]` (first entry used); string keys kept as
   * fallbacks.
   */
  phone: string | null;
}

/** Read one raw BiLLZ client record into KPOS user fields (no DB access). */
export function mapCustomer(raw: unknown): CustomerMapping {
  const rec = asRecord(raw) ?? {};
  const billzId = str(rec.id) ?? null;

  // BiLLZ 2.0 splits the name into first/last/middle — join the non-empty parts.
  const joined = [rec.first_name, rec.last_name, rec.middle_name]
    .map((p) => (str(p) ?? '').trim())
    .filter((p) => p.length > 0)
    .join(' ');
  const name =
    (str(rec.name) ?? str(rec.full_name) ?? '').trim() || joined || null;

  // Phone is an array in BiLLZ 2.0; fall back to the older string keys.
  const phones = Array.isArray(rec.phone_numbers) ? rec.phone_numbers : [];
  const rawPhone = (
    str(phones[0]) ??
    str(rec.phone_number) ??
    str(rec.phone) ??
    str(rec.mobile_phone) ??
    str(rec.mobile) ??
    ''
  ).trim();
  const phone = normalizePhone(rawPhone) || null;

  return {billzId, name, phone};
}
