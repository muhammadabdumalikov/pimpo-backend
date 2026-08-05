/**
 * Centralised cache key builders + TTLs so every service caches consistently
 * and invalidation targets the exact same keys the reads populate.
 *
 * IMPORTANT: all tenant-scoped keys embed `businessId`. We deliberately do NOT
 * use the built-in URL-keyed CacheInterceptor, because businessId comes from the
 * JWT (not the URL) — a URL key would let two businesses share one cache entry.
 *
 * TTLs are in MILLISECONDS (cache-manager v7).
 */

export const TTL = {
  // A group — static / rarely changing
  PLANS: 6 * 60 * 60 * 1000, // 6h  — global plan catalogue
  SUBSCRIPTION: 3 * 60 * 1000, // 3m  — per-business plan/limits
  CATEGORIES: 5 * 60 * 1000, // 5m
  BRANDS: 5 * 60 * 1000, // 5m
  ROLES: 5 * 60 * 1000, // 5m
  SUPPLIERS: 5 * 60 * 1000, // 5m
  SETTINGS: 15 * 60 * 1000, // 15m — receipt settings
  LOYALTY: 15 * 60 * 1000, // 15m — loyalty program settings (write-invalidated)
  // Telegram notification toggles — read on every notifiable event (checkout,
  // shift open/close, cash movement), write-invalidated on the settings PUT.
  TELEGRAM_SETTINGS: 15 * 60 * 1000, // 15m
  // Receipt template resolve depends on registerId; short TTL (edits are rare
  // and reflecting within a minute is fine) instead of per-register invalidation.
  RECEIPT_RESOLVE: 60 * 1000, // 60s

  // Inventory-count lock: kept fresh explicitly (set on start, cleared on
  // completion). The TTL is only a safety refresh so a stale value can't outlive
  // a missed clear or a process restart — correctness comes from the DB fallback.
  STOCK_TAKE_ACTIVE: 30 * 60 * 1000, // 30m

  // Open shifts gate selling on the till and are hit on every checkout mount /
  // focus (refreshShift). A cashShift row is only written on open/close (never
  // by a sale), so we invalidate explicitly there; the TTL is a safety net.
  OPEN_SHIFTS: 60 * 1000, // 60s

  // B group — heavy aggregations; short TTL instead of write-invalidation
  ORDERS_SUMMARY: 45 * 1000, // 45s
  ORDERS_REVENUE: 45 * 1000, // 45s
  ORDERS_MONTHLY: 3 * 60 * 1000, // 3m
  ORDERS_PERFORMANCE: 3 * 60 * 1000, // 3m
  ORDERS_BY_EMPLOYEE: 3 * 60 * 1000, // 3m
  // Products-page stats panel: a heavy aggregate refetched on every (debounced)
  // search keystroke and filter change. Quantity moves on every sale, so
  // write-invalidation would be noisy — short TTL, same reasoning as ORDERS_SUMMARY.
  PRODUCT_STATS: 5 * 60 * 1000, // 5m

  // AI assistant tool results. Short: the owner asking "and today?" right after
  // a sale must see the sale. Long enough that a multi-step answer which reads
  // the same report twice only pays for it once.
  AI_TOOL: 60 * 1000, // 60s
  // Hourly question counter; the key itself carries the hour, so the TTL only
  // has to outlive the bucket.
  AI_RATE: 70 * 60 * 1000, // 70m
  // Provider model catalogue. Long: vendors ship models weekly at most, and the
  // settings page has an explicit refresh button for the impatient.
  AI_MODELS: 60 * 60 * 1000, // 1h
} as const;

/** Stable, compact suffix for endpoints whose result depends on query params. */
export function paramsKey(params: Record<string, unknown> | undefined): string {
  if (!params) return 'none';
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`);
  return entries.length ? entries.join('&') : 'none';
}

export const CacheKeys = {
  // A group
  plansAll: () => 'plans:all',
  planById: (id: string) => `plans:id:${id}`,
  subscriptionCurrent: (businessId: string) => `sub:current:${businessId}`,
  subscriptionLimits: (businessId: string) => `sub:limits:${businessId}`,
  subscriptionBilling: (businessId: string) => `sub:billing:${businessId}`,
  categories: (businessId: string) => `categories:${businessId}`,
  brands: (businessId: string) => `brands:${businessId}`,
  roles: (businessId: string) => `roles:${businessId}`,
  suppliers: (businessId: string) => `suppliers:${businessId}`,
  settingsReceipt: (businessId: string) => `settings:receipt:${businessId}`,
  loyaltySettings: (businessId: string) => `loyalty:settings:${businessId}`,
  telegramSettings: (businessId: string) => `tg:settings:${businessId}`,
  units: (businessId: string) => `units:${businessId}`,
  paymentMethods: (businessId: string) => `paymethods:${businessId}`,
  stockTakeActive: (businessId: string) => `stocktake:active:${businessId}`,
  openShifts: (businessId: string) => `shifts:open:${businessId}`,
  receiptTemplateResolve: (businessId: string, registerId?: string | null) =>
    `rt:resolve:${businessId}:${registerId ?? 'none'}`,

  // B group — include a params suffix so different ranges don't collide
  ordersSummary: (businessId: string, p?: Record<string, unknown>) =>
    `orders:summary:${businessId}:${paramsKey(p)}`,
  ordersRevenue: (businessId: string, p?: Record<string, unknown>) =>
    `orders:revenue:${businessId}:${paramsKey(p)}`,
  ordersMonthly: (businessId: string, p?: Record<string, unknown>) =>
    `orders:monthly:${businessId}:${paramsKey(p)}`,
  ordersPerformance: (businessId: string, p?: Record<string, unknown>) =>
    `orders:perf:${businessId}:${paramsKey(p)}`,
  ordersByEmployee: (businessId: string, p?: Record<string, unknown>) =>
    `orders:byemp:${businessId}:${paramsKey(p)}`,
  productStats: (businessId: string, p?: Record<string, unknown>) =>
    `products:stats:${businessId}:${paramsKey(p)}`,

  // AI assistant tool calls. The model often asks for the same report twice in
  // one conversation (e.g. "and compare that to last month"), and ReportService
  // itself is uncached, so this is where those repeats get absorbed.
  aiTool: (businessId: string, tool: string, p?: Record<string, unknown>) =>
    `ai:tool:${businessId}:${tool}:${paramsKey(p)}`,
  /** Sliding hourly question counter, per business. */
  aiRate: (businessId: string, hourBucket: string) =>
    `ai:rate:${businessId}:${hourBucket}`,
  /** Model catalogue for a business's configured provider. */
  aiModels: (businessId: string, provider: string) =>
    `ai:models:${businessId}:${provider}`,
} as const;
