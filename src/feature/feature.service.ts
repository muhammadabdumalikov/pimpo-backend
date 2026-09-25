import {Inject, Injectable, Logger} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {and, asc, count, eq, inArray} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  businesses,
  businessFeatureFlags,
  featureFlags,
} from '../database/schema';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {CacheKeys, TTL} from '../cache/cache.util';
import {
  FEATURES,
  findFeature,
  type FeatureDefinition,
  type FeatureKey,
} from './feature.catalog';
import {asRollout, isFeatureOn, type Rollout} from './feature.resolve';

/**
 * The whole platform-wide flag state. Small by construction — a handful of
 * flags, each with the few shops on its beta or exclusion list — so it is kept
 * as ONE cache entry and resolved in memory: a rollout change touches every
 * business, and a single key is the only thing one cache.del can reach.
 */
interface FeatureState {
  rollouts: Record<string, Rollout>;
  /** featureKey → businessId → enabled */
  overrides: Record<string, Record<string, boolean>>;
}

const EMPTY_STATE: FeatureState = {rollouts: {}, overrides: {}};

/** One flag as the platform console's list shows it. */
export interface PlatformFeatureRow extends FeatureDefinition {
  rollout: Rollout;
  /** Shops with an enabled override — the beta list. */
  selectedCount: number;
  /** Shops with a disabled override — the exclusion list. */
  excludedCount: number;
  /** Shops the flag is actually on for right now. */
  activeCount: number;
  updatedAt: Date | null;
}

export interface PlatformFeatureOverride {
  businessId: string;
  name: string;
  login: string;
  isActive: boolean;
  enabled: boolean;
  createdAt: Date;
}

export interface BusinessFeatureRow extends FeatureDefinition {
  rollout: Rollout;
  /** This shop's own exception, or null when it follows the rollout. */
  override: boolean | null;
  enabled: boolean;
}

/**
 * Feature flags per do'kon: which shops see a feature that is still rolling
 * out. Keys come from FEATURE_CATALOG; the platform console sets each one's
 * rollout and per-shop exceptions (see isFeatureOn for the rules).
 *
 * Reads go L1 (10s, in process) → Redis → Postgres, the same shape as
 * PermissionService and for the same reason: L1 keeps a Redis outage from
 * turning every gated request into a DB read.
 */
@Injectable()
export class FeatureService {
  private static readonly L1_TTL_MS = 10_000;
  private readonly logger = new Logger(FeatureService.name);
  private l1: {value: FeatureState; until: number} | null = null;

  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ── Tenant side ────────────────────────────────────────────────────────────

  /** Keys of every flag that is on for this business. */
  async enabledFor(businessId: string): Promise<string[]> {
    if (!FEATURES.length) return [];
    const state = await this.state();
    return FEATURES.filter((f) => on(state, f.key, businessId)).map(
      (f) => f.key,
    );
  }

  async isEnabled(businessId: string, key: FeatureKey): Promise<boolean> {
    return this.isOn(businessId, key);
  }

  /** For service code paths that branch inside an endpoint rather than gate it. */
  async assert(businessId: string, key: FeatureKey): Promise<void> {
    return this.assertOn(businessId, key);
  }

  /**
   * Untyped twin of assert() for FeatureGuard, which reads the key back from
   * route metadata. Everything else should call assert() so a mistyped key
   * fails to compile.
   */
  async assertOn(businessId: string, key: string): Promise<void> {
    if (!(await this.isOn(businessId, key))) {
      throw new AppException(ErrorCode.FEATURE_NOT_ENABLED, {feature: key});
    }
  }

  private async isOn(businessId: string, key: string): Promise<boolean> {
    const state = await this.state();
    return on(state, key, businessId);
  }

  private async state(): Promise<FeatureState> {
    if (this.l1 && this.l1.until > Date.now()) return this.l1.value;
    try {
      const value = await this.cache.wrap(
        CacheKeys.featureState(),
        () => this.loadState(),
        TTL.FEATURES,
      );
      this.l1 = {value, until: Date.now() + FeatureService.L1_TTL_MS};
      return value;
    } catch (err) {
      // Fail CLOSED and cache nothing: a beta that briefly disappears is a
      // far smaller problem than one that briefly reaches every shop. Also
      // covers the tables not being migrated yet.
      this.logger.warn(
        `Feature state unavailable, all flags off: ${String(err)}`,
      );
      return EMPTY_STATE;
    }
  }

  private async loadState(): Promise<FeatureState> {
    const db = this.dbService.db;
    const [flags, overrides] = await Promise.all([
      db
        .select({key: featureFlags.key, rollout: featureFlags.rollout})
        .from(featureFlags),
      db
        .select({
          featureKey: businessFeatureFlags.featureKey,
          businessId: businessFeatureFlags.businessId,
          enabled: businessFeatureFlags.enabled,
        })
        .from(businessFeatureFlags),
    ]);

    const state: FeatureState = {rollouts: {}, overrides: {}};
    for (const f of flags) state.rollouts[f.key] = asRollout(f.rollout);
    for (const o of overrides) {
      (state.overrides[o.featureKey] ??= {})[o.businessId] = o.enabled;
    }
    return state;
  }

  private async invalidate(): Promise<void> {
    this.l1 = null;
    await this.cache.del(CacheKeys.featureState());
  }

  // ── Platform console ───────────────────────────────────────────────────────

  async listForPlatform(): Promise<PlatformFeatureRow[]> {
    if (!FEATURES.length) return [];
    const db = this.dbService.db;
    const [flags, overrideCounts, [{total}]] = await Promise.all([
      db.select().from(featureFlags),
      db
        .select({
          featureKey: businessFeatureFlags.featureKey,
          enabled: businessFeatureFlags.enabled,
          n: count(),
        })
        .from(businessFeatureFlags)
        .groupBy(businessFeatureFlags.featureKey, businessFeatureFlags.enabled),
      db.select({total: count()}).from(businesses),
    ]);

    const flagByKey = new Map(flags.map((f) => [f.key, f]));
    return FEATURES.map((def) => {
      const row = flagByKey.get(def.key);
      const rollout = asRollout(row?.rollout);
      const countOf = (enabled: boolean) =>
        overrideCounts.find(
          (c) => c.featureKey === def.key && c.enabled === enabled,
        )?.n ?? 0;
      const selectedCount = countOf(true);
      const excludedCount = countOf(false);
      const activeCount =
        rollout === 'all'
          ? total - excludedCount
          : rollout === 'selected'
            ? selectedCount
            : 0;
      return {
        ...def,
        rollout,
        selectedCount,
        excludedCount,
        activeCount,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async getForPlatform(
    key: string,
  ): Promise<PlatformFeatureRow & {overrides: PlatformFeatureOverride[]}> {
    const def = this.requireFeature(key);
    const [row] = (await this.listForPlatform()).filter(
      (f) => f.key === def.key,
    );
    const overrides = await this.dbService.db
      .select({
        businessId: businessFeatureFlags.businessId,
        name: businesses.name,
        login: businesses.login,
        isActive: businesses.isActive,
        enabled: businessFeatureFlags.enabled,
        createdAt: businessFeatureFlags.createdAt,
      })
      .from(businessFeatureFlags)
      .innerJoin(businesses, eq(businesses.id, businessFeatureFlags.businessId))
      .where(eq(businessFeatureFlags.featureKey, def.key))
      .orderBy(asc(businesses.name));
    return {...row, overrides};
  }

  async setRollout(key: string, rollout: Rollout): Promise<PlatformFeatureRow> {
    const def = this.requireFeature(key);
    const now = new Date();
    await this.dbService.db
      .insert(featureFlags)
      .values({key: def.key, rollout, updatedAt: now})
      .onConflictDoUpdate({
        target: featureFlags.key,
        set: {rollout, updatedAt: now},
      });
    await this.invalidate();
    const [row] = (await this.listForPlatform()).filter(
      (f) => f.key === def.key,
    );
    return row;
  }

  /**
   * Put shops on a flag's beta list (enabled = true) or its exclusion list
   * (enabled = false). Re-adding a shop flips its existing row.
   */
  async setOverrides(
    key: string,
    businessIds: string[],
    enabled: boolean,
  ): Promise<{updated: number}> {
    const def = this.requireFeature(key);
    const ids = [...new Set(businessIds)];
    if (!ids.length) return {updated: 0};
    await this.assertBusinessesExist(ids);

    await this.dbService.db
      .insert(businessFeatureFlags)
      .values(
        ids.map((businessId) => ({businessId, featureKey: def.key, enabled})),
      )
      .onConflictDoUpdate({
        target: [
          businessFeatureFlags.businessId,
          businessFeatureFlags.featureKey,
        ],
        set: {enabled},
      });
    await this.invalidate();
    return {updated: ids.length};
  }

  /** Drop a shop's exception so it follows the rollout again. */
  async removeOverride(key: string, businessId: string): Promise<void> {
    const def = this.requireFeature(key);
    await this.dbService.db
      .delete(businessFeatureFlags)
      .where(
        and(
          eq(businessFeatureFlags.featureKey, def.key),
          eq(businessFeatureFlags.businessId, businessId),
        ),
      );
    await this.invalidate();
  }

  /** Every flag as it stands for one shop — the business detail page. */
  async forBusiness(businessId: string): Promise<BusinessFeatureRow[]> {
    await this.assertBusinessesExist([businessId]);
    if (!FEATURES.length) return [];
    const db = this.dbService.db;
    const [flags, overrides] = await Promise.all([
      db.select().from(featureFlags),
      db
        .select()
        .from(businessFeatureFlags)
        .where(eq(businessFeatureFlags.businessId, businessId)),
    ]);
    const rolloutOf = new Map(flags.map((f) => [f.key, asRollout(f.rollout)]));
    const overrideOf = new Map(overrides.map((o) => [o.featureKey, o.enabled]));
    return FEATURES.map((def) => {
      const rollout = rolloutOf.get(def.key) ?? 'off';
      const override = overrideOf.get(def.key);
      return {
        ...def,
        rollout,
        override: override ?? null,
        enabled: isFeatureOn(rollout, override),
      };
    });
  }

  /** Set (true/false) or clear (null) one shop's exception to one flag. */
  async setBusinessOverride(
    businessId: string,
    key: string,
    enabled: boolean | null,
  ): Promise<BusinessFeatureRow[]> {
    if (enabled === null) {
      await this.removeOverride(key, businessId);
    } else {
      await this.setOverrides(key, [businessId], enabled);
    }
    return this.forBusiness(businessId);
  }

  private requireFeature(key: string): FeatureDefinition {
    const def = findFeature(key);
    if (!def)
      throw new AppException(ErrorCode.FEATURE_NOT_FOUND, {feature: key});
    return def;
  }

  private async assertBusinessesExist(ids: string[]): Promise<void> {
    const found = await this.dbService.db
      .select({id: businesses.id})
      .from(businesses)
      .where(inArray(businesses.id, ids));
    if (found.length !== ids.length) {
      throw new AppException(ErrorCode.BUSINESS_NOT_FOUND);
    }
  }
}

function on(state: FeatureState, key: string, businessId: string): boolean {
  return isFeatureOn(
    state.rollouts[key] ?? 'off',
    state.overrides[key]?.[businessId],
  );
}
