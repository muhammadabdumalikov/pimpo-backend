// Pure reconciliation math for a cashier shift — no DB, so it is unit-testable.
// Given the shift's sales and manual cash movements, it produces the per payment
// method × currency grid (Наличные / Карта / В долг, UZS/USD) that the close
// screen (Z-report) and the live X-report render.

export interface ReconRow {
  method: 'cash' | 'card' | 'debt';
  currency: 'UZS' | 'USD';
  opening: number;
  in: number;
  out: number;
  expected: number;
  counted: number | null;
  diff: number | null;
}

/** A sale belonging to the shift: its total and per-method paid breakdown. */
export interface SaleForRecon {
  totalAmount: number | string;
  // [{ method: 'cash' | 'card', amount }]; the debt remainder is total − Σpaid.
  payments: {method: string; amount: number}[] | null;
}

/** A manual cash movement (paid-in / paid-out) within the shift. */
export interface MovementForRecon {
  isCash: boolean;
  currency: string; // 'UZS' | 'USD'
  type: string; // 'in' | 'out'
  amount: number | string;
}

export interface ReconInput {
  openingFloat: number;
  sales: SaleForRecon[];
  movements: MovementForRecon[];
  /** Counted amounts keyed `${method}:${currency}` (from close); optional (X-report). */
  counted?: Map<string, number>;
}

export interface SaleTotals {
  cashSales: number;
  cardSales: number;
  debtSales: number;
}

export function computeReconciliation(input: ReconInput): {
  rows: ReconRow[];
  orderCount: number;
  hasUsd: boolean;
  saleTotals: SaleTotals;
} {
  const {openingFloat, sales, movements, counted} = input;

  // Sales split by payment type (all in UZS today).
  let cashSales = 0;
  let cardSales = 0;
  let debtSales = 0;
  for (const o of sales) {
    const pays = o.payments ?? [];
    let paidNow = 0;
    for (const p of pays) {
      paidNow += p.amount;
      if (p.method === 'cash') cashSales += p.amount;
      else if (p.method === 'card') cardSales += p.amount;
    }
    const total = Number(o.totalAmount);
    debtSales += Math.max(0, total - paidNow); // the "В долг" remainder
  }

  // Manual movements: cash movements adjust the cash row, non-cash the card row.
  const mv = {
    cash: {UZS: {in: 0, out: 0}, USD: {in: 0, out: 0}},
    card: {UZS: {in: 0, out: 0}, USD: {in: 0, out: 0}},
  };
  let hasUsd = false;
  for (const m of movements) {
    const bucket = m.isCash ? 'cash' : 'card';
    const cur = m.currency === 'USD' ? 'USD' : 'UZS';
    if (cur === 'USD') hasUsd = true;
    const amt = Number(m.amount);
    mv[bucket][cur][m.type === 'out' ? 'out' : 'in'] += amt;
  }

  const get = (method: string, currency: string) =>
    counted?.get(`${method}:${currency}`);

  const mkRow = (
    method: 'cash' | 'card' | 'debt',
    currency: 'UZS' | 'USD',
    opening: number,
    inAmt: number,
    outAmt: number,
  ): ReconRow => {
    const expected = opening + inAmt - outAmt;
    const c = get(method, currency);
    const countedVal = c === undefined ? null : c;
    return {
      method,
      currency,
      opening,
      in: inAmt,
      out: outAmt,
      expected,
      counted: countedVal,
      diff: countedVal === null ? null : countedVal - expected,
    };
  };

  const rows: ReconRow[] = [
    mkRow(
      'cash',
      'UZS',
      openingFloat,
      cashSales + mv.cash.UZS.in,
      mv.cash.UZS.out,
    ),
    mkRow('card', 'UZS', 0, cardSales + mv.card.UZS.in, mv.card.UZS.out),
    mkRow('debt', 'UZS', 0, debtSales, 0),
  ];
  if (hasUsd) {
    rows.push(
      mkRow('cash', 'USD', 0, mv.cash.USD.in, mv.cash.USD.out),
      mkRow('card', 'USD', 0, mv.card.USD.in, mv.card.USD.out),
    );
  }

  return {
    rows,
    orderCount: sales.length,
    hasUsd,
    saleTotals: {cashSales, cardSales, debtSales},
  };
}
