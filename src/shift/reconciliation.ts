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
  // [{ method: <payment-method code>, amount }]; 'cash' hits the cash row, any
  // other code (card + custom methods like Click) the card (non-cash) row; the
  // debt remainder is total − Σpaid.
  payments: {method: string; amount: number}[] | null;
}

/** A manual cash movement (paid-in / paid-out) within the shift. */
export interface MovementForRecon {
  isCash: boolean;
  currency: string; // 'UZS' | 'USD'
  type: string; // 'in' | 'out'
  amount: number | string;
}

/**
 * A customer return settled in the shift: the money refunded per method (cash
 * leaves the drawer, anything else the card row) and the debt written down.
 */
export interface ReturnForRecon {
  refunds: {method: string; amount: number}[] | null;
  debtReduced: number | string;
}

export interface ReconInput {
  openingFloat: number;
  sales: SaleForRecon[];
  movements: MovementForRecon[];
  /** Returns paid out in this shift (optional for older callers/tests). */
  returns?: ReturnForRecon[];
  /** Counted amounts keyed `${method}:${currency}` (from close); optional (X-report). */
  counted?: Map<string, number>;
}

export interface SaleTotals {
  cashSales: number;
  cardSales: number;
  debtSales: number;
  /** Money handed back on returns in this shift. */
  cashRefunds: number;
  cardRefunds: number;
  debtReduced: number;
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
      // 'cash' is the only method with change/reconciliation semantics; every
      // other code (card, and custom methods like Click) falls into the card
      // (non-cash) bucket so it still shows up in the grid.
      if (p.method === 'cash') cashSales += p.amount;
      else cardSales += p.amount;
    }
    const total = Number(o.totalAmount);
    debtSales += Math.max(0, total - paidNow); // the "В долг" remainder
  }

  // Returns: refunds leave the drawer / card row like a paid-out; a debt
  // write-down shows as an "out" on the debt row.
  let cashRefunds = 0;
  let cardRefunds = 0;
  let debtReduced = 0;
  for (const r of input.returns ?? []) {
    for (const p of r.refunds ?? []) {
      if (p.method === 'cash') cashRefunds += p.amount;
      else cardRefunds += p.amount;
    }
    debtReduced += Number(r.debtReduced);
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
      mv.cash.UZS.out + cashRefunds,
    ),
    mkRow(
      'card',
      'UZS',
      0,
      cardSales + mv.card.UZS.in,
      mv.card.UZS.out + cardRefunds,
    ),
    mkRow('debt', 'UZS', 0, debtSales, debtReduced),
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
    saleTotals: {
      cashSales,
      cardSales,
      debtSales,
      cashRefunds,
      cardRefunds,
      debtReduced,
    },
  };
}
