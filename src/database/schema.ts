import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  decimal,
  jsonb,
  uniqueIndex,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import {relations} from 'drizzle-orm';

export const businesses = pgTable('businesses', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  name: varchar('name', {length: 255}).notNull(),
  email: varchar('email', {length: 255}).notNull().unique(),
  login: varchar('login', {length: 100}).notNull().unique(),
  password: varchar('password', {length: 255}).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const roles = pgTable(
  'roles',
  {
    id: varchar('id', {length: 36}).primaryKey().notNull(),
    businessId: varchar('business_id', {length: 36})
      .notNull()
      .references(() => businesses.id, {onDelete: 'cascade'}),
    name: varchar('name', {length: 255}).notNull(),
    // Array of sidebar menu keys this role is allowed to see, e.g.
    // ["ecommerce.products", "userDebt"]. Matches the frontend menu catalog.
    menuKeys: jsonb('menu_keys').$type<string[]>().notNull().default([]),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueNameBusiness: uniqueIndex('unique_role_name_business').on(
      table.businessId,
      table.name,
    ),
  }),
);

export const staff = pgTable('staff', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  roleId: varchar('role_id', {length: 36})
    .notNull()
    .references(() => roles.id),
  name: varchar('name', {length: 255}).notNull(),
  // Globally unique so the unified login lookup is unambiguous.
  login: varchar('login', {length: 100}).notNull().unique(),
  password: varchar('password', {length: 255}).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const subscriptionPlans = pgTable('subscription_plans', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  tier: varchar('tier', {length: 50}).notNull().unique(),
  name: varchar('name', {length: 255}).notNull(),
  description: varchar('description', {length: 500}),
  price: decimal('price', {precision: 10, scale: 2}).notNull().default('0'),
  isActive: boolean('is_active').default(true).notNull(),
  debtsLimit: integer('debts_limit'),
  productsLimit: integer('products_limit'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const businessSubscriptions = pgTable('business_subscriptions', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  planId: varchar('plan_id', {length: 36})
    .notNull()
    .references(() => subscriptionPlans.id),
  startDate: timestamp('start_date', {withTimezone: true})
    .defaultNow()
    .notNull(),
  endDate: timestamp('end_date', {withTimezone: true}),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const products = pgTable('products', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  name: varchar('name', {length: 255}).notNull(),
  code: varchar('code', {length: 100}),
  barcode: varchar('barcode', {length: 100}),
  priceIn: decimal('price_in', {precision: 10, scale: 2}).notNull(),
  priceOut: decimal('price_out', {precision: 10, scale: 2}).notNull(),
  quantity: integer('quantity').default(0).notNull(),
  quantityType: varchar('quantity_type', {length: 50}),
  image: varchar('image', {length: 500}),
  categoryId: varchar('category_id', {length: 100}),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Shared, cross-business barcode catalog. Populated whenever any business creates
// a product with a barcode, so other businesses that scan the same barcode can
// auto-fill name/image instead of typing everything by hand (our "GS1"-style
// lookup, built from community data). Keyed by barcode; not scoped to a business.
export const globalBarcodes = pgTable('global_barcodes', {
  barcode: varchar('barcode', {length: 100}).primaryKey().notNull(),
  name: varchar('name', {length: 255}).notNull(),
  categoryName: varchar('category_name', {length: 255}),
  image: varchar('image', {length: 500}),
  source: varchar('source', {length: 50}).default('community').notNull(),
  timesUsed: integer('times_used').default(1).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const categories = pgTable(
  'categories',
  {
    id: varchar('id', {length: 100}).notNull(),
    businessId: varchar('business_id', {length: 36})
      .notNull()
      .references(() => businesses.id, {onDelete: 'cascade'}),
    name: varchar('name', {length: 255}).notNull(),
    image: varchar('image', {length: 500}),
    isDeleted: boolean('is_deleted').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({columns: [table.businessId, table.id]}),
  }),
);

export const users = pgTable(
  'users',
  {
    id: varchar('id', {length: 36}).primaryKey().notNull(),
    businessId: varchar('business_id', {length: 36})
      .notNull()
      .references(() => businesses.id, {onDelete: 'cascade'}),
    name: varchar('name', {length: 255}).notNull(),
    phone: varchar('phone', {length: 50}).notNull(),
    email: varchar('email', {length: 255}),
    address: varchar('address', {length: 500}),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniquePhoneBusiness: uniqueIndex('unique_phone_business').on(
      table.phone,
      table.businessId,
    ),
  }),
);

export const userDebts = pgTable('user_debts', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  userId: varchar('user_id', {length: 36})
    .notNull()
    .references(() => users.id, {onDelete: 'cascade'}),
  // The POS sale this debt came from (null for manually-entered debts). Gives
  // "what was bought, when" via the order + its items.
  orderId: varchar('order_id', {length: 36}).references(() => orders.id, {
    onDelete: 'set null',
  }),

  amount: decimal('amount', {precision: 10, scale: 2}).notNull(),
  status: varchar('status', {length: 20}).notNull().default('Pending'), // 'Paid' | 'Pending' | 'Overdue'
  // Optional: a debt with no due date is open-ended and never auto-marks Overdue.
  dueDate: timestamp('due_date', {withTimezone: true}),
  description: varchar('description', {length: 500}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Installment payments made against a debt. A debt's remaining balance is
// `user_debts.amount - SUM(debt_payments.amount)`; status is derived from that
// (Paid when remaining <= 0, Partial when some paid, else Pending/Overdue).
export const debtPayments = pgTable('debt_payments', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  debtId: varchar('debt_id', {length: 36})
    .notNull()
    .references(() => userDebts.id, {onDelete: 'cascade'}),
  amount: decimal('amount', {precision: 10, scale: 2}).notNull(),
  method: varchar('method', {length: 20}).notNull().default('cash'), // 'cash' | 'card'
  note: varchar('note', {length: 500}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const orders = pgTable(
  'orders',
  {
    id: varchar('id', {length: 36}).primaryKey().notNull(),
    businessId: varchar('business_id', {length: 36})
      .notNull()
      .references(() => businesses.id, {onDelete: 'cascade'}),
    // Client-supplied idempotency key (UUID) for offline sales. A sale rung up
    // while offline is queued locally and may be POSTed more than once over a
    // flaky connection; a repeat with the same clientId returns the existing
    // order instead of creating a duplicate (guarded by the unique index below).
    // Null for online/storefront orders and rows created before offline sync.
    clientId: varchar('client_id', {length: 36}),
    // Optional customer this order belongs to.
    userId: varchar('user_id', {length: 36}).references(() => users.id, {
      onDelete: 'set null',
    }),
    // Snapshot of the customer name (for guest/store orders without a user row).
    customerName: varchar('customer_name', {length: 255}),
    status: varchar('status', {length: 20}).notNull().default('Pending'), // 'Pending' | 'Completed' | 'Cancelled' | 'Held' (parked cart — stock untouched)
    totalAmount: decimal('total_amount', {precision: 12, scale: 2})
      .notNull()
      .default('0'),
    // Gross total before any whole-receipt discount (= sum of line totals).
    subtotalAmount: decimal('subtotal_amount', {precision: 12, scale: 2})
      .notNull()
      .default('0'),
    // Manual whole-receipt discount applied at checkout. `discountType` is
    // 'amount' (fixed soʻm) or 'percent'; `discountValue` is what the cashier
    // typed; `discountAmount` is the resolved soʻm reduction (subtotal - total).
    discountType: varchar('discount_type', {length: 10}),
    discountValue: decimal('discount_value', {precision: 12, scale: 2}),
    discountAmount: decimal('discount_amount', {precision: 12, scale: 2})
      .notNull()
      .default('0'),
    itemCount: integer('item_count').notNull().default(0),
    // Summary method: 'cash' | 'card' | 'split'.
    paymentMethod: varchar('payment_method', {length: 50}),
    // Per-method breakdown applied to the sale, summing to totalAmount.
    // Shape: [{ method: 'cash' | 'card', amount: number }].
    payments: jsonb('payments'),
    // Cash physically tendered and change returned (for drawer reconciliation).
    amountPaid: decimal('amount_paid', {precision: 12, scale: 2}),
    changeAmount: decimal('change_amount', {precision: 12, scale: 2}),
    // VAT (QQS) portion of the (VAT-inclusive) total at sale time.
    taxRate: decimal('tax_rate', {precision: 5, scale: 2}),
    taxAmount: decimal('tax_amount', {precision: 12, scale: 2}),
    note: varchar('note', {length: 500}),
    source: varchar('source', {length: 20}).notNull().default('admin'), // 'admin' | 'store'
    // Who rang up the sale (the acting account): business owner id or staff id.
    // Null for storefront/guest orders and pre-migration rows. Name is snapshotted
    // so the report survives staff renames/deletions.
    cashierId: varchar('cashier_id', {length: 36}),
    cashierName: varchar('cashier_name', {length: 255}),
    // Cashier shift this sale belongs to (null for storefront/guest and
    // pre-migration rows). The register is derived from the shift.
    shiftId: varchar('shift_id', {length: 36}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    // Idempotency guard for offline order sync. NULL client_ids are distinct in
    // a Postgres unique index, so online/storefront orders never collide.
    uniqueClientBusiness: uniqueIndex('unique_order_client_business').on(
      table.businessId,
      table.clientId,
    ),
  }),
);

export const orderItems = pgTable('order_items', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  orderId: varchar('order_id', {length: 36})
    .notNull()
    .references(() => orders.id, {onDelete: 'cascade'}),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  // Product reference is kept loose: products may be deleted later, but the
  // order keeps its name/price snapshot.
  productId: varchar('product_id', {length: 36}),
  productName: varchar('product_name', {length: 255}).notNull(),
  // Weighted selling price of the line at sale time (lineTotal / quantity).
  // With batch pricing a single line can span batches at different prices.
  priceOut: decimal('price_out', {precision: 10, scale: 2}).notNull(),
  quantity: integer('quantity').notNull(),
  lineTotal: decimal('line_total', {precision: 12, scale: 2}).notNull(),
  // COGS snapshot at sale time (immutable history, independent of later price
  // changes or the costing method). 0 for pre-migration rows.
  costIn: decimal('cost_in', {precision: 10, scale: 2}).notNull().default('0'),
  costTotal: decimal('cost_total', {precision: 12, scale: 2})
    .notNull()
    .default('0'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Suppliers (vendors) goods are received from. Scoped per business.
export const suppliers = pgTable('suppliers', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  name: varchar('name', {length: 255}).notNull(),
  phone: varchar('phone', {length: 50}),
  note: varchar('note', {length: 500}),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Goods receipt ("приход товаров") — an inbound stock document, the inverse of
// an order. Created as 'Completed' and immutable thereafter; corrections are a
// new offsetting receipt. Saving one increments product stock and recomputes
// each product's weighted-average priceIn (see receipt.service).
export const goodsReceipts = pgTable('goods_receipts', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  // Optional: supplier may be deleted later; the receipt keeps its snapshot name.
  supplierId: varchar('supplier_id', {length: 36}).references(
    () => suppliers.id,
    {onDelete: 'set null'},
  ),
  supplierName: varchar('supplier_name', {length: 255}),
  status: varchar('status', {length: 20}).notNull().default('Completed'), // 'Completed'
  totalAmount: decimal('total_amount', {precision: 12, scale: 2})
    .notNull()
    .default('0'),
  itemCount: integer('item_count').notNull().default(0),
  note: varchar('note', {length: 500}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const goodsReceiptItems = pgTable('goods_receipt_items', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  receiptId: varchar('receipt_id', {length: 36})
    .notNull()
    .references(() => goodsReceipts.id, {onDelete: 'cascade'}),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  // Loose reference (products may be deleted later); item keeps a name snapshot.
  productId: varchar('product_id', {length: 36}),
  productName: varchar('product_name', {length: 255}).notNull(),
  // Unit cost paid on this receipt (feeds the weighted-average priceIn update).
  priceIn: decimal('price_in', {precision: 10, scale: 2}).notNull(),
  quantity: integer('quantity').notNull(),
  lineTotal: decimal('line_total', {precision: 12, scale: 2}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Inventory batches ("партии") — the lot ledger and source of truth for cost
// and selling price. Each goods-receipt line opens one batch; a sale consumes
// open batches oldest-first (FIFO) by createdAt. Invariant: SUM(qtyRemaining)
// per product == products.quantity.
export const inventoryBatches = pgTable(
  'inventory_batches',
  {
    id: varchar('id', {length: 36}).primaryKey().notNull(),
    businessId: varchar('business_id', {length: 36})
      .notNull()
      .references(() => businesses.id, {onDelete: 'cascade'}),
    // Tight reference: batches are meaningless without their product.
    productId: varchar('product_id', {length: 36})
      .notNull()
      .references(() => products.id, {onDelete: 'cascade'}),
    // Provenance of the batch; null for the opening batch seeded at migration.
    receiptItemId: varchar('receipt_item_id', {length: 36}).references(
      () => goodsReceiptItems.id,
      {onDelete: 'set null'},
    ),
    // Unit purchase cost of this batch (immutable).
    priceIn: decimal('price_in', {precision: 10, scale: 2}).notNull(),
    // Unit selling price of this batch (may be bumped by a later receipt when
    // priceIncreaseMode = 'REPRICE_EXISTING').
    priceOut: decimal('price_out', {precision: 10, scale: 2}).notNull(),
    // Original quantity received (immutable, for audit).
    qtyReceived: integer('qty_received').notNull(),
    // Units left in this batch; decremented as it is sold. FIFO consumes this.
    qtyRemaining: integer('qty_remaining').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Fast scan of a product's open batches in FIFO order.
    openBatchesIdx: index('inventory_batches_open_idx').on(
      table.businessId,
      table.productId,
      table.qtyRemaining,
    ),
  }),
);

// Per-business receipt/printout configuration (one row per business).
export const receiptSettings = pgTable('receipt_settings', {
  businessId: varchar('business_id', {length: 36})
    .primaryKey()
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  receiptName: varchar('receipt_name', {length: 255})
    .notNull()
    .default('Standart'),
  showLogo: boolean('show_logo').notNull().default(true),
  logoUrl: varchar('logo_url', {length: 500}),
  // VAT (QQS). Prices are VAT-inclusive, so this only breaks out the tax
  // portion of the total on receipts/reports — it never changes the total.
  vatEnabled: boolean('vat_enabled').notNull().default(false),
  vatRate: decimal('vat_rate', {precision: 5, scale: 2})
    .notNull()
    .default('12'),
  // Inventory costing method used to value COGS on a sale.
  costingMethod: varchar('costing_method', {length: 10})
    .notNull()
    .default('AVERAGE'), // 'AVERAGE' | 'FIFO'
  // What happens to existing stock's selling price when a receipt arrives with a
  // higher selling price: keep old batches at their price, or reprice them up.
  priceIncreaseMode: varchar('price_increase_mode', {length: 20})
    .notNull()
    .default('KEEP_OLD'), // 'KEEP_OLD' | 'REPRICE_EXISTING'
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Kassa (cash management) ────────────────────────────────────────────────

// A cash register / till ("Kassa" / Cashbox). A business can have several; each
// has at most one open shift at a time. Sales are rung up against a register's
// open shift. storeId is a placeholder for future multi-store support.
export const cashRegisters = pgTable('cash_registers', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  name: varchar('name', {length: 255}).notNull(),
  storeId: varchar('store_id', {length: 36}),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Categories for manual cash operations ("Toifa", e.g. store expense,
// collection, wage). Business-managed: a few defaults are seeded, and the
// business can add its own. `direction` scopes a category to in/out/both.
export const cashOperationCategories = pgTable('cash_operation_categories', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  name: varchar('name', {length: 100}).notNull(),
  direction: varchar('direction', {length: 10}).notNull().default('both'), // 'in' | 'out' | 'both'
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// A cashier shift/session on a register: opened with a float, closed with a
// per-payment-type × per-currency reconciliation (Z-report).
export const cashShifts = pgTable('cash_shifts', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  registerId: varchar('register_id', {length: 36})
    .notNull()
    .references(() => cashRegisters.id),
  registerName: varchar('register_name', {length: 255}),
  status: varchar('status', {length: 10}).notNull().default('open'), // 'open' | 'closed'
  // Opening cash float.
  openingFloat: decimal('opening_float', {precision: 12, scale: 2})
    .notNull()
    .default('0'),
  // USD rate entered at close (BILLZ "1 USD = 12 500 UZS"); null when UZS-only.
  usdRate: decimal('usd_rate', {precision: 12, scale: 4}),
  // Who opened / closed (owner id or staff id); names snapshotted.
  openedByCashierId: varchar('opened_by_cashier_id', {length: 36}),
  openedByCashierName: varchar('opened_by_cashier_name', {length: 255}),
  closedByCashierId: varchar('closed_by_cashier_id', {length: 36}),
  closedByCashierName: varchar('closed_by_cashier_name', {length: 255}),
  // Cash actually counted at close (UZS cash summary).
  countedCash: decimal('counted_cash', {precision: 12, scale: 2}),
  // Expected UZS cash: openingFloat + cash sales + cash in − cash out.
  expectedCash: decimal('expected_cash', {precision: 12, scale: 2}),
  cashIn: decimal('cash_in', {precision: 12, scale: 2}),
  cashOut: decimal('cash_out', {precision: 12, scale: 2}),
  // countedCash − expectedCash (negative = shortage, positive = surplus).
  difference: decimal('difference', {precision: 12, scale: 2}),
  // Full per-method × per-currency breakdown:
  // [{ method:'cash'|'card'|'click'|'debt', currency:'UZS'|'USD',
  //    opening, in, out, expected, counted, diff }, ...].
  reconciliation: jsonb('reconciliation'),
  orderCount: integer('order_count'),
  note: varchar('note', {length: 500}),
  openedAt: timestamp('opened_at').defaultNow().notNull(),
  closedAt: timestamp('closed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// A manual cash movement within a shift (paid-in / paid-out), categorised.
export const cashMovements = pgTable('cash_movements', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  shiftId: varchar('shift_id', {length: 36})
    .notNull()
    .references(() => cashShifts.id, {onDelete: 'cascade'}),
  registerId: varchar('register_id', {length: 36}),
  type: varchar('type', {length: 10}).notNull(), // 'in' | 'out'
  isCash: boolean('is_cash').default(true).notNull(),
  amount: decimal('amount', {precision: 12, scale: 2}).notNull(),
  currency: varchar('currency', {length: 3}).notNull().default('UZS'), // 'UZS' | 'USD'
  categoryId: varchar('category_id', {length: 36}),
  categoryName: varchar('category_name', {length: 100}),
  reason: varchar('reason', {length: 500}),
  cashierId: varchar('cashier_id', {length: 36}),
  cashierName: varchar('cashier_name', {length: 255}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const businessesRelations = relations(businesses, ({one, many}) => ({
  subscription: one(businessSubscriptions, {
    fields: [businesses.id],
    references: [businessSubscriptions.businessId],
  }),
  products: many(products),
  categories: many(categories),
  users: many(users),
  debts: many(userDebts),
  roles: many(roles),
  staff: many(staff),
  orders: many(orders),
  suppliers: many(suppliers),
  goodsReceipts: many(goodsReceipts),
  cashRegisters: many(cashRegisters),
  cashShifts: many(cashShifts),
}));

export const ordersRelations = relations(orders, ({one, many}) => ({
  business: one(businesses, {
    fields: [orders.businessId],
    references: [businesses.id],
  }),
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
  shift: one(cashShifts, {
    fields: [orders.shiftId],
    references: [cashShifts.id],
  }),
  items: many(orderItems),
}));

export const cashRegistersRelations = relations(
  cashRegisters,
  ({one, many}) => ({
    business: one(businesses, {
      fields: [cashRegisters.businessId],
      references: [businesses.id],
    }),
    shifts: many(cashShifts),
  }),
);

export const cashOperationCategoriesRelations = relations(
  cashOperationCategories,
  ({one}) => ({
    business: one(businesses, {
      fields: [cashOperationCategories.businessId],
      references: [businesses.id],
    }),
  }),
);

export const cashShiftsRelations = relations(cashShifts, ({one, many}) => ({
  business: one(businesses, {
    fields: [cashShifts.businessId],
    references: [businesses.id],
  }),
  register: one(cashRegisters, {
    fields: [cashShifts.registerId],
    references: [cashRegisters.id],
  }),
  movements: many(cashMovements),
}));

export const cashMovementsRelations = relations(cashMovements, ({one}) => ({
  business: one(businesses, {
    fields: [cashMovements.businessId],
    references: [businesses.id],
  }),
  shift: one(cashShifts, {
    fields: [cashMovements.shiftId],
    references: [cashShifts.id],
  }),
}));

export const orderItemsRelations = relations(orderItems, ({one}) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));

export const rolesRelations = relations(roles, ({one, many}) => ({
  business: one(businesses, {
    fields: [roles.businessId],
    references: [businesses.id],
  }),
  staff: many(staff),
}));

export const staffRelations = relations(staff, ({one}) => ({
  business: one(businesses, {
    fields: [staff.businessId],
    references: [businesses.id],
  }),
  role: one(roles, {
    fields: [staff.roleId],
    references: [roles.id],
  }),
}));

export const subscriptionPlansRelations = relations(
  subscriptionPlans,
  ({many}) => ({
    subscriptions: many(businessSubscriptions),
  }),
);

export const businessSubscriptionsRelations = relations(
  businessSubscriptions,
  ({one}) => ({
    business: one(businesses, {
      fields: [businessSubscriptions.businessId],
      references: [businesses.id],
    }),
    plan: one(subscriptionPlans, {
      fields: [businessSubscriptions.planId],
      references: [subscriptionPlans.id],
    }),
  }),
);

export const productsRelations = relations(products, ({one}) => ({
  business: one(businesses, {
    fields: [products.businessId],
    references: [businesses.id],
  }),
}));

export const categoriesRelations = relations(categories, ({one}) => ({
  business: one(businesses, {
    fields: [categories.businessId],
    references: [businesses.id],
  }),
}));

export const usersRelations = relations(users, ({one, many}) => ({
  business: one(businesses, {
    fields: [users.businessId],
    references: [businesses.id],
  }),
  debts: many(userDebts),
}));

export const suppliersRelations = relations(suppliers, ({one, many}) => ({
  business: one(businesses, {
    fields: [suppliers.businessId],
    references: [businesses.id],
  }),
  receipts: many(goodsReceipts),
}));

export const goodsReceiptsRelations = relations(
  goodsReceipts,
  ({one, many}) => ({
    business: one(businesses, {
      fields: [goodsReceipts.businessId],
      references: [businesses.id],
    }),
    supplier: one(suppliers, {
      fields: [goodsReceipts.supplierId],
      references: [suppliers.id],
    }),
    items: many(goodsReceiptItems),
  }),
);

export const goodsReceiptItemsRelations = relations(
  goodsReceiptItems,
  ({one}) => ({
    receipt: one(goodsReceipts, {
      fields: [goodsReceiptItems.receiptId],
      references: [goodsReceipts.id],
    }),
  }),
);

export const inventoryBatchesRelations = relations(
  inventoryBatches,
  ({one}) => ({
    business: one(businesses, {
      fields: [inventoryBatches.businessId],
      references: [businesses.id],
    }),
    product: one(products, {
      fields: [inventoryBatches.productId],
      references: [products.id],
    }),
    receiptItem: one(goodsReceiptItems, {
      fields: [inventoryBatches.receiptItemId],
      references: [goodsReceiptItems.id],
    }),
  }),
);

export const userDebtsRelations = relations(userDebts, ({one, many}) => ({
  business: one(businesses, {
    fields: [userDebts.businessId],
    references: [businesses.id],
  }),
  user: one(users, {
    fields: [userDebts.userId],
    references: [users.id],
  }),
  payments: many(debtPayments),
}));

export const debtPaymentsRelations = relations(debtPayments, ({one}) => ({
  debt: one(userDebts, {
    fields: [debtPayments.debtId],
    references: [userDebts.id],
  }),
  business: one(businesses, {
    fields: [debtPayments.businessId],
    references: [businesses.id],
  }),
}));

export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Staff = typeof staff.$inferSelect;
export type NewStaff = typeof staff.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
export type ReceiptSettings = typeof receiptSettings.$inferSelect;
export type NewReceiptSettings = typeof receiptSettings.$inferInsert;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type NewSubscriptionPlan = typeof subscriptionPlans.$inferInsert;
export type BusinessSubscription = typeof businessSubscriptions.$inferSelect;
export type NewBusinessSubscription = typeof businessSubscriptions.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type GlobalBarcode = typeof globalBarcodes.$inferSelect;
export type NewGlobalBarcode = typeof globalBarcodes.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserDebt = typeof userDebts.$inferSelect;
export type NewUserDebt = typeof userDebts.$inferInsert;
export type DebtPayment = typeof debtPayments.$inferSelect;
export type NewDebtPayment = typeof debtPayments.$inferInsert;
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type GoodsReceipt = typeof goodsReceipts.$inferSelect;
export type NewGoodsReceipt = typeof goodsReceipts.$inferInsert;
export type GoodsReceiptItem = typeof goodsReceiptItems.$inferSelect;
export type NewGoodsReceiptItem = typeof goodsReceiptItems.$inferInsert;
export type InventoryBatch = typeof inventoryBatches.$inferSelect;
export type NewInventoryBatch = typeof inventoryBatches.$inferInsert;
export type CashRegister = typeof cashRegisters.$inferSelect;
export type NewCashRegister = typeof cashRegisters.$inferInsert;
export type CashOperationCategory = typeof cashOperationCategories.$inferSelect;
export type NewCashOperationCategory =
  typeof cashOperationCategories.$inferInsert;
export type CashShift = typeof cashShifts.$inferSelect;
export type NewCashShift = typeof cashShifts.$inferInsert;
export type CashMovement = typeof cashMovements.$inferSelect;
export type NewCashMovement = typeof cashMovements.$inferInsert;
