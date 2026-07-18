import * as dotenv from 'dotenv';
import {eq, sql} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgres from 'postgres';

import {seedSubscriptionPlans} from '../subscription/seed-plans';
import { hashPassword } from '../utils/password';
import {generateId} from '../utils/uuid';
import {DatabaseService} from './database.service';
import * as schema from './schema';

dotenv.config();

/**
 * Seeds the database with mock data for local development.
 *
 * Run with: npm run db:seed
 *
 * Idempotent: re-running skips work that already exists (keyed off the demo
 * business login), so it is safe to run repeatedly.
 */

const DEMO_BUSINESS_LOGIN = 'demo';
const DEMO_BUSINESS_PASSWORD = 'demo1234';

// Fixed category ids so products can reference them deterministically.
const CATEGORY = {
  drinks: 'cat-drinks',
  snacks: 'cat-snacks',
  dairy: 'cat-dairy',
  bakery: 'cat-bakery',
  household: 'cat-household',
};

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Idempotently ensure a demo "Cashier" role + staff account exist for the
 * given business. Runs whether or not the rest of the mock data already
 * exists, so the staff-permissions feature is always testable.
 */
async function ensureDemoStaff(
  db: ReturnType<typeof drizzle>,
  businessId: string,
) {
  const existingStaff = await db
    .select()
    .from(schema.staff)
    .where(eq(schema.staff.login, 'cashier'))
    .limit(1);
  if (existingStaff.length > 0) {
    console.log('↩ Demo staff "cashier" already exists — skipping.');
    return;
  }

  const cashierRoleId = generateId();
  await db.insert(schema.roles).values({
    id: cashierRoleId,
    businessId,
    name: 'Cashier',
    menuKeys: ['ecommerce.products', 'checkout'],
    isActive: true,
  });
  await db.insert(schema.staff).values({
    id: generateId(),
    businessId,
    roleId: cashierRoleId,
    name: 'Demo Cashier',
    login: 'cashier',
    password: hashPassword('cashier1234'),
    isActive: true,
  });
  console.log(
    '✓ Demo role + staff created (login: cashier / password: cashier1234)',
  );
}

async function seed() {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres:oLCvicppN1ALpQDNyCpORztaAT22jUtcyBE5mJYrS47ujmsZ19mkYf1clU4TEpka@116.202.26.85:5454/KPOS';

  const client = postgres(connectionString, {max: 1});
  const db = drizzle(client, {schema});

  try {
    // 1. Subscription plans (reuse the app's own seeder — idempotent by tier).
    await seedSubscriptionPlans({db} as unknown as DatabaseService);
    console.log('✓ Subscription plans seeded');

    // 2. Demo business — bail out early if it already exists.
    const existing = await db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.login, DEMO_BUSINESS_LOGIN))
      .limit(1);

    if (existing.length > 0) {
      console.log(
        `↩ Demo business "${DEMO_BUSINESS_LOGIN}" already exists — skipping mock data.`,
      );
      // Still ensure the demo role/staff exist (feature added after the
      // original seed), so the permission feature is testable.
      await ensureDemoStaff(db, existing[0].id);
      return;
    }

    const businessId = generateId();
    await db.insert(schema.businesses).values({
      id: businessId,
      name: 'Demo Market',
      email: 'demo@KPOS.uz',
      login: DEMO_BUSINESS_LOGIN,
      password: hashPassword(DEMO_BUSINESS_PASSWORD),
      isActive: true,
    });
    console.log(
      `✓ Business created (login: ${DEMO_BUSINESS_LOGIN} / password: ${DEMO_BUSINESS_PASSWORD})`,
    );

    // 3. Attach the business to the "pro" plan for a year.
    const [proPlan] = await db
      .select()
      .from(schema.subscriptionPlans)
      .where(eq(schema.subscriptionPlans.tier, 'pro'))
      .limit(1);

    if (proPlan) {
      await db.insert(schema.businessSubscriptions).values({
        id: generateId(),
        businessId,
        planId: proPlan.id,
        startDate: new Date(),
        endDate: daysFromNow(365),
        isActive: true,
      });
      console.log('✓ Business subscription created (pro)');
    }

    // 4. Categories (composite PK: businessId + id).
    await db.insert(schema.categories).values([
      {id: CATEGORY.drinks, businessId, name: 'Drinks'},
      {id: CATEGORY.snacks, businessId, name: 'Snacks'},
      {id: CATEGORY.dairy, businessId, name: 'Dairy'},
      {id: CATEGORY.bakery, businessId, name: 'Bakery'},
      {id: CATEGORY.household, businessId, name: 'Household'},
    ]);
    console.log('✓ Categories created (5)');

    // 5. Products.
    const productRows = await db
      .insert(schema.products)
      .values([
        {
          id: generateId(),
          businessId,
          name: 'Coca-Cola 1L',
          code: 'CC-1L',
          barcode: '5449000000996',
          priceIn: '8000.00',
          priceOut: '11000.00',
          quantity: 120,
          quantityType: 'pcs',
          categoryId: CATEGORY.drinks,
        },
        {
          id: generateId(),
          businessId,
          name: 'Pepsi 1.5L',
          code: 'PP-15L',
          barcode: '5449000054227',
          priceIn: '9000.00',
          priceOut: '13000.00',
          quantity: 80,
          quantityType: 'pcs',
          categoryId: CATEGORY.drinks,
        },
        {
          id: generateId(),
          businessId,
          name: 'Lays Classic 80g',
          code: 'LAYS-80',
          barcode: '4690388080207',
          priceIn: '6000.00',
          priceOut: '9000.00',
          quantity: 200,
          quantityType: 'pcs',
          categoryId: CATEGORY.snacks,
        },
        {
          id: generateId(),
          businessId,
          name: 'Milk 1L',
          code: 'MILK-1L',
          priceIn: '7000.00',
          priceOut: '9500.00',
          quantity: 50,
          quantityType: 'pcs',
          categoryId: CATEGORY.dairy,
        },
        {
          id: generateId(),
          businessId,
          name: 'Yogurt 400g',
          code: 'YOG-400',
          priceIn: '5000.00',
          priceOut: '7500.00',
          quantity: 60,
          quantityType: 'pcs',
          categoryId: CATEGORY.dairy,
        },
        {
          id: generateId(),
          businessId,
          name: 'White Bread',
          code: 'BREAD-W',
          priceIn: '2500.00',
          priceOut: '4000.00',
          quantity: 40,
          quantityType: 'pcs',
          categoryId: CATEGORY.bakery,
        },
        {
          id: generateId(),
          businessId,
          name: 'Dish Soap 500ml',
          code: 'SOAP-500',
          barcode: '8690637000010',
          priceIn: '12000.00',
          priceOut: '18000.00',
          quantity: 35,
          quantityType: 'pcs',
          categoryId: CATEGORY.household,
        },
        {
          id: generateId(),
          businessId,
          name: 'Paper Towels 2-pack',
          code: 'TWL-2',
          priceIn: '15000.00',
          priceOut: '22000.00',
          quantity: 25,
          quantityType: 'pcs',
          categoryId: CATEGORY.household,
        },
      ])
      .returning();
    console.log('✓ Products created (8)');

    // 6. Users (customers).
    const userRows = [
      {
        name: 'Akmal Karimov',
        phone: '+998901112233',
        address: 'Tashkent, Chilonzor 12',
      },
      {
        name: 'Dilnoza Yusupova',
        phone: '+998902223344',
        address: 'Tashkent, Yunusobod 5',
      },
      {
        name: 'Bobur Aliyev',
        phone: '+998903334455',
        address: 'Samarkand, Registon 8',
      },
      {
        name: 'Gulnora Saidova',
        phone: '+998904445566',
        address: 'Bukhara, Lyabi-Hauz 3',
      },
      {
        name: 'Sardor Toshmatov',
        phone: '+998905556677',
        address: 'Andijan, Bobur 21',
      },
    ].map((u) => ({
      id: generateId(),
      businessId,
      name: u.name,
      phone: u.phone,
      email: null,
      address: u.address,
      isActive: true,
    }));

    await db.insert(schema.users).values(userRows);
    console.log(`✓ Users created (${userRows.length})`);

    // 7. User debts. Most come from real "sell on credit" POS sales (so they
    // carry an order + items and show up under "View items"); a couple are
    // manual tabs with no order.
    const money = (n: number): string => n.toFixed(2);

    // Creates a Completed POS order with items, decrements stock, and records
    // the unpaid remainder as a debt linked to that order.
    async function seedDebtSale(opts: {
      user: (typeof userRows)[number];
      lines: {product: (typeof productRows)[number]; qty: number}[];
      paidNow: number;
      method?: 'cash' | 'card';
      dueInDays: number | null;
    }) {
      const orderId = generateId();
      let total = 0;
      let itemCount = 0;
      const items = opts.lines.map(({product, qty}) => {
        const lineTotal = Number(product.priceOut) * qty;
        total += lineTotal;
        itemCount += qty;
        return {
          id: generateId(),
          orderId,
          businessId,
          productId: product.id,
          productName: product.name,
          priceOut: money(Number(product.priceOut)),
          quantity: qty,
          lineTotal: money(lineTotal),
        };
      });
      const paidNow = Math.min(opts.paidNow, total);
      const payments =
        paidNow > 0 ? [{method: opts.method ?? 'cash', amount: paidNow}] : [];

      await db.insert(schema.orders).values({
        id: orderId,
        businessId,
        userId: opts.user.id,
        customerName: opts.user.name,
        status: 'Completed',
        totalAmount: money(total),
        itemCount,
        paymentMethod: 'debt',
        payments,
        amountPaid: money(paidNow),
        changeAmount: money(0),
        taxRate: money(0),
        taxAmount: money(0),
        source: 'admin',
      });
      await db.insert(schema.orderItems).values(items);
      for (const it of items) {
        await db
          .update(schema.products)
          .set({
            quantity: sql`GREATEST(0, ${schema.products.quantity} - ${it.quantity})`,
          })
          .where(eq(schema.products.id, it.productId));
      }
      await db.insert(schema.userDebts).values({
        id: generateId(),
        businessId,
        userId: opts.user.id,
        orderId,
        amount: money(total - paidNow),
        status: 'Pending',
        dueDate: opts.dueInDays == null ? null : daysFromNow(opts.dueInDays),
        description: items
          .map((i) => `${i.productName} ×${i.quantity}`)
          .join(', '),
      });
    }

    // Akmal — partial debt (paid some now), due soon.
    await seedDebtSale({
      user: userRows[0],
      lines: [
        {product: productRows[0], qty: 2},
        {product: productRows[1], qty: 1},
      ],
      paidNow: 20000,
      dueInDays: 14,
    });
    // Dilnoza — full debt from a sale.
    await seedDebtSale({
      user: userRows[1],
      lines: [
        {product: productRows[2], qty: 3},
        {product: productRows[3], qty: 1},
      ],
      paidNow: 0,
      dueInDays: 7,
    });
    // Bobur — full debt from a sale, already overdue.
    await seedDebtSale({
      user: userRows[2],
      lines: [{product: productRows[4], qty: 4}],
      paidNow: 0,
      dueInDays: -10,
    });

    // A couple of manual tabs (no order) for variety.
    await db.insert(schema.userDebts).values([
      {
        id: generateId(),
        businessId,
        userId: userRows[3].id,
        amount: '48000.00',
        status: 'Pending',
        dueDate: null, // open-ended
        description: 'Informal tab',
      },
      {
        id: generateId(),
        businessId,
        userId: userRows[4].id,
        amount: '99000.00',
        status: 'Overdue',
        dueDate: daysFromNow(-1),
        description: 'Household items',
      },
    ]);
    console.log('✓ User debts created (3 from sales + 2 manual)');

    // 8. A demo "Cashier" role + staff account (sees only products & checkout).
    await ensureDemoStaff(db, businessId);

    console.log('\n🌱 Seed complete.');
  } finally {
    await client.end();
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
