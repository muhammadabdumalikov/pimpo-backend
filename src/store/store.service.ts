import { Injectable } from '@nestjs/common';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { DatabaseService } from '../database/database.service';
import {
  products,
  orders,
  businesses,
  storeBots,
  branchStock,
} from '../database/schema';
import { eq, and, desc, count, inArray, ilike, sql } from 'drizzle-orm';
import { SubscriptionService } from '../subscription/subscription.service';
import { tierAtLeast } from '../subscription/tier';
import {
  StoreSettingsService,
  type StoreDeliverySettings,
} from '../order/store-settings.service';
import {
  OnlineOrderService,
  type StorefrontOrderView,
} from '../order/online-order.service';
import type { StoreFulfilment } from '../order/order.service';
import { deliveryFeeFor } from '../order/online-order.rules';
import type { StoreCheckoutDto } from './dto/store-checkout.dto';

// The online storefront is a Business-plan (`pro`) feature. Unlike the admin
// API there is no JWT here to hang PlanTierGuard off, so the tier is checked
// once in resolveBusinessId — the single choke point every storefront read and
// the checkout already go through.
const STORE_MIN_TIER = 'pro' as const;

// Public product shape for the storefront. Never expose the full products row:
// priceIn (cost), barcode, businessId etc. are internal.
const publicProductColumns = {
  id: products.id,
  name: products.name,
  priceOut: products.priceOut,
  image: products.image,
  categoryId: products.categoryId,
  quantity: products.quantity,
  quantityType: products.quantityType,
};

// On hand at the branch online orders are served from (YETKAZISH.md Q14);
// the unscoped dev storefront (no business) keeps the all-branch total.
const onHand = (branchId: string | null) =>
  branchId
    ? sql<number>`coalesce(${branchStock.quantity}, 0)::float8`
    : sql<number>`${products.quantity}`;

export type StorePublicProduct = {
  id: string;
  name: string;
  priceOut: string;
  image: string | null;
  categoryId: string | null;
  quantity: number;
  quantityType: string | null;
};

@Injectable()
export class StoreService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly subscriptionService: SubscriptionService,
    private readonly storeSettings: StoreSettingsService,
    private readonly onlineOrders: OnlineOrderService,
  ) {}

  /** The branch whose stock the storefront sells; null when unscoped. */
  private async stockBranchId(businessId: string | null): Promise<string | null> {
    if (!businessId) return null;
    return (await this.storeSettings.onlineBranch(businessId)).id;
  }

  private stockJoin(branchId: string | null) {
    return and(
      eq(branchStock.productId, products.id),
      eq(branchStock.branchId, branchId ?? ''),
    );
  }

  /**
   * Resolve the storefront's business from the request's subdomain slug.
   * - A slug (e.g. "salom" from salom.kpos.uz) must map to an enabled, active
   *   store on a Business (`pro`) plan or higher, else STORE_NOT_FOUND.
   * - No slug (apex domain / local dev) falls back to the STORE_BUSINESS_ID env,
   *   or null (unscoped) when that is unset too.
   * The resolved businessId is threaded into every query below so one tenant's
   * storefront can never read or order another's catalog.
   */
  async resolveBusinessId(slug?: string | null): Promise<string | null> {
    const trimmed = slug?.trim().toLowerCase();
    if (trimmed) {
      const [biz] = await this.dbService.db
        .select({ id: businesses.id })
        .from(businesses)
        .where(
          and(
            eq(businesses.storeSlug, trimmed),
            eq(businesses.storeEnabled, true),
            eq(businesses.isActive, true),
          ),
        )
        .limit(1);
      if (!biz) {
        throw new AppException(ErrorCode.STORE_NOT_FOUND);
      }
      // A downgraded/expired shop keeps its slug and data but its public store
      // goes dark. Reported as STORE_NOT_FOUND rather than a plan error: the
      // visitor is a shopper, not the subscriber, and must not be shown the
      // tenant's billing state.
      const tier = await this.subscriptionService.getEffectiveTier(biz.id);
      if (!tierAtLeast(tier, STORE_MIN_TIER)) {
        throw new AppException(ErrorCode.STORE_NOT_FOUND);
      }
      return biz.id;
    }
    return process.env.STORE_BUSINESS_ID || null;
  }

  /**
   * The bot this storefront speaks through: the shop's own store bot when it
   * has connected one, else the platform bot. It is what mini-app launch
   * payloads are verified against, so getting it wrong means a valid customer
   * reads as anonymous — never cross-tenant access, since the businessId is
   * resolved from the host slug first and the token is looked up from it.
   */
  async resolveBotToken(
    businessId: string | null,
  ): Promise<string | undefined> {
    if (businessId) {
      const [row] = await this.dbService.db
        .select({botToken: storeBots.botToken})
        .from(storeBots)
        .where(eq(storeBots.businessId, businessId))
        .limit(1);
      if (row?.botToken) return row.botToken;
    }
    return process.env.TELEGRAM_BOT_TOKEN || undefined;
  }

  /** Public storefront branding for the resolved business (name shown in the
   *  header/footer) and how orders can be handed over. Null businessId (apex,
   *  unscoped) returns a neutral name and the default fulfilment. */
  async getInfo(businessId: string | null): Promise<{
    name: string | null;
    slug: string | null;
    fulfilment: {
      pickupEnabled: boolean;
      deliveryEnabled: boolean;
      deliveryFee: number;
      freeDeliveryFrom: number | null;
      minDeliveryAmount: number | null;
      pickupBranchName: string | null;
      pickupAddress: string | null;
    };
  }> {
    if (!businessId) {
      return {
        name: null,
        slug: null,
        fulfilment: {
          pickupEnabled: true,
          deliveryEnabled: true,
          deliveryFee: 0,
          freeDeliveryFrom: null,
          minDeliveryAmount: null,
          pickupBranchName: null,
          pickupAddress: null,
        },
      };
    }
    const [[biz], settings] = await Promise.all([
      this.dbService.db
        .select({ name: businesses.name, slug: businesses.storeSlug })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1),
      this.storeSettings.get(businessId),
    ]);
    const branch = await this.storeSettings.onlineBranch(businessId, settings);
    return {
      name: biz?.name ?? null,
      slug: biz?.slug ?? null,
      fulfilment: {
        pickupEnabled: settings.pickupEnabled,
        deliveryEnabled: settings.deliveryEnabled,
        deliveryFee: settings.deliveryFee,
        freeDeliveryFrom: settings.freeDeliveryFrom,
        minDeliveryAmount: settings.minDeliveryAmount,
        pickupBranchName: branch.name,
        pickupAddress: branch.address,
      },
    };
  }

  private scopeConditions(businessId: string | null) {
    const conditions = [eq(products.isActive, true)];
    if (businessId) {
      conditions.push(eq(products.businessId, businessId));
    }
    return conditions;
  }

  async findAll(
    businessId: string | null,
    options?: {
      category?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{
    products: StorePublicProduct[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = options?.page || 1;
    const limit = Math.min(options?.limit || 100, 100);
    const offset = (page - 1) * limit;
    const category = options?.category;
    const search = options?.search?.trim();

    const conditions = this.scopeConditions(businessId);
    if (category) {
      conditions.push(eq(products.categoryId, category));
    }
    if (search) {
      conditions.push(ilike(products.name, `%${search}%`));
    }

    const totalResult = await this.dbService.db
      .select({ count: count() })
      .from(products)
      .where(and(...conditions));
    const total = totalResult[0]?.count ?? 0;

    const branchId = await this.stockBranchId(businessId);
    const quantity = onHand(branchId);
    const list = await this.dbService.db
      .select({ ...publicProductColumns, quantity })
      .from(products)
      .leftJoin(branchStock, this.stockJoin(branchId))
      .where(and(...conditions))
      // In-stock products first (search and category listings alike), newest
      // within each group.
      .orderBy(sql`(${quantity} > 0) DESC`, desc(products.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      products: list,
      total,
      page,
      limit,
    };
  }

  async findOne(
    businessId: string | null,
    id: string,
  ): Promise<StorePublicProduct> {
    const branchId = await this.stockBranchId(businessId);
    const [product] = await this.dbService.db
      .select({ ...publicProductColumns, quantity: onHand(branchId) })
      .from(products)
      .leftJoin(branchStock, this.stockJoin(branchId))
      .where(and(eq(products.id, id), ...this.scopeConditions(businessId)))
      .limit(1);

    if (!product) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND);
    }
    return product;
  }

  /**
   * Public order-status lookup for the storefront customer. The order id (an
   * unguessable UUID handed out at checkout) is the access token; only
   * storefront orders are visible, and only safe fields are returned.
   */
  async findOrder(
    businessId: string | null,
    id: string,
  ): Promise<StorefrontOrderView> {
    const [order] = await this.dbService.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.id, id),
          eq(orders.source, 'store'),
          ...(businessId ? [eq(orders.businessId, businessId)] : []),
        ),
      )
      .limit(1);
    if (!order) {
      throw new AppException(ErrorCode.ORDER_NOT_FOUND);
    }
    const [view] = await this.onlineOrders.storefrontViews([order.id]);
    return view;
  }

  /**
   * Order history for a verified Telegram mini-app customer.
   *
   * The plain-web storefront remembers order ids in localStorage, which a
   * Telegram webview does not keep reliably and never carries to the
   * customer's other devices. Once the launch payload is verified the user id
   * itself is the key, so history survives both. Same public projection as
   * findOrder — never the raw order row.
   */
  async findOrdersByTelegramUser(
    businessId: string | null,
    telegramUserId: string,
    limit = 30,
  ): Promise<StorefrontOrderView[]> {
    const rows = await this.dbService.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.telegramUserId, telegramUserId),
          eq(orders.source, 'store'),
          ...(businessId ? [eq(orders.businessId, businessId)] : []),
        ),
      )
      .orderBy(desc(sql`coalesce(${orders.placedAt}, ${orders.createdAt})`))
      .limit(Math.min(limit, 50));
    return this.onlineOrders.storefrontViews(rows.map((r) => r.id));
  }

  /**
   * Checkout guard + fulfilment (YETKAZISH.md §4.3): every product must be in
   * this storefront's scope and on hand at the online branch, the chosen
   * method must be on, a delivery needs an address and the shop's minimum,
   * and the delivery fee is fixed here, from the card prices, once (Q23).
   */
  async prepareCheckout(
    businessId: string | null,
    dto: StoreCheckoutDto,
  ): Promise<{ branchId: string; fulfilment: StoreFulfilment }> {
    const owner = businessId ?? (await this.ownerOf(dto.items[0]?.productId));
    const settings = await this.storeSettings.get(owner);
    const branch = await this.storeSettings.onlineBranch(owner, settings);
    const subtotal = await this.assertOrderable(businessId, dto.items, branch.id);
    return {
      branchId: branch.id,
      fulfilment: this.fulfilmentFor(dto, settings, subtotal),
    };
  }

  private fulfilmentFor(
    dto: StoreCheckoutDto,
    settings: StoreDeliverySettings,
    subtotal: number,
  ): StoreFulfilment {
    // A client that sends no choice (one method on, or an older storefront)
    // gets pickup when the shop offers it.
    const type =
      dto.deliveryType ?? (settings.pickupEnabled ? 'pickup' : 'delivery');
    const enabled =
      type === 'pickup' ? settings.pickupEnabled : settings.deliveryEnabled;
    if (!enabled) {
      throw new AppException(ErrorCode.STORE_FULFILLMENT_UNAVAILABLE);
    }
    if (type === 'pickup') {
      return { deliveryType: 'pickup', deliveryFee: 0, locale: dto.locale ?? null };
    }
    const address = dto.address?.trim();
    if (!address) {
      throw new AppException(ErrorCode.STORE_DELIVERY_ADDRESS_REQUIRED);
    }
    if (
      settings.minDeliveryAmount != null &&
      subtotal < settings.minDeliveryAmount
    ) {
      throw new AppException(ErrorCode.STORE_DELIVERY_MIN_AMOUNT, {
        min: settings.minDeliveryAmount,
      });
    }
    const located = dto.lat != null && dto.lng != null;
    return {
      deliveryType: 'delivery',
      address,
      lat: located ? dto.lat : null,
      lng: located ? dto.lng : null,
      deliveryFee: deliveryFeeFor(subtotal, settings),
      locale: dto.locale ?? null,
    };
  }

  private async ownerOf(productId?: string): Promise<string> {
    const [row] = productId
      ? await this.dbService.db
          .select({ businessId: products.businessId })
          .from(products)
          .where(eq(products.id, productId))
          .limit(1)
      : [];
    if (!row) {
      throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
        productId: productId ?? '',
      });
    }
    return row.businessId;
  }

  /**
   * Every ordered product must exist in the storefront's scope (active +
   * store business) and be on hand at the branch the order draws from. The
   * sale itself still runs through order.service.create, which consumes
   * batches; this turns a silent oversell into a clear customer-facing error.
   * Returns the goods subtotal at card prices.
   */
  async assertOrderable(
    businessId: string | null,
    items: { productId: string; quantity: number }[],
    branchId: string | null,
  ): Promise<number> {
    const ids = items.map((i) => i.productId);
    const rows = await this.dbService.db
      .select({
        id: products.id,
        name: products.name,
        priceOut: products.priceOut,
        quantity: onHand(branchId),
      })
      .from(products)
      .leftJoin(branchStock, this.stockJoin(branchId))
      .where(and(inArray(products.id, ids), ...this.scopeConditions(businessId)));
    const byId = new Map(rows.map((r) => [r.id, r]));

    let subtotal = 0;
    for (const item of items) {
      const product = byId.get(item.productId);
      if (!product) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND_BY_ID, {
          productId: item.productId,
        });
      }
      if (product.quantity < item.quantity) {
        throw new AppException(ErrorCode.STORE_INSUFFICIENT_STOCK, {
          qty: item.quantity,
          name: product.name,
          available: product.quantity,
        });
      }
      subtotal += Number(product.priceOut) * item.quantity;
    }
    return subtotal;
  }
}
