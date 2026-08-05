/**
 * The half of the schema description that DDL cannot express.
 *
 * Every line here exists because getting it wrong produces either a runtime
 * error or — worse — a plausible but wrong number. Hand-maintained and
 * reviewed; the structural half is generated (schema-doc.generated.ts).
 */
export const SCHEMA_DOC_NOTES = `
# Rules

- Return exactly ONE SELECT statement. No semicolons, no comments, no CTE that writes.
- Rows are ALREADY filtered to the current shop by the database. NEVER add a
  business_id condition yourself, and never ask for a business id.
- Alias every computed column (\`AS revenue\`) and give every output column a
  unique name — duplicate names are silently collapsed on the way back.
- Always ORDER BY explicitly when the answer is a ranking, and LIMIT it.
- Money columns are numeric and arrive as strings; cast when you compare them.

# Accounting rules

- Every sales, revenue, or profit figure filters \`orders.status = 'Completed'\`.
  Pending, Held and Cancelled orders are not sales.
- COGS lives on order_items.cost_total, but it is 0 on rows created before the
  costing migration. Always fall back:
    COALESCE(NULLIF(oi.cost_total, 0), oi.quantity * p.price_in)
- orders.payments is jsonb: an array of {method, amount}. For a payment-method
  breakdown use
    LATERAL jsonb_array_elements(COALESCE(o.payments, '[]'::jsonb)) AS elem
  and read elem->>'method' / (elem->>'amount')::numeric.
  orders.payment_method is a legacy single value; prefer the jsonb array.
- A customer's remaining debt is user_debts.amount minus the sum of that debt's
  debt_payments rows — not user_debts.amount on its own.

# Time

- Timestamps are \`timestamp\` WITHOUT time zone, stored as UTC wall time.
- The business day is Asia/Tashkent, a fixed +05:00 with no daylight saving.
  For any day / week / month bucketing, shift first:
    date_trunc('day', o.created_at + interval '5 hours')
  A query that buckets on raw created_at will attribute five hours of every
  evening's sales to the wrong day.

# Type traps

- products.quantity is \`double precision\` (shops sell fractional kilograms).
  ROUND() has no (double precision, integer) overload, so
  \`ROUND(quantity, 2)\` throws at runtime. Cast first: ROUND(quantity::numeric, 2).
  The same applies to AVG() and SUM() over that column.
- categories has a COMPOSITE PRIMARY KEY (business_id, id). Every join to it
  must match both columns:
    ON p.category_id = c.id AND p.business_id = c.business_id
  Joining on id alone silently multiplies rows.
- units.business_id IS NULL means a shared system unit — those rows are visible
  on purpose, alongside the shop's own.
- branch_stock is the source of truth for per-branch stock on hand;
  products.quantity is the denormalised total across all branches.
- inventory_batches is the FIFO lot ledger: SUM(qty_remaining) per product
  equals products.quantity.

# Not readable

- Passwords, logins, bot tokens and integration credentials are not granted to
  you and never will be. Do not try to select them.
- Customer phone, email and address are withheld. Customer name, spend and
  bonus balance are available.
`;
