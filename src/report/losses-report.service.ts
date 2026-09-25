import {Injectable} from '@nestjs/common';
import {sql, type SQL} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {businessDayEnd, businessDayStart} from '../common/business-time';
import type {DateRange} from './report.service';
import {
  DEFECTIVE_MOVEMENT_TYPES,
  type DefectiveMovementType,
} from '../common/defective-stock';

// "Qaytarish va yo'qotishlar" — every way goods came back or left stock other
// than a sale, in one place, by reason (YOQOTISHLAR.md):
//
//   customer  mijozdan qaytgan    sale_return_items; condition restocked |
//                                 defective_stock (into the yaroqsiz tovarlar
//                                 ombori) | defective (legacy: lost on return)
//   supplier  ta'minotchiga       supplier_return_items (value in UZS at the
//                                 receipt's USD rate), from stock or defective
//   writeoff  hisobdan chiqarish  stock_take_items of a 'writeoff' stock_take,
//                                 plus write-offs out of defective stock (at
//                                 the expense they booked — origin 'defective')
//   count     inventarizatsiya    stock_take_items of a full/partial count;
//                                 condition shortage|surplus
//   defective yaroqsiz ombor      defective_movement_items; condition = the
//                                 movement type (in_* / out_*), at cost
//
// Only customer 'defective' (legacy), write-offs and the count net are losses.
// A defective unit put in the yaroqsiz tovarlar ombori is inventory until it
// is written off, so the defective section is a flow view, not a loss.
//
// Every value is UZS at cost (tannarx): the sale's COGS for customer returns,
// the purchase cost for supplier returns, the FIFO cost for write-offs and
// counts. Quantities in the summary follow the orders.item_count rule — a
// weighed line counts as one — so kg and pieces can share a total; the line
// listing carries the real quantity.
//
// Read-only; nothing here writes.

export type LossSection =
  | 'customer'
  | 'supplier'
  | 'writeoff'
  | 'count'
  | 'defective';
export type LossCondition =
  | 'restocked'
  | 'defective'
  | 'defective_stock'
  | 'shortage'
  | 'surplus'
  | DefectiveMovementType;

export interface LossLinesQuery extends DateRange {
  section?: LossSection;
  /** A reason code, or 'none' for lines without one. */
  reason?: string;
  condition?: LossCondition;
  limit?: number;
}

export interface LossLine {
  section: LossSection;
  date: string;
  /** sale_returns.id | supplier_returns.id | stock_takes.id */
  documentId: string;
  /** The sale (orders.id) or goods receipt the return was made against. */
  parentId: string | null;
  /** Sale receipt number, or the stock-take's name. */
  ref: string | null;
  /** Customer (customer returns) or supplier (supplier returns). */
  counterparty: string | null;
  by: string | null;
  productId: string | null;
  productName: string;
  quantityType: string | null;
  qty: number;
  value: number;
  /** Customer returns only: what the goods sold for (net of discount). */
  saleValue: number | null;
  reasonCode: string | null;
  condition: LossCondition | null;
  note: string | null;
  /** 'defective' = the line moved defective stock (yaroqsiz tovarlar ombori). */
  origin: 'stock' | 'defective';
}

interface ReasonRow {
  code: string | null;
  docs: number;
  qty: number;
  value: number;
}

export interface LossesReport {
  from: string | null;
  to: string | null;
  bucket: 'day' | 'month';
  /** customer defective + write-offs + count shortage − count surplus. */
  totalLoss: number;
  customer: {
    docs: number;
    qty: number;
    value: number;
    saleValue: number;
    restocked: {qty: number; value: number};
    /** Put in the yaroqsiz tovarlar ombori — inventory, not a loss. */
    defectiveStock: {qty: number; value: number};
    /** Legacy: defective lines from before the store existed — a loss. */
    defective: {qty: number; value: number};
    byReason: (ReasonRow & {
      saleValue: number;
      defectiveStockQty: number;
      defectiveStockValue: number;
      defectiveQty: number;
      defectiveValue: number;
    })[];
  };
  supplier: {docs: number; qty: number; value: number; byReason: ReasonRow[]};
  writeOff: {docs: number; qty: number; value: number; byReason: ReasonRow[]};
  count: {
    docs: number;
    shortage: {qty: number; value: number};
    surplus: {qty: number; value: number};
    netValue: number;
  };
  /** Yaroqsiz tovarlar ombori: flows in the period (at cost) and stock now. */
  defectiveStock: {
    in: {qty: number; value: number};
    out: {qty: number; value: number};
    byType: {
      type: DefectiveMovementType;
      docs: number;
      qty: number;
      value: number;
    }[];
    /** On hand now — not bound to the period; the branch filter applies. */
    balance: {qty: number; value: number};
  };
  trend: {
    bucket: string;
    customerDefective: number;
    supplier: number;
    writeOff: number;
    countNet: number;
  }[];
}

/** Ranges up to this many days trend by day; longer ones by month. */
const DAILY_TREND_MAX_DAYS = 62;
const LINES_DEFAULT_LIMIT = 500;
const LINES_MAX_LIMIT = 5000;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

@Injectable()
export class LossesReportService {
  constructor(private readonly dbService: DatabaseService) {}

  private get db() {
    return this.dbService.db;
  }

  async getSummary(
    businessId: string,
    range: DateRange = {},
  ): Promise<LossesReport> {
    const lines = await this.linesCte(businessId, range);

    // One pass, four groupings: section × code × condition (customer defective
    // per reason), section × code (byReason, docs counted once per return),
    // section × condition (restocked/defective, shortage/surplus) and section.
    const rows = (await this.db.execute(sql`
      WITH lines AS (${lines})
      SELECT section, reason_code, condition,
             GROUPING(reason_code) AS g_code,
             GROUPING(condition)   AS g_cond,
             COUNT(DISTINCT doc_id) AS docs,
             COALESCE(SUM(units), 0)      AS qty,
             COALESCE(SUM(value), 0)      AS value,
             COALESCE(SUM(sale_value), 0) AS sale_value
      FROM lines
      GROUP BY GROUPING SETS (
        (section, reason_code, condition),
        (section, reason_code),
        (section, condition),
        (section)
      )
    `)) as unknown as Array<{
      section: LossSection;
      reason_code: string | null;
      condition: LossCondition | null;
      g_code: number | string;
      g_cond: number | string;
      docs: string;
      qty: string;
      value: string;
      sale_value: string;
    }>;

    const num = (v: string | number | null | undefined) => Number(v ?? 0);
    const pick = (section: LossSection, byCode: boolean, byCond: boolean) =>
      rows.filter(
        (r) =>
          r.section === section &&
          (num(r.g_code) === 0) === byCode &&
          (num(r.g_cond) === 0) === byCond,
      );
    const total = (section: LossSection) => {
      const r = pick(section, false, false)[0];
      return {
        docs: num(r?.docs),
        qty: round3(num(r?.qty)),
        value: round2(num(r?.value)),
        saleValue: round2(num(r?.sale_value)),
      };
    };
    const cond = (section: LossSection, c: LossCondition) => {
      const r = pick(section, false, true).find((x) => x.condition === c);
      return {qty: round3(num(r?.qty)), value: round2(num(r?.value))};
    };
    // Largest value first; unspecified (null) always last.
    const sortReasons = <T extends ReasonRow>(list: T[]) =>
      list.sort((a, b) =>
        a.code === null ? 1 : b.code === null ? -1 : b.value - a.value,
      );
    const byReason = (section: LossSection): ReasonRow[] =>
      sortReasons(
        pick(section, true, false).map((r) => ({
          code: r.reason_code,
          docs: num(r.docs),
          qty: round3(num(r.qty)),
          value: round2(num(r.value)),
        })),
      );

    const customerTotal = total('customer');
    const customerByCodeAndCond = (c: LossCondition) =>
      new Map(
        pick('customer', true, true)
          .filter((r) => r.condition === c)
          .map((r) => [r.reason_code, r]),
      );
    const customerDefectiveByCode = customerByCodeAndCond('defective');
    const customerDefStockByCode = customerByCodeAndCond('defective_stock');
    const customerByReason = sortReasons(
      pick('customer', true, false).map((r) => {
        const d = customerDefectiveByCode.get(r.reason_code);
        const ds = customerDefStockByCode.get(r.reason_code);
        return {
          code: r.reason_code,
          docs: num(r.docs),
          qty: round3(num(r.qty)),
          value: round2(num(r.value)),
          saleValue: round2(num(r.sale_value)),
          defectiveStockQty: round3(num(ds?.qty)),
          defectiveStockValue: round2(num(ds?.value)),
          defectiveQty: round3(num(d?.qty)),
          defectiveValue: round2(num(d?.value)),
        };
      }),
    );
    const defectiveByType = pick('defective', false, true)
      .filter((r) => r.condition)
      .map((r) => ({
        type: r.condition as DefectiveMovementType,
        docs: num(r.docs),
        qty: round3(num(r.qty)),
        value: round2(num(r.value)),
      }))
      .sort(
        (a, b) =>
          DEFECTIVE_MOVEMENT_TYPES.indexOf(a.type) -
          DEFECTIVE_MOVEMENT_TYPES.indexOf(b.type),
      );
    const sumTypes = (prefix: string) => {
      const rows = defectiveByType.filter((t) => t.type.startsWith(prefix));
      return {
        qty: round3(rows.reduce((s, t) => s + t.qty, 0)),
        value: round2(rows.reduce((s, t) => s + t.value, 0)),
      };
    };
    const supplierTotal = total('supplier');
    const writeOffTotal = total('writeoff');
    const shortage = cond('count', 'shortage');
    const surplus = cond('count', 'surplus');
    const defective = cond('customer', 'defective');
    const countNet = round2(shortage.value - surplus.value);

    return {
      from: range.from ?? null,
      to: range.to ?? null,
      bucket: this.bucketOf(range),
      totalLoss: round2(defective.value + writeOffTotal.value + countNet),
      customer: {
        docs: customerTotal.docs,
        qty: customerTotal.qty,
        value: customerTotal.value,
        saleValue: customerTotal.saleValue,
        restocked: cond('customer', 'restocked'),
        defectiveStock: cond('customer', 'defective_stock'),
        defective,
        byReason: customerByReason,
      },
      supplier: {
        docs: supplierTotal.docs,
        qty: supplierTotal.qty,
        value: supplierTotal.value,
        byReason: byReason('supplier'),
      },
      writeOff: {
        docs: writeOffTotal.docs,
        qty: writeOffTotal.qty,
        value: writeOffTotal.value,
        byReason: byReason('writeoff'),
      },
      count: {
        docs: total('count').docs,
        shortage,
        surplus,
        netValue: countNet,
      },
      defectiveStock: {
        in: sumTypes('in_'),
        out: sumTypes('out_'),
        byType: defectiveByType,
        balance: await this.defectiveBalance(businessId, range),
      },
      trend: await this.trend(businessId, range, lines),
    };
  }

  /** Line-level rows behind the summary — the drill-down and the Excel sheet. */
  async getLines(
    businessId: string,
    q: LossLinesQuery = {},
  ): Promise<{lines: LossLine[]; truncated: boolean}> {
    const lines = await this.linesCte(businessId, q);
    const limit = Math.min(
      Math.max(1, Math.floor(q.limit ?? LINES_DEFAULT_LIMIT)),
      LINES_MAX_LIMIT,
    );
    const where: SQL[] = [sql`TRUE`];
    if (q.section) where.push(sql`section = ${q.section}`);
    if (q.reason === 'none') where.push(sql`reason_code IS NULL`);
    else if (q.reason) where.push(sql`reason_code = ${q.reason}`);
    if (q.condition) where.push(sql`condition = ${q.condition}`);

    const rows = (await this.db.execute(sql`
      WITH lines AS (${lines})
      SELECT * FROM lines
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY created_at DESC, doc_id, product_name
      LIMIT ${limit + 1}
    `)) as unknown as Array<{
      section: LossSection;
      doc_id: string;
      parent_id: string | null;
      ref: string | null;
      counterparty: string | null;
      by_name: string | null;
      created_at: string | Date;
      product_id: string | null;
      product_name: string;
      quantity_type: string | null;
      qty: string | number;
      value: string | number | null;
      sale_value: string | number | null;
      reason_code: string | null;
      condition: LossCondition | null;
      note: string | null;
      origin: 'stock' | 'defective';
    }>;

    const truncated = rows.length > limit;
    return {
      truncated,
      lines: rows.slice(0, limit).map((r) => ({
        section: r.section,
        date: toIso(r.created_at),
        documentId: r.doc_id,
        parentId: r.parent_id,
        ref: r.ref,
        counterparty: r.counterparty,
        by: r.by_name,
        productId: r.product_id,
        productName: r.product_name,
        quantityType: r.quantity_type,
        qty: round3(Number(r.qty)),
        value: round2(Number(r.value ?? 0)),
        saleValue: r.sale_value === null ? null : round2(Number(r.sale_value)),
        reasonCode: r.reason_code,
        condition: r.condition,
        note: r.note,
        origin: r.origin,
      })),
    };
  }

  /** Defective stock on hand now, at cost (a weighed product counts as one). */
  private async defectiveBalance(
    businessId: string,
    range: DateRange,
  ): Promise<{qty: number; value: number}> {
    const [row] = (await this.db.execute(sql`
      SELECT COALESCE(SUM(CASE WHEN p.quantity_type = 'kg' THEN 1 ELSE l.qty_remaining END), 0) AS qty,
             COALESCE(SUM(l.qty_remaining * l.unit_cost), 0) AS value
      FROM (
        SELECT product_id, branch_id, SUM(qty_remaining) AS qty_remaining,
               SUM(qty_remaining * unit_cost) / NULLIF(SUM(qty_remaining), 0) AS unit_cost
        FROM defective_lots
        WHERE business_id = ${businessId} AND qty_remaining > 0
          ${range.branchId ? sql`AND branch_id = ${range.branchId}` : sql``}
        GROUP BY product_id, branch_id
      ) l
      LEFT JOIN products p ON p.id = l.product_id
    `)) as unknown as Array<{qty: string; value: string}>;
    return {
      qty: round3(Number(row?.qty ?? 0)),
      value: round2(Number(row?.value ?? 0)),
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private bucketOf(range: DateRange): 'day' | 'month' {
    if (!range.from || !range.to) return 'month';
    const days =
      (businessDayEnd(range.to).getTime() -
        businessDayStart(range.from).getTime()) /
      86_400_000;
    return days <= DAILY_TREND_MAX_DAYS ? 'day' : 'month';
  }

  /** Loss per period bucket, gaps filled when the range is bounded. */
  private async trend(
    businessId: string,
    range: DateRange,
    lines: SQL,
  ): Promise<LossesReport['trend']> {
    const bucket = this.bucketOf(range);
    // Whitelisted literal, inlined with sql.raw: the same text sits in SELECT
    // and GROUP BY, and a bound parameter there would be two expressions to
    // Postgres. created_at is UTC wall-time; +5h is the business day.
    const fmt = bucket === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
    const rows = (await this.db.execute(sql`
      WITH lines AS (${lines})
      SELECT to_char(created_at + interval '5 hours', '${sql.raw(fmt)}') AS bucket,
             section, condition,
             COALESCE(SUM(value), 0) AS value
      FROM lines
      GROUP BY to_char(created_at + interval '5 hours', '${sql.raw(fmt)}'),
               section, condition
      ORDER BY 1
    `)) as unknown as Array<{
      bucket: string;
      section: LossSection;
      condition: LossCondition | null;
      value: string;
    }>;

    const out = new Map<string, LossesReport['trend'][number]>();
    const slot = (b: string) => {
      let row = out.get(b);
      if (!row) {
        row = {
          bucket: b,
          customerDefective: 0,
          supplier: 0,
          writeOff: 0,
          countNet: 0,
        };
        out.set(b, row);
      }
      return row;
    };
    for (const b of this.bucketsBetween(range, bucket)) slot(b);
    for (const r of rows) {
      const row = slot(r.bucket);
      const v = Number(r.value);
      if (r.section === 'customer') {
        if (r.condition === 'defective') row.customerDefective += v;
      } else if (r.section === 'supplier') row.supplier += v;
      else if (r.section === 'writeoff') row.writeOff += v;
      else if (r.section === 'count') {
        row.countNet += r.condition === 'surplus' ? -v : v;
      }
      // 'defective' moves are inventory flows, not losses — no trend series.
    }
    return [...out.values()]
      .sort((a, b) => a.bucket.localeCompare(b.bucket))
      .map((r) => ({
        bucket: r.bucket,
        customerDefective: round2(r.customerDefective),
        supplier: round2(r.supplier),
        writeOff: round2(r.writeOff),
        countNet: round2(r.countNet),
      }));
  }

  /** Every bucket key in [from, to] so quiet days/months show as zero. */
  private bucketsBetween(range: DateRange, bucket: 'day' | 'month'): string[] {
    if (!range.from || !range.to) return [];
    const out: string[] = [];
    const [fy, fm, fd] = range.from.slice(0, 10).split('-').map(Number);
    const [ty, tm, td] = range.to.slice(0, 10).split('-').map(Number);
    if (bucket === 'day') {
      const end = Date.UTC(ty, tm - 1, td);
      for (let t = Date.UTC(fy, fm - 1, fd); t <= end; t += 86_400_000) {
        out.push(new Date(t).toISOString().slice(0, 10));
      }
    } else {
      for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); ) {
        out.push(`${y}-${String(m).padStart(2, '0')}`);
        if (++m > 12) {
          m = 1;
          y++;
        }
      }
    }
    return out;
  }

  /**
   * The four flows as one line-level relation with shared columns. Legacy rows
   * with no branch (a receipt or count from before branches) belong to the
   * default branch, so filtering by the default branch includes them.
   */
  private async linesCte(businessId: string, range: DateRange): Promise<SQL> {
    // Raw templates can't bind a Date (postgres-js) — pass the UTC instant as
    // a string; created_at is stored as UTC wall-time.
    const toPg = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
    const from = range.from ? toPg(businessDayStart(range.from)) : null;
    const to = range.to ? toPg(businessDayEnd(range.to)) : null;
    const dates = (col: SQL) => {
      const c: SQL[] = [];
      if (from) c.push(sql`${col} >= ${from}`);
      if (to) c.push(sql`${col} <= ${to}`);
      return c.length ? sql` AND ${sql.join(c, sql` AND `)}` : sql``;
    };

    let branch: (col: SQL) => SQL = () => sql``;
    if (range.branchId) {
      const [def] = (await this.db.execute(sql`
        SELECT is_default FROM branches
        WHERE id = ${range.branchId} AND business_id = ${businessId}
        LIMIT 1
      `)) as unknown as Array<{is_default: boolean}>;
      const isDefault = def?.is_default === true;
      const id = range.branchId;
      branch = (col: SQL) =>
        isDefault
          ? sql` AND (${col} = ${id} OR ${col} IS NULL)`
          : sql` AND ${col} = ${id}`;
    }
    const units = (qty: SQL) =>
      sql`CASE WHEN p.quantity_type = 'kg' THEN 1 ELSE ${qty} END`;

    return sql`
      SELECT 'customer'::text AS section, sr.id AS doc_id, sr.order_id AS parent_id,
             ('#' || sr.order_receipt_no)::text AS ref,
             sr.customer_name::text AS counterparty,
             sr.cashier_name::text AS by_name, sr.created_at,
             sri.product_id, sri.product_name::text AS product_name, p.quantity_type::text AS quantity_type,
             sri.quantity::float8 AS qty,
             (${units(sql`sri.quantity`)})::float8 AS units,
             sri.cost_total::numeric AS value,
             sri.net_amount::numeric AS sale_value,
             sr.reason_code::text AS reason_code,
             (CASE WHEN sri.restock THEN 'restocked'
                   WHEN sri.disposition = 'defective_stock' THEN 'defective_stock'
                   ELSE 'defective' END)::text AS condition,
             sr.reason::text AS note,
             'stock'::text AS origin
      FROM sale_return_items sri
      JOIN sale_returns sr ON sr.id = sri.return_id
      LEFT JOIN products p ON p.id = sri.product_id
      WHERE sr.business_id = ${businessId}
        ${dates(sql`sr.created_at`)}
        ${branch(sql`sr.branch_id`)}

      UNION ALL

      SELECT 'supplier', r.id, r.receipt_id,
             NULL::text,
             r.supplier_name::text,
             r.cashier_name::text, r.created_at,
             i.product_id, i.product_name::text, p.quantity_type::text,
             i.quantity::float8,
             (${units(sql`i.quantity`)})::float8,
             (i.line_total * CASE WHEN r.currency = 'USD'
                                  THEN COALESCE(gr.usd_rate, 0) ELSE 1 END)::numeric,
             NULL::numeric,
             i.reason_code::text,
             NULL::text,
             COALESCE(i.note, r.note)::text,
             (CASE WHEN r.source = 'defective' THEN 'defective' ELSE 'stock' END)::text
      FROM supplier_return_items i
      JOIN supplier_returns r ON r.id = i.return_id
      JOIN goods_receipts gr ON gr.id = r.receipt_id
      LEFT JOIN products p ON p.id = i.product_id
      WHERE r.business_id = ${businessId}
        ${dates(sql`r.created_at`)}
        ${branch(sql`gr.branch_id`)}

      UNION ALL

      SELECT 'writeoff', st.id, NULL::varchar,
             st.name::text,
             NULL::text,
             st.created_by_cashier_name::text, st.completed_at,
             i.product_id, i.product_name::text, p.quantity_type::text,
             (-i.diff_qty)::float8,
             (${units(sql`-i.diff_qty`)})::float8,
             (-COALESCE(i.diff_value, 0))::numeric,
             NULL::numeric,
             i.reason_code::text,
             NULL::text,
             i.reason::text,
             'stock'::text
      FROM stock_take_items i
      JOIN stock_takes st ON st.id = i.stock_take_id
      LEFT JOIN products p ON p.id = i.product_id
      WHERE st.business_id = ${businessId}
        AND st.type = 'writeoff' AND st.status = 'completed'
        ${dates(sql`st.completed_at`)}
        ${branch(sql`COALESCE(i.branch_id, st.store_id)`)}

      UNION ALL

      -- Write-offs out of defective stock, at the expense they booked (an
      -- opening lot was a loss already and books none).
      SELECT 'writeoff', m.id, NULL::varchar,
             NULL::text,
             NULL::text,
             m.cashier_name::text, m.created_at,
             i.product_id, i.product_name::text, p.quantity_type::text,
             i.quantity::float8,
             (${units(sql`i.quantity`)})::float8,
             i.loss_value::numeric,
             NULL::numeric,
             COALESCE(i.reason_code, m.reason_code)::text,
             NULL::text,
             COALESCE(i.note, m.note)::text,
             'defective'::text
      FROM defective_movement_items i
      JOIN defective_movements m ON m.id = i.movement_id
      LEFT JOIN products p ON p.id = i.product_id
      WHERE m.business_id = ${businessId}
        AND m.type = 'out_writeoff'
        ${dates(sql`m.created_at`)}
        ${branch(sql`m.branch_id`)}

      UNION ALL

      SELECT 'count', st.id, NULL::varchar,
             st.name::text,
             NULL::text,
             st.created_by_cashier_name::text, st.completed_at,
             i.product_id, i.product_name::text, p.quantity_type::text,
             ABS(i.diff_qty)::float8,
             (${units(sql`ABS(i.diff_qty)`)})::float8,
             ABS(COALESCE(i.diff_value, 0))::numeric,
             NULL::numeric,
             NULL::text,
             (CASE WHEN i.diff_qty < 0 THEN 'shortage' ELSE 'surplus' END)::text,
             i.reason::text,
             'stock'::text
      FROM stock_take_items i
      JOIN stock_takes st ON st.id = i.stock_take_id
      LEFT JOIN products p ON p.id = i.product_id
      WHERE st.business_id = ${businessId}
        AND st.type IN ('full', 'partial') AND st.status = 'completed'
        AND ABS(i.diff_qty) > 0.0000001
        ${dates(sql`st.completed_at`)}
        ${branch(sql`st.store_id`)}

      UNION ALL

      -- Yaroqsiz tovarlar ombori flows, at cost: condition = movement type.
      SELECT 'defective', m.id,
             COALESCE(m.receipt_id, m.sale_return_id)::varchar,
             NULL::text,
             m.supplier_name::text,
             m.cashier_name::text, m.created_at,
             i.product_id, i.product_name::text, p.quantity_type::text,
             i.quantity::float8,
             (${units(sql`i.quantity`)})::float8,
             i.cost_total::numeric,
             NULL::numeric,
             COALESCE(i.reason_code, m.reason_code)::text,
             m.type::text,
             COALESCE(i.note, m.note)::text,
             'defective'::text
      FROM defective_movement_items i
      JOIN defective_movements m ON m.id = i.movement_id
      LEFT JOIN products p ON p.id = i.product_id
      WHERE m.business_id = ${businessId}
        ${dates(sql`m.created_at`)}
        ${branch(sql`m.branch_id`)}
    `;
  }
}

function toIso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  // timestamp without time zone comes back as "YYYY-MM-DD HH:MM:SS[.fff]" in
  // UTC wall-time — mark it as UTC.
  return new Date(`${v.replace(' ', 'T')}Z`).toISOString();
}
