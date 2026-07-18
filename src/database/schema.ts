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
  // Max total users (owner + staff). Enforced on staff creation; the owner
  // always holds 1 seat, so N allows N-1 staff members. null = unlimited.
  usersLimit: integer('users_limit'),
  // Max total branches/stores (1 base + extras). Catalog value for now; branch
  // creation and per-branch discount billing will consume it (not built yet).
  branchesLimit: integer('branches_limit'),
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
  // Optional wholesale (bulk) selling price. Set at goods-receipt time or in the
  // catalog; null when the product has no separate wholesale tier.
  priceWholesale: decimal('price_wholesale', {precision: 10, scale: 2}),
  quantity: integer('quantity').default(0).notNull(),
  quantityType: varchar('quantity_type', {length: 50}),
  image: varchar('image', {length: 500}),
  categoryId: varchar('category_id', {length: 100}),
  // Markup over cost, as a percent (e.g. 22.50 = +22.5%). UI-only helper that
  // ties priceIn → priceOut; stored so it can be shown/edited later. Nullable
  // for products priced directly without a markup.
  markupPercent: decimal('markup_percent', {precision: 6, scale: 2}),
  // Reorder point: when quantity drops to or below this, the product is flagged
  // "low stock" in the catalog and can drive a reorder alert. Null = no alert.
  lowStockThreshold: integer('low_stock_threshold'),
  // Optional brand this product belongs to (for filtering/reporting).
  brandId: varchar('brand_id', {length: 36}),
  // Optional default supplier this product is bought from.
  supplierId: varchar('supplier_id', {length: 36}),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Product brands (marketing manufacturers, e.g. "Nike", "Bosch"). Scoped per
// business, managed by the business. Referenced loosely by products.brandId so
// deleting a brand never breaks a product.
export const brands = pgTable('brands', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  name: varchar('name', {length: 255}).notNull(),
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

// Uzbekistan national product classifier (IKPU / MXIK) imported from
// tasnif.soliq.uz. Authoritative, offline reference used for two things:
//   1. Barcode scan auto-fill — maps a scanned barcode to an official name +
//      category, so it works without hitting any external network provider.
//   2. Fiscalization — every fiscal receipt line needs the 17-digit MXIK code,
//      so the product form searches this table to pick one (see FISCALIZATION.md).
// Keyed by the MXIK code; barcode is indexed but nullable (not every classified
// item has a barcode). Not scoped to a business — it's global reference data.
export const mxikClassifier = pgTable(
  'mxik_classifier',
  {
    mxikCode: varchar('mxik_code', {length: 17}).primaryKey().notNull(),
    name: varchar('name', {length: 500}).notNull(),
    barcode: varchar('barcode', {length: 20}),
    groupName: varchar('group_name', {length: 255}),
    brand: varchar('brand', {length: 255}),
    unitName: varchar('unit_name', {length: 255}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    barcodeIdx: index('mxik_classifier_barcode_idx').on(table.barcode),
  }),
);

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
  // Supplier-payment control: how much of totalAmount is settled, and a rolled-up
  // status. Obligation is settled by payments AND returns (returned goods reduce
  // what is owed): settled = paidAmount + returnedAmount.
  // 'unpaid' (settled 0) | 'partial' (0<settled<total) | 'paid' (settled>=total).
  paidAmount: decimal('paid_amount', {precision: 12, scale: 2})
    .notNull()
    .default('0'),
  // Value of goods returned to the supplier against this receipt.
  returnedAmount: decimal('returned_amount', {precision: 12, scale: 2})
    .notNull()
    .default('0'),
  paymentStatus: varchar('payment_status', {length: 10})
    .notNull()
    .default('unpaid'), // 'unpaid' | 'partial' | 'paid'
  // Settlement currency of this receipt (debt/payments are in this currency).
  currency: varchar('currency', {length: 3}).notNull().default('UZS'),
  // USD→UZS rate used to convert the supply cost to base for inventory, when
  // currency is USD. Null for UZS receipts.
  usdRate: decimal('usd_rate', {precision: 12, scale: 4}),
  itemCount: integer('item_count').notNull().default(0),
  note: varchar('note', {length: 500}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Payments made to a supplier against a goods receipt. Each payment also books
// a finance expense (financialTransactionId) so the money-out shows in Moliya —
// the finance ledger stays the single source of truth for account balances.
export const supplierPayments = pgTable('supplier_payments', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  receiptId: varchar('receipt_id', {length: 36})
    .notNull()
    .references(() => goodsReceipts.id, {onDelete: 'cascade'}),
  supplierId: varchar('supplier_id', {length: 36}),
  supplierName: varchar('supplier_name', {length: 255}),
  amount: decimal('amount', {precision: 12, scale: 2}).notNull(),
  currency: varchar('currency', {length: 3}).notNull().default('UZS'),
  // Which finance account the money left from (cash/bank).
  accountId: varchar('account_id', {length: 36}),
  accountName: varchar('account_name', {length: 255}),
  // The booked finance expense, for provenance / reversal.
  financialTransactionId: varchar('financial_transaction_id', {length: 36}),
  note: varchar('note', {length: 500}),
  cashierId: varchar('cashier_id', {length: 36}),
  cashierName: varchar('cashier_name', {length: 255}),
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// A return of received goods back to the supplier, against a goods receipt.
// Reverses stock + the receipt's batches and reduces the amount owed.
export const supplierReturns = pgTable('supplier_returns', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  receiptId: varchar('receipt_id', {length: 36})
    .notNull()
    .references(() => goodsReceipts.id, {onDelete: 'cascade'}),
  supplierId: varchar('supplier_id', {length: 36}),
  supplierName: varchar('supplier_name', {length: 255}),
  totalAmount: decimal('total_amount', {precision: 12, scale: 2}).notNull(),
  currency: varchar('currency', {length: 3}).notNull().default('UZS'),
  itemCount: integer('item_count').notNull().default(0),
  note: varchar('note', {length: 500}),
  cashierId: varchar('cashier_id', {length: 36}),
  cashierName: varchar('cashier_name', {length: 255}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const supplierReturnItems = pgTable('supplier_return_items', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  returnId: varchar('return_id', {length: 36})
    .notNull()
    .references(() => supplierReturns.id, {onDelete: 'cascade'}),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  productId: varchar('product_id', {length: 36}),
  productName: varchar('product_name', {length: 255}).notNull(),
  // Unit cost the goods were received at (reverses the same value).
  priceIn: decimal('price_in', {precision: 10, scale: 2}).notNull(),
  quantity: integer('quantity').notNull(),
  lineTotal: decimal('line_total', {precision: 12, scale: 2}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
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
  // Unit cost paid on this receipt, in the receipt's currency (feeds the
  // weighted-average product cost after conversion to base UZS).
  priceIn: decimal('price_in', {precision: 10, scale: 2}).notNull(),
  // Entry currency of priceIn (snapshot of the receipt currency).
  currency: varchar('currency', {length: 3}).notNull().default('UZS'),
  // Retail + wholesale selling prices entered on this line (snapshot). priceOut
  // drives the batch/product selling price; priceWholesale updates the product's
  // wholesale tier. Nullable for older receipts.
  priceOut: decimal('price_out', {precision: 10, scale: 2}),
  priceWholesale: decimal('price_wholesale', {precision: 10, scale: 2}),
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

// Configurable receipt/waybill layout templates. Unlike `receiptSettings`
// (one accounting-oriented row per business), a business can have several of
// these, each optionally bound to a specific register (kassa). The field
// selection, ordering, footer links and note live in jsonb so the layout is
// fully data-driven — the frontend editor + live preview render from it.
export const receiptTemplates = pgTable('receipt_templates', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  name: varchar('name', {length: 255}).notNull(),
  // 'receipt' (chek) | 'waybill' (yuk xati).
  printType: varchar('print_type', {length: 20}).notNull().default('receipt'),
  // Which register this template applies to. null = business-wide default,
  // used when a register has no template of its own.
  registerId: varchar('register_id', {length: 36}).references(
    () => cashRegisters.id,
    {onDelete: 'set null'},
  ),
  showLogo: boolean('show_logo').notNull().default(true),
  logoUrl: varchar('logo_url', {length: 500}),
  extraImageUrl: varchar('extra_image_url', {length: 500}),
  showCustomerBalance: boolean('show_customer_balance')
    .notNull()
    .default(false),
  showCustomerDebt: boolean('show_customer_debt').notNull().default(false),
  showProductAttributes: boolean('show_product_attributes')
    .notNull()
    .default(false),
  showPoweredBy: boolean('show_powered_by').notNull().default(true),
  // Info-block fields, in display order, each toggleable:
  // [{ key:'storeName', enabled:true }, { key:'date', enabled:true }, ...].
  infoFields: jsonb('info_fields'),
  // Bottom block (socials + barcode), in display order:
  // [{ key:'facebook', enabled:true, value:'...' }, ...].
  footerLinks: jsonb('footer_links'),
  // Rich-text note printed at the bottom (sanitised HTML).
  footerText: varchar('footer_text', {length: 2000}),
  // The business-wide default template (registerId is null). At most one.
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
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

// ── Finance (Moliya) ──────────────────────────────────────────────────────
// A financial account where money is kept: 'cash' (register/on-hand) or
// 'noncash' (bank/card terminal). A cash account may link to a cash_register.
export const accounts = pgTable('accounts', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  name: varchar('name', {length: 255}).notNull(), // "Asosiy kassa", "Bank hisobi"
  type: varchar('type', {length: 10}).notNull(), // 'cash' | 'noncash'
  // For a cash account: which register it belongs to (optional).
  registerId: varchar('register_id', {length: 36}),
  storeId: varchar('store_id', {length: 36}), // future: multi-store
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Current balance per account × currency. Updated atomically inside the same
// db.transaction as each financial_transaction write.
export const accountBalances = pgTable(
  'account_balances',
  {
    id: varchar('id', {length: 36}).primaryKey().notNull(),
    businessId: varchar('business_id', {length: 36})
      .notNull()
      .references(() => businesses.id, {onDelete: 'cascade'}),
    accountId: varchar('account_id', {length: 36})
      .notNull()
      .references(() => accounts.id, {onDelete: 'cascade'}),
    currency: varchar('currency', {length: 3}).notNull(), // 'UZS' | 'USD'
    balance: decimal('balance', {precision: 14, scale: 4})
      .notNull()
      .default('0'),
    frozen: decimal('frozen', {precision: 14, scale: 4})
      .notNull()
      .default('0'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    accountCurrencyIdx: uniqueIndex('account_balances_account_currency_idx').on(
      table.accountId,
      table.currency,
    ),
  }),
);

// Income/expense categories (BiLLZ "Moliyaviy toifalar"). Single source for
// both finance and kassa: a cash-in movement picks an 'income' category, a
// cash-out picks an 'expense' one.
export const financialCategories = pgTable('financial_categories', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  name: varchar('name', {length: 255}).notNull(),
  kind: varchar('kind', {length: 10}).notNull(), // 'income' | 'expense'
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// The finance ledger — every money movement. One table covers all kinds.
// 'conversion' + subtype (vat/passthrough) columns exist but are unused in MVP.
export const financialTransactions = pgTable(
  'financial_transactions',
  {
    id: varchar('id', {length: 36}).primaryKey().notNull(),
    businessId: varchar('business_id', {length: 36})
      .notNull()
      .references(() => businesses.id, {onDelete: 'cascade'}),
    // 'income' | 'expense' | 'transfer' | 'conversion' | 'shift_close'
    kind: varchar('kind', {length: 12}).notNull(),
    // Source account (the 'from' for expense/transfer/conversion).
    accountId: varchar('account_id', {length: 36}),
    accountName: varchar('account_name', {length: 255}), // snapshot
    // Destination account (the 'to' for transfer/conversion).
    toAccountId: varchar('to_account_id', {length: 36}),
    toAccountName: varchar('to_account_name', {length: 255}),
    isCash: boolean('is_cash').default(true).notNull(), // cash / non-cash
    amount: decimal('amount', {precision: 14, scale: 4}).notNull(),
    currency: varchar('currency', {length: 3}).notNull().default('UZS'),
    // Conversion only (unused in MVP): received currency + amount + rate.
    toAmount: decimal('to_amount', {precision: 14, scale: 4}),
    toCurrency: varchar('to_currency', {length: 3}),
    rate: decimal('rate', {precision: 14, scale: 4}),
    // BiLLZ "Tur" (unused in MVP): 'vat' | 'passthrough' | null.
    subtype: varchar('subtype', {length: 12}),
    categoryId: varchar('category_id', {length: 36}),
    categoryName: varchar('category_name', {length: 255}),
    cashierId: varchar('cashier_id', {length: 36}),
    cashierName: varchar('cashier_name', {length: 255}),
    note: varchar('note', {length: 500}),
    operationDate: timestamp('operation_date'), // "Operatsiya sanasi"
    // Provenance — links a ledger row back to its kassa source.
    orderId: varchar('order_id', {length: 36}),
    shiftId: varchar('shift_id', {length: 36}),
    cashMovementId: varchar('cash_movement_id', {length: 36}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    businessCreatedIdx: index('financial_transactions_business_created_idx').on(
      table.businessId,
      table.createdAt,
    ),
    accountIdx: index('financial_transactions_account_idx').on(table.accountId),
  }),
);

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
  brands: many(brands),
  goodsReceipts: many(goodsReceipts),
  supplierPayments: many(supplierPayments),
  supplierReturns: many(supplierReturns),
  cashRegisters: many(cashRegisters),
  cashShifts: many(cashShifts),
  accounts: many(accounts),
  financialCategories: many(financialCategories),
  financialTransactions: many(financialTransactions),
}));

export const accountsRelations = relations(accounts, ({one, many}) => ({
  business: one(businesses, {
    fields: [accounts.businessId],
    references: [businesses.id],
  }),
  balances: many(accountBalances),
}));

export const accountBalancesRelations = relations(
  accountBalances,
  ({one}) => ({
    business: one(businesses, {
      fields: [accountBalances.businessId],
      references: [businesses.id],
    }),
    account: one(accounts, {
      fields: [accountBalances.accountId],
      references: [accounts.id],
    }),
  }),
);

export const financialCategoriesRelations = relations(
  financialCategories,
  ({one}) => ({
    business: one(businesses, {
      fields: [financialCategories.businessId],
      references: [businesses.id],
    }),
  }),
);

export const financialTransactionsRelations = relations(
  financialTransactions,
  ({one}) => ({
    business: one(businesses, {
      fields: [financialTransactions.businessId],
      references: [businesses.id],
    }),
    account: one(accounts, {
      fields: [financialTransactions.accountId],
      references: [accounts.id],
    }),
  }),
);

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

export const brandsRelations = relations(brands, ({one}) => ({
  business: one(businesses, {
    fields: [brands.businessId],
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
    payments: many(supplierPayments),
    returns: many(supplierReturns),
  }),
);

export const supplierReturnsRelations = relations(
  supplierReturns,
  ({one, many}) => ({
    business: one(businesses, {
      fields: [supplierReturns.businessId],
      references: [businesses.id],
    }),
    receipt: one(goodsReceipts, {
      fields: [supplierReturns.receiptId],
      references: [goodsReceipts.id],
    }),
    items: many(supplierReturnItems),
  }),
);

export const supplierReturnItemsRelations = relations(
  supplierReturnItems,
  ({one}) => ({
    return: one(supplierReturns, {
      fields: [supplierReturnItems.returnId],
      references: [supplierReturns.id],
    }),
  }),
);

export const supplierPaymentsRelations = relations(
  supplierPayments,
  ({one}) => ({
    business: one(businesses, {
      fields: [supplierPayments.businessId],
      references: [businesses.id],
    }),
    receipt: one(goodsReceipts, {
      fields: [supplierPayments.receiptId],
      references: [goodsReceipts.id],
    }),
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
export type ReceiptTemplate = typeof receiptTemplates.$inferSelect;
export type NewReceiptTemplate = typeof receiptTemplates.$inferInsert;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type NewSubscriptionPlan = typeof subscriptionPlans.$inferInsert;
export type BusinessSubscription = typeof businessSubscriptions.$inferSelect;
export type NewBusinessSubscription = typeof businessSubscriptions.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type GlobalBarcode = typeof globalBarcodes.$inferSelect;
export type NewGlobalBarcode = typeof globalBarcodes.$inferInsert;
export type MxikClassifier = typeof mxikClassifier.$inferSelect;
export type NewMxikClassifier = typeof mxikClassifier.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;
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
export type SupplierPayment = typeof supplierPayments.$inferSelect;
export type NewSupplierPayment = typeof supplierPayments.$inferInsert;
export type SupplierReturn = typeof supplierReturns.$inferSelect;
export type NewSupplierReturn = typeof supplierReturns.$inferInsert;
export type SupplierReturnItem = typeof supplierReturnItems.$inferSelect;
export type NewSupplierReturnItem = typeof supplierReturnItems.$inferInsert;
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
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type AccountBalance = typeof accountBalances.$inferSelect;
export type NewAccountBalance = typeof accountBalances.$inferInsert;
export type FinancialCategory = typeof financialCategories.$inferSelect;
export type NewFinancialCategory = typeof financialCategories.$inferInsert;
export type FinancialTransaction = typeof financialTransactions.$inferSelect;
export type NewFinancialTransaction =
  typeof financialTransactions.$inferInsert;

// ─── Stock-take (Inventarizatsiya) ──────────────────────────────────────────
// Ombor sanog'i: haqiqiy qoldiqни kitob qoldig'и bilan solishtirib tuzatish.
// Yakunlaganда: ortiqcha → yangi partiya (oxirги priceIn), kamomad → FIFO yechim,
// farq COGS bo'yicha; net farq MOLIYA `financial_transactions`ga yoziladi.
export const stockTakes = pgTable('stock_takes', {
  id: varchar('id', {length: 36}).primaryKey().notNull(),
  businessId: varchar('business_id', {length: 36})
    .notNull()
    .references(() => businesses.id, {onDelete: 'cascade'}),
  name: varchar('name', {length: 255}).notNull(),
  storeId: varchar('store_id', {length: 36}), // kelajak: ko'p filial
  type: varchar('type', {length: 10}).notNull(), // 'full' | 'partial'
  status: varchar('status', {length: 12}).notNull().default('in_progress'), // 'in_progress' | 'completed'
  // Yakuniy jamlar (snapshot).
  surplusQty: decimal('surplus_qty', {precision: 14, scale: 3}),
  shortageQty: decimal('shortage_qty', {precision: 14, scale: 3}),
  diffValue: decimal('diff_value', {precision: 14, scale: 2}), // COGS bo'yicha net farq
  createdByCashierId: varchar('created_by_cashier_id', {length: 36}),
  createdByCashierName: varchar('created_by_cashier_name', {length: 255}),
  note: varchar('note', {length: 500}),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const stockTakeItems = pgTable(
  'stock_take_items',
  {
    id: varchar('id', {length: 36}).primaryKey().notNull(),
    stockTakeId: varchar('stock_take_id', {length: 36})
      .notNull()
      .references(() => stockTakes.id, {onDelete: 'cascade'}),
    businessId: varchar('business_id', {length: 36}).notNull(),
    productId: varchar('product_id', {length: 36}),
    productName: varchar('product_name', {length: 255}).notNull(),
    bookQty: integer('book_qty').notNull(), // tizim qoldig'i (sanoq boshlanganда)
    countedQty: integer('counted_qty').notNull(), // haqiqiy sanalgan
    diffQty: integer('diff_qty').notNull(), // counted - book
    unitCost: decimal('unit_cost', {precision: 10, scale: 2}), // tannarx (COGS)
    diffValue: decimal('diff_value', {precision: 12, scale: 2}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    stockTakeIdx: index('stock_take_items_take_idx').on(table.stockTakeId),
  }),
);

export const stockTakesRelations = relations(stockTakes, ({one, many}) => ({
  business: one(businesses, {
    fields: [stockTakes.businessId],
    references: [businesses.id],
  }),
  items: many(stockTakeItems),
}));

export const stockTakeItemsRelations = relations(stockTakeItems, ({one}) => ({
  stockTake: one(stockTakes, {
    fields: [stockTakeItems.stockTakeId],
    references: [stockTakes.id],
  }),
  product: one(products, {
    fields: [stockTakeItems.productId],
    references: [products.id],
  }),
}));

export type StockTake = typeof stockTakes.$inferSelect;
export type NewStockTake = typeof stockTakes.$inferInsert;
export type StockTakeItem = typeof stockTakeItems.$inferSelect;
export type NewStockTakeItem = typeof stockTakeItems.$inferInsert;
