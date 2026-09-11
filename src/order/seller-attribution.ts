import {sql} from 'drizzle-orm';
import {orders} from '../database/schema';

// Who a sale is credited to: the salesperson picked at the register, else the
// cashier who rang it up (every sale before sellers existed, and every sale
// where nobody was picked). Shared by the sellers report, sales-by-employee and
// the payroll %-of-own-sales so all three always agree on whose sale it was.
//
// Column-only fragments with no bind params, so they are safe to reuse in both
// SELECT and GROUP BY (see the parametered-fragment gotcha in report.service).
export const creditedStaffId = sql<
  string | null
>`COALESCE(${orders.sellerId}, ${orders.cashierId})`;

/** Aggregate — the display name of the credited person within a group. */
export const creditedStaffName = sql<
  string | null
>`MAX(CASE WHEN ${orders.sellerId} IS NOT NULL THEN ${orders.sellerName} ELSE ${orders.cashierName} END)`;
