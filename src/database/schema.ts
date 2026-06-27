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
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const businesses = pgTable('businesses', {
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  login: varchar('login', { length: 100 }).notNull().unique(),
  password: varchar('password', { length: 255 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const roles = pgTable(
  'roles',
  {
    id: varchar('id', { length: 36 }).primaryKey().notNull(),
    businessId: varchar('business_id', { length: 36 })
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
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
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  businessId: varchar('business_id', { length: 36 })
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  roleId: varchar('role_id', { length: 36 })
    .notNull()
    .references(() => roles.id),
  name: varchar('name', { length: 255 }).notNull(),
  // Globally unique so the unified login lookup is unambiguous.
  login: varchar('login', { length: 100 }).notNull().unique(),
  password: varchar('password', { length: 255 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const subscriptionPlans = pgTable('subscription_plans', {
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  tier: varchar('tier', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  description: varchar('description', { length: 500 }),
  price: decimal('price', { precision: 10, scale: 2 }).notNull().default('0'),
  isActive: boolean('is_active').default(true).notNull(),
  debtsLimit: integer('debts_limit'),
  productsLimit: integer('products_limit'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const businessSubscriptions = pgTable('business_subscriptions', {
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  businessId: varchar('business_id', { length: 36 })
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  planId: varchar('plan_id', { length: 36 })
    .notNull()
    .references(() => subscriptionPlans.id),
  startDate: timestamp('start_date', { withTimezone: true })
    .defaultNow()
    .notNull(),
  endDate: timestamp('end_date', { withTimezone: true }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const products = pgTable('products', {
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  businessId: varchar('business_id', { length: 36 })
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 100 }),
  barcode: varchar('barcode', { length: 100 }),
  priceIn: decimal('price_in', { precision: 10, scale: 2 }).notNull(),
  priceOut: decimal('price_out', { precision: 10, scale: 2 }).notNull(),
  quantity: integer('quantity').default(0).notNull(),
  quantityType: varchar('quantity_type', { length: 50 }),
  image: varchar('image', { length: 500 }),
  categoryId: varchar('category_id', { length: 100 }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const categories = pgTable(
  'categories',
  {
    id: varchar('id', { length: 100 }).notNull(),
    businessId: varchar('business_id', { length: 36 })
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    image: varchar('image', { length: 500 }),
    isDeleted: boolean('is_deleted').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.businessId, table.id] }),
  }),
);

export const users = pgTable(
  'users',
  {
    id: varchar('id', { length: 36 }).primaryKey().notNull(),
    businessId: varchar('business_id', { length: 36 })
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    phone: varchar('phone', { length: 50 }).notNull(),
    email: varchar('email', { length: 255 }),
    address: varchar('address', { length: 500 }),
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
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  businessId: varchar('business_id', { length: 36 })
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  userId: varchar('user_id', { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('Pending'), // 'Paid' | 'Pending' | 'Overdue'
  dueDate: timestamp('due_date', { withTimezone: true }).notNull(),
  description: varchar('description', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const orders = pgTable('orders', {
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  businessId: varchar('business_id', { length: 36 })
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  // Optional customer this order belongs to.
  userId: varchar('user_id', { length: 36 }).references(() => users.id, {
    onDelete: 'set null',
  }),
  // Snapshot of the customer name (for guest/store orders without a user row).
  customerName: varchar('customer_name', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('Pending'), // 'Pending' | 'Completed' | 'Cancelled'
  totalAmount: decimal('total_amount', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  itemCount: integer('item_count').notNull().default(0),
  // Summary method: 'cash' | 'card' | 'split'.
  paymentMethod: varchar('payment_method', { length: 50 }),
  // Per-method breakdown applied to the sale, summing to totalAmount.
  // Shape: [{ method: 'cash' | 'card', amount: number }].
  payments: jsonb('payments'),
  // Cash physically tendered and change returned (for drawer reconciliation).
  amountPaid: decimal('amount_paid', { precision: 12, scale: 2 }),
  changeAmount: decimal('change_amount', { precision: 12, scale: 2 }),
  note: varchar('note', { length: 500 }),
  source: varchar('source', { length: 20 }).notNull().default('admin'), // 'admin' | 'store'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const orderItems = pgTable('order_items', {
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  orderId: varchar('order_id', { length: 36 })
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  businessId: varchar('business_id', { length: 36 })
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  // Product reference is kept loose: products may be deleted later, but the
  // order keeps its name/price snapshot.
  productId: varchar('product_id', { length: 36 }),
  productName: varchar('product_name', { length: 255 }).notNull(),
  priceOut: decimal('price_out', { precision: 10, scale: 2 }).notNull(),
  quantity: integer('quantity').notNull(),
  lineTotal: decimal('line_total', { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Per-business receipt/printout configuration (one row per business).
export const receiptSettings = pgTable('receipt_settings', {
  businessId: varchar('business_id', { length: 36 })
    .primaryKey()
    .notNull()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  receiptName: varchar('receipt_name', { length: 255 })
    .notNull()
    .default('Standart'),
  showLogo: boolean('show_logo').notNull().default(true),
  logoUrl: varchar('logo_url', { length: 500 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const businessesRelations = relations(businesses, ({ one, many }) => ({
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
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  business: one(businesses, {
    fields: [orders.businessId],
    references: [businesses.id],
  }),
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  business: one(businesses, {
    fields: [roles.businessId],
    references: [businesses.id],
  }),
  staff: many(staff),
}));

export const staffRelations = relations(staff, ({ one }) => ({
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
  ({ many }) => ({
    subscriptions: many(businessSubscriptions),
  }),
);

export const businessSubscriptionsRelations = relations(
  businessSubscriptions,
  ({ one }) => ({
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

export const productsRelations = relations(products, ({ one }) => ({
  business: one(businesses, {
    fields: [products.businessId],
    references: [businesses.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ one }) => ({
  business: one(businesses, {
    fields: [categories.businessId],
    references: [businesses.id],
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  business: one(businesses, {
    fields: [users.businessId],
    references: [businesses.id],
  }),
  debts: many(userDebts),
}));

export const userDebtsRelations = relations(userDebts, ({ one }) => ({
  business: one(businesses, {
    fields: [userDebts.businessId],
    references: [businesses.id],
  }),
  user: one(users, {
    fields: [userDebts.userId],
    references: [users.id],
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
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserDebt = typeof userDebts.$inferSelect;
export type NewUserDebt = typeof userDebts.$inferInsert;
