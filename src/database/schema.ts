import { pgTable, varchar, timestamp, boolean, integer, decimal, uniqueIndex } from 'drizzle-orm/pg-core';
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
  businessId: varchar('business_id', { length: 36 }).notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  planId: varchar('plan_id', { length: 36 }).notNull().references(() => subscriptionPlans.id),
  startDate: timestamp('start_date', { withTimezone: true }).defaultNow().notNull(),
  endDate: timestamp('end_date', { withTimezone: true }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const products = pgTable('products', {
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  businessId: varchar('business_id', { length: 36 }).notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 100 }),
  barcode: varchar('barcode', { length: 100 }),
  priceIn: decimal('price_in', { precision: 10, scale: 2 }).notNull(),
  priceOut: decimal('price_out', { precision: 10, scale: 2 }).notNull(),
  quantity: integer('quantity').default(0).notNull(),
  quantityType: varchar('quantity_type', { length: 50 }),
  image: varchar('image', { length: 500 }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  businessId: varchar('business_id', { length: 36 }).notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }).notNull(),
  email: varchar('email', { length: 255 }),
  address: varchar('address', { length: 500 }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  uniquePhoneBusiness: uniqueIndex('unique_phone_business').on(table.phone, table.businessId),
}));


export const userDebts = pgTable('user_debts', {
  id: varchar('id', { length: 36 }).primaryKey().notNull(),
  businessId: varchar('business_id', { length: 36 }).notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('Pending'), // 'Paid' | 'Pending' | 'Overdue'
  dueDate: timestamp('due_date', { withTimezone: true }).notNull(),
  description: varchar('description', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const businessesRelations = relations(businesses, ({ one, many }) => ({
  subscription: one(businessSubscriptions, {
    fields: [businesses.id],
    references: [businessSubscriptions.businessId],
  }),
  products: many(products),
  users: many(users),
  debts: many(userDebts),
}));

export const subscriptionPlansRelations = relations(subscriptionPlans, ({ many }) => ({
  subscriptions: many(businessSubscriptions),
}));

export const businessSubscriptionsRelations = relations(businessSubscriptions, ({ one }) => ({
  business: one(businesses, {
    fields: [businessSubscriptions.businessId],
    references: [businesses.id],
  }),
  plan: one(subscriptionPlans, {
    fields: [businessSubscriptions.planId],
    references: [subscriptionPlans.id],
  }),
}));

export const productsRelations = relations(products, ({ one }) => ({
  business: one(businesses, {
    fields: [products.businessId],
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
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type NewSubscriptionPlan = typeof subscriptionPlans.$inferInsert;
export type BusinessSubscription = typeof businessSubscriptions.$inferSelect;
export type NewBusinessSubscription = typeof businessSubscriptions.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserDebt = typeof userDebts.$inferSelect;
export type NewUserDebt = typeof userDebts.$inferInsert;