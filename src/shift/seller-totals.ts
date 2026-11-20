// A shift's sales per person credited with them, net of the returns settled in
// the shift — pure merge, no DB, so it is unit-testable. Who a sale belongs to
// is the sellers report's rule (order/seller-attribution): the seller picked at
// the register, else the cashier who rang it up.

export interface ShiftSellerTotal {
  /** Credited staff id; null for sales nobody is credited with (storefront). */
  staffId: string | null;
  name: string | null;
  orderCount: number;
  /** Sales minus returns — the figure the sellers report and payroll % use. */
  revenue: number;
  /** Returns of this person's sales settled in the shift (already in `revenue`). */
  returns: number;
}

export interface SellerSalesRow {
  staffId: string | null;
  name: string | null;
  orderCount: number | string;
  revenue: number | string;
}

export interface SellerReturnsRow {
  staffId: string | null;
  name: string | null;
  value: number | string;
}

export function mergeSellerTotals(
  sales: SellerSalesRow[],
  returns: SellerReturnsRow[],
): ShiftSellerTotal[] {
  const retMap = new Map(returns.map((r) => [r.staffId, r]));
  const out: ShiftSellerTotal[] = sales.map((r) => {
    const ret = retMap.get(r.staffId);
    retMap.delete(r.staffId);
    const returned = Number(ret?.value ?? 0);
    return {
      staffId: r.staffId,
      name: r.name ?? ret?.name ?? null,
      orderCount: Number(r.orderCount),
      revenue: Number(r.revenue) - returned,
      returns: returned,
    };
  });
  // Someone whose earlier sale came back in this shift, with no sale in it.
  for (const ret of retMap.values()) {
    const returned = Number(ret.value);
    out.push({
      staffId: ret.staffId,
      name: ret.name ?? null,
      orderCount: 0,
      revenue: -returned,
      returns: returned,
    });
  }
  return out.sort((a, b) => b.revenue - a.revenue);
}
