import {Injectable} from '@nestjs/common';
import {and, asc, desc, eq, inArray, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  WEEK_DAYS,
  branchStock,
  branches,
  businesses,
  paymentMethods,
  products,
  type BranchWorkingHours,
  type WeekDay,
} from '../database/schema';
import {latinToCyrillic} from '../common/uz-translit';
import {StoreSettingsService} from '../order/store-settings.service';
import {isOpenAt} from '../branch/working-hours';
import type {LlmToolDef} from '../ai/providers/llm-provider.interface';

/**
 * The CUSTOMER tool set (AI-YORDAMCHI.md §3). Deliberately separate from the
 * owner's analytics registry (ai/tools): every tool here SELECTs only
 * whitelisted columns, so cost price, profit and sales figures cannot reach a
 * customer whatever the prompt says — the model never has them to leak.
 */

/** Q4: at or below this many on hand the bot says "oz qoldi", never the count. */
export const LOW_STOCK_AT = 2;
const MAX_RESULTS = 5;

// Cyrillic → Latin, for a Cyrillic query against Latin product names.
const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: "o'",
  қ: 'q', ғ: "g'", ҳ: 'h',
};

export function cyrillicToLatin(input: string): string | null {
  const lower = input.trim().toLowerCase();
  if (!/[Ѐ-ӿ]/.test(lower)) return null;
  let out = '';
  for (const ch of lower) out += CYR_TO_LAT[ch] ?? ch;
  return out;
}

/** Lowercase, unify apostrophes, squeeze spaces. */
function normalize(q: string): string {
  return q
    .toLowerCase()
    .replace(/[ʻʼ‘’`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryVariants(q: string): string[] {
  const base = normalize(q);
  const out = new Set<string>([base]);
  const cyr = latinToCyrillic(base);
  if (cyr) out.add(cyr);
  const lat = cyrillicToLatin(base);
  if (lat) out.add(lat);
  // "o'" written as plain "o" (and back) is the commonest Latin typo.
  out.add(base.replace(/'/g, ''));
  return [...out].filter((v) => v.length >= 2).slice(0, 4);
}

/** Mirrors the SQL translate(lower(name), 'c-', 'k ') on the query side. */
export function fold(v: string): string {
  return v.replace(/-/g, ' ').replace(/c/g, 'k').replace(/\s+/g, ' ').trim();
}

export type StockStatus = 'available' | 'low' | 'none';

const statusOf = (qty: number): StockStatus =>
  qty <= 0 ? 'none' : qty <= LOW_STOCK_AT ? 'low' : 'available';

const DAY_UZ: Record<WeekDay, string> = {
  mon: 'Dushanba', tue: 'Seshanba', wed: 'Chorshanba', thu: 'Payshanba',
  fri: 'Juma', sat: 'Shanba', sun: 'Yakshanba',
};

/** "Dushanba–Juma 09:00–21:00; Shanba 10:00–20:00; Yakshanba: dam olish". */
export function hoursText(h: BranchWorkingHours | null): string | null {
  if (!h) return null;
  const slot = (d: WeekDay) => {
    const v = h[d];
    return v ? `${v.open}–${v.close}` : null;
  };
  const groups: {from: WeekDay; to: WeekDay; slot: string | null}[] = [];
  for (const d of WEEK_DAYS) {
    const s = slot(d);
    const last = groups[groups.length - 1];
    if (last && last.slot === s) last.to = d;
    else groups.push({from: d, to: d, slot: s});
  }
  return groups
    .map((g) => {
      const days = g.from === g.to ? DAY_UZ[g.from] : `${DAY_UZ[g.from]}–${DAY_UZ[g.to]}`;
      return g.slot ? `${days} ${g.slot}` : `${days}: dam olish`;
    })
    .join('; ');
}

export interface AssistantContext {
  businessId: string;
  /** Storefront base URL (https://<slug>.<domain>) or null when the store is off. */
  storeBaseUrl: string | null;
}

export const CUSTOMER_TOOLS: LlmToolDef[] = [
  {
    name: 'search_products',
    description:
      "Search the shop's catalogue by name (any spelling: Latin, Cyrillic, " +
      'Russian, transliterated) or barcode. Returns up to 5 matches with the ' +
      'selling price and whether it is in stock anywhere. If nothing matches, ' +
      'try once more with another spelling (e.g. "ayfon" → "iphone", Cyrillic ' +
      '↔ Latin, singular) before saying it is not found.',
    parameters: {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'What the customer is looking for'},
      },
      required: ['query'],
    },
  },
  {
    name: 'product_stock',
    description:
      'Per-branch availability of one product: available / low / none. Never ' +
      'returns a count — do not invent one.',
    parameters: {
      type: 'object',
      properties: {productId: {type: 'string'}},
      required: ['productId'],
    },
  },
  {
    name: 'branches_info',
    description:
      'All branches: name, address, phone, weekly working hours, map link and ' +
      'whether each is open right now.',
    parameters: {type: 'object', properties: {}},
  },
  {
    name: 'delivery_info',
    description:
      'Online order terms: pickup and/or delivery, delivery fee, free-delivery ' +
      'threshold, minimum order.',
    parameters: {type: 'object', properties: {}},
  },
  {
    name: 'payment_methods',
    description: 'Payment methods the shop accepts.',
    parameters: {type: 'object', properties: {}},
  },
  {
    name: 'offer_order_button',
    // Its result tells the model nothing: the answer turn can end here.
    displayOnly: true,
    description:
      'Attach a "Buyurtma berish" button under your answer that opens the ' +
      'online store on these products (max 3). Use it when the customer wants ' +
      'to buy a product you found. The bot never takes the order in chat.',
    parameters: {
      type: 'object',
      properties: {
        productIds: {type: 'array', items: {type: 'string'}},
      },
      required: ['productIds'],
    },
  },
  {
    name: 'handoff',
    // Its result tells the model nothing: the answer turn can end here.
    displayOnly: true,
    description:
      'Pass the conversation to a human operator. Use when the answer is not ' +
      'in the tool results / FAQ / shop rules, when the customer asks for a ' +
      'person, complains, keeps haggling over price, or asks about an order ' +
      'they already placed. After calling it, write nothing else.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['unknown', 'haggle', 'customer_asked', 'complaint'],
        },
        summary: {
          type: 'string',
          description: 'One line for the operator: what the customer wants',
        },
      },
      required: ['reason', 'summary'],
    },
  },
  {
    name: 'ignore_message',
    // Its result tells the model nothing: the answer turn can end here.
    displayOnly: true,
    description:
      'The message is abuse or spam: send no reply at all. Never use it for an ' +
      'ordinary off-topic question — politely decline those instead.',
    parameters: {type: 'object', properties: {}},
  },
];

/** Side effects the model asked for during one answer. */
export interface ToolOutcome {
  orderProducts: {id: string; name: string; url: string}[];
  handoff: {reason: string; summary: string} | null;
  ignore: boolean;
}

@Injectable()
export class AssistantToolsService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly storeSettings: StoreSettingsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async storeBaseUrl(businessId: string): Promise<string | null> {
    const [biz] = await this.db
      .select({slug: businesses.storeSlug, enabled: businesses.storeEnabled})
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (!biz?.slug || !biz.enabled) return null;
    const root = process.env.STORE_ROOT_DOMAIN || 'kpos.uz';
    return `https://${biz.slug}.${root}`;
  }

  async execute(
    ctx: AssistantContext,
    outcome: ToolOutcome,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ok: boolean; result: unknown}> {
    switch (name) {
      case 'search_products':
        return {ok: true, result: await this.searchProducts(ctx, String(args.query ?? ''))};
      case 'product_stock':
        return this.productStock(ctx, String(args.productId ?? ''));
      case 'branches_info':
        return {ok: true, result: await this.branchesInfo(ctx.businessId)};
      case 'delivery_info':
        return {ok: true, result: await this.deliveryInfo(ctx)};
      case 'payment_methods':
        return {ok: true, result: await this.paymentMethods(ctx.businessId)};
      case 'offer_order_button':
        return this.offerOrderButton(ctx, outcome, args.productIds);
      case 'handoff':
        outcome.handoff = {
          reason: String(args.reason ?? 'unknown'),
          summary: String(args.summary ?? '').slice(0, 500),
        };
        return {ok: true, result: {handedOff: true}};
      case 'ignore_message':
        outcome.ignore = true;
        return {ok: true, result: {ignored: true}};
      default:
        return {ok: false, result: {error: `unknown tool ${name}`}};
    }
  }

  async searchProducts(ctx: AssistantContext, query: string) {
    const q = query.trim();
    if (q.length < 2) return {products: [], note: 'query too short'};
    // Compared on a "folded" form on both sides: c→k and hyphens → spaces,
    // so "кока кола" (→ "koka kola") meets "Coca-Cola".
    const variants = [...new Set(queryVariants(q).map(fold))];
    const lname = sql`translate(lower(${products.name}), 'c-', 'k ')`;
    const likes = variants.map(
      (v) => sql`${lname} LIKE ${'%' + v.replace(/[%_\\]/g, '\\$&') + '%'}`,
    );
    const sims = variants.map((v) => sql`word_similarity(${v}, ${lname})`);
    // "non" fuzzily matches "Note"; short words only match literally.
    const fuzzy = q.length > 4 ? sql`true` : sql`false`;
    const score = sql<number>`GREATEST(${sql.join(sims, sql`, `)})
      + CASE WHEN ${sql.join(likes, sql` OR `)} THEN 1 ELSE 0 END`;

    const rows = await this.db
      .select({
        id: products.id,
        name: products.name,
        priceOut: products.priceOut,
        quantity: products.quantity,
        quantityType: products.quantityType,
        score,
      })
      .from(products)
      .where(
        and(
          eq(products.businessId, ctx.businessId),
          eq(products.isActive, true),
          inArray(products.kind, ['stock', 'dish']),
          sql`(${sql.join(likes, sql` OR `)}
            OR ${products.barcode} = ${q}
            OR (${fuzzy} AND GREATEST(${sql.join(sims, sql`, `)}) >= 0.45))`,
        ),
      )
      .orderBy(desc(score), desc(sql`${products.quantity} > 0`), asc(products.name))
      .limit(MAX_RESULTS);

    return {
      products: rows.map((r) => ({
        id: r.id,
        name: r.name,
        price: Number(r.priceOut),
        unit: r.quantityType === 'kg' ? 'kg' : 'dona',
        stock: statusOf(r.quantity),
        url: ctx.storeBaseUrl ? `${ctx.storeBaseUrl}/products/${r.id}` : null,
      })),
    };
  }

  async productStock(ctx: AssistantContext, productId: string) {
    const [product] = await this.db
      .select({id: products.id, name: products.name})
      .from(products)
      .where(
        and(
          eq(products.id, productId),
          eq(products.businessId, ctx.businessId),
          eq(products.isActive, true),
        ),
      )
      .limit(1);
    if (!product) return {ok: false, result: {error: 'product not found'}};

    const rows = await this.db
      .select({
        branch: branches.name,
        quantity: sql<number>`coalesce(${branchStock.quantity}, 0)::float8`,
      })
      .from(branches)
      .leftJoin(
        branchStock,
        and(
          eq(branchStock.branchId, branches.id),
          eq(branchStock.productId, productId),
        ),
      )
      .where(and(eq(branches.businessId, ctx.businessId), eq(branches.isActive, true)))
      .orderBy(desc(branches.isDefault), asc(branches.name));

    return {
      ok: true,
      result: {
        product: product.name,
        branches: rows.map((r) => ({branch: r.branch, status: statusOf(r.quantity)})),
      },
    };
  }

  async branchesInfo(businessId: string) {
    const rows = await this.db
      .select({
        name: branches.name,
        address: branches.address,
        phone: branches.phone,
        workingHours: branches.workingHours,
        mapUrl: branches.mapUrl,
      })
      .from(branches)
      .where(and(eq(branches.businessId, businessId), eq(branches.isActive, true)))
      .orderBy(desc(branches.isDefault), asc(branches.name));
    const now = new Date();
    return {
      branches: rows.map(({workingHours, ...r}) => ({
        ...r,
        // Pre-written: small models misread a 7-key object (dropped Friday).
        hours: hoursText(workingHours),
        // null = hours not set: say you do not know, never guess.
        openNow: isOpenAt(workingHours, now),
      })),
    };
  }

  async deliveryInfo(ctx: AssistantContext) {
    const s = await this.storeSettings.get(ctx.businessId);
    return {
      onlineStore: ctx.storeBaseUrl !== null,
      pickup: s.pickupEnabled,
      delivery: s.deliveryEnabled,
      deliveryFee: s.deliveryFee,
      freeDeliveryFrom: s.freeDeliveryFrom,
      minDeliveryAmount: s.minDeliveryAmount,
    };
  }

  async paymentMethods(businessId: string) {
    const rows = await this.db
      .select({name: paymentMethods.name})
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.businessId, businessId),
          eq(paymentMethods.isActive, true),
          eq(paymentMethods.isVisible, true),
        ),
      )
      .orderBy(asc(paymentMethods.sortOrder));
    return {methods: rows.map((r) => r.name)};
  }

  private async offerOrderButton(
    ctx: AssistantContext,
    outcome: ToolOutcome,
    raw: unknown,
  ): Promise<{ok: boolean; result: unknown}> {
    if (!ctx.storeBaseUrl) {
      return {ok: false, result: {error: 'this shop has no online store'}};
    }
    const ids = (Array.isArray(raw) ? raw : []).map(String).slice(0, 3);
    if (!ids.length) return {ok: false, result: {error: 'no productIds'}};
    const found = await this.db
      .select({id: products.id, name: products.name})
      .from(products)
      .where(
        and(
          eq(products.businessId, ctx.businessId),
          eq(products.isActive, true),
          inArray(products.id, ids),
        ),
      );
    if (!found.length) return {ok: false, result: {error: 'products not found'}};
    const base = ctx.storeBaseUrl;
    outcome.orderProducts = found.map((p) => ({...p, url: `${base}/products/${p.id}`}));
    return {ok: true, result: {buttons: found.length}};
  }
}
