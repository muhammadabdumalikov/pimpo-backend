/** DI token for the read-only postgres-js client. */
export const AI_SQL_CLIENT = Symbol('AI_SQL_CLIENT');

export const AI_SQL_DEFAULTS = {
  /** Rows returned to the model. One extra is fetched to detect truncation. */
  maxRows: 500,
  statementTimeoutMs: 5_000,
  idleInTxTimeoutMs: 5_000,
  /**
   * Planner cost ceiling, checked via EXPLAIN before anything executes. Tuned
   * to reject full-table cross joins on a 2 vCPU host while leaving normal
   * per-shop analytics (tens of thousands of rows) comfortable headroom.
   */
  maxPlanCost: 5_000_000,
} as const;

/**
 * Tables the assistant may query.
 *
 * MUST stay in sync with the GRANT list in drizzle/0062_ai_ro_role_rls.sql.
 * The grants are the real boundary; this list exists so a wrong table name
 * fails with a message the model can act on instead of a bare 42501.
 */
export const ALLOWED_TABLES: ReadonlySet<string> = new Set([
  'accounts',
  'account_balances',
  'branches',
  'branch_stock',
  'brands',
  'cash_movements',
  'cash_operation_categories',
  'cash_registers',
  'cash_shifts',
  'categories',
  'debt_payments',
  'financial_categories',
  'financial_transactions',
  'goods_receipts',
  'goods_receipt_items',
  'inventory_batches',
  'loyalty_transactions',
  'monthly_targets',
  'order_items',
  'orders',
  'payment_methods',
  'payroll_entries',
  'products',
  'staff',
  'stock_take_items',
  'stock_takes',
  'stock_transfer_items',
  'stock_transfers',
  'supplier_payments',
  'supplier_return_items',
  'supplier_returns',
  'suppliers',
  'units',
  'user_debts',
  'users',
]);

/**
 * Functions the model may call. An allowlist rather than a denylist: every
 * extension install adds new callable functions, and a denylist silently stops
 * covering them.
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'array_agg',
  'string_agg',
  'jsonb_agg',
  'stddev',
  'variance',
  'percentile_cont',
  // numeric
  'round',
  'abs',
  'ceil',
  'ceiling',
  'floor',
  'greatest',
  'least',
  'mod',
  'div',
  'sqrt',
  'power',
  'trunc',
  // null handling
  'coalesce',
  'nullif',
  // date & time
  'date_trunc',
  'to_char',
  'to_date',
  'extract',
  'age',
  'now',
  'date_part',
  'make_date',
  'generate_series',
  // json
  'jsonb_array_elements',
  'jsonb_array_elements_text',
  'json_array_elements',
  'jsonb_extract_path_text',
  // text
  'concat',
  'concat_ws',
  'lower',
  'upper',
  'trim',
  'btrim',
  'ltrim',
  'rtrim',
  'length',
  'substring',
  'substr',
  'split_part',
  'replace',
  'left',
  'right',
  'position',
  'initcap',
  // window
  'row_number',
  'rank',
  'dense_rank',
  'lag',
  'lead',
  'first_value',
  'last_value',
  'ntile',
]);
