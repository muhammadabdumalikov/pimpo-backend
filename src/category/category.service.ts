import { Injectable, Inject } from '@nestjs/common';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { DatabaseService } from '../database/database.service';
import { categories, type Category, type NewCategory } from '../database/schema';
import { eq, and } from 'drizzle-orm';
import { CacheKeys, TTL } from '../cache/cache.util';
import {generateId} from '../utils/uuid';
import type {CatalogLocale} from './category-locale';
import {
  allNames,
  GlobalCatalogService,
  localizedName,
  type CatalogSnapshot,
} from './global-catalog.service';
import {CategorySuggestService, type CategorySuggestion} from './category-suggest.service';

/**
 * A category as the API returns it: `name` is always filled — a global row's
 * name is read from global_categories in the caller's language, and its
 * picture falls back to the global one.
 */
export interface CategoryView extends Omit<Category, 'name'> {
  name: string;
}

export interface ApplyPresetResult {
  /** Rows created or revived. */
  added: number;
  /** Asked for but already there (same global key, or a same-named own category). */
  skipped: number;
  categories: CategoryView[];
}

/** Most global keys / own names one "apply" may carry. */
const MAX_APPLY_GLOBAL = 200;
const MAX_APPLY_CUSTOM = 50;

/** The row id a global category gets in a shop (AI-SOZLASH.md §3). */
export function globalCategoryRowId(key: string): string {
  return `g-${key}`;
}

@Injectable()
export class CategoryService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly catalog: GlobalCatalogService,
    private readonly suggester: CategorySuggestService,
  ) {}

  async create(businessId: string, data: { id: string; name: string; image?: string }): Promise<Category> {
    const existing = await this.dbService.db
      .select()
      .from(categories)
      .where(and(
        eq(categories.businessId, businessId),
        eq(categories.id, data.id),
        eq(categories.isDeleted, false),
      ))
      .limit(1);
    if (existing.length > 0) {
      throw new AppException(ErrorCode.CATEGORY_ALREADY_EXISTS);
    }
    const newCat: NewCategory = {
      id: data.id,
      businessId,
      name: data.name,
      image: data.image ?? null,
      isDeleted: false,
    };
    const [cat] = await this.dbService.db.insert(categories).values(newCat).returning();
    await this.cache.del(CacheKeys.categories(businessId));
    return cat;
  }

  /** The shop's live categories, named in `locale`, sorted by that name. */
  async findAll(businessId: string, locale: CatalogLocale = 'uz'): Promise<CategoryView[]> {
    const rows = await this.cache.wrap(
      CacheKeys.categories(businessId),
      () =>
        this.dbService.db
          .select()
          .from(categories)
          .where(and(eq(categories.businessId, businessId), eq(categories.isDeleted, false))),
      TTL.CATEGORIES,
    );
    return this.present(rows, locale);
  }

  async findOne(businessId: string, categoryId: string): Promise<Category | null> {
    const [cat] = await this.dbService.db
      .select()
      .from(categories)
      .where(and(
        eq(categories.businessId, businessId),
        eq(categories.id, categoryId),
        eq(categories.isDeleted, false),
      ))
      .limit(1);
    return cat ?? null;
  }

  async findOneView(
    businessId: string,
    categoryId: string,
    locale: CatalogLocale,
  ): Promise<CategoryView | null> {
    const cat = await this.findOne(businessId, categoryId);
    if (!cat) return null;
    const [view] = await this.present([cat], locale);
    return view ?? null;
  }

  async update(
    businessId: string,
    categoryId: string,
    data: { name?: string; image?: string },
  ): Promise<Category> {
    const existing = await this.findOne(businessId, categoryId);
    if (!existing) {
      throw new AppException(ErrorCode.CATEGORY_NOT_FOUND);
    }
    // A ready-made category's name and picture belong to the shared list; a
    // different name is the shop's own category (Q23).
    if (existing.globalKey && (data.name !== undefined || data.image !== undefined)) {
      throw new AppException(ErrorCode.CATEGORY_GLOBAL_READONLY);
    }
    const [cat] = await this.dbService.db
      .update(categories)
      .set({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.image !== undefined && { image: data.image }),
        updatedAt: new Date(),
      })
      .where(and(eq(categories.businessId, businessId), eq(categories.id, categoryId)))
      .returning();
    await this.cache.del(CacheKeys.categories(businessId));
    return cat;
  }

  async remove(businessId: string, categoryId: string): Promise<void> {
    const existing = await this.findOne(businessId, categoryId);
    if (!existing) {
      throw new AppException(ErrorCode.CATEGORY_NOT_FOUND);
    }
    await this.dbService.db
      .update(categories)
      .set({ isDeleted: true, updatedAt: new Date() })
      .where(and(eq(categories.businessId, businessId), eq(categories.id, categoryId)));
    await this.cache.del(CacheKeys.categories(businessId));
  }

  async findAllForStore(
    businessId: string | undefined,
    locale: CatalogLocale = 'uz',
  ): Promise<CategoryView[]> {
    const notDeleted = eq(categories.isDeleted, false);
    const rows = await this.dbService.db
      .select()
      .from(categories)
      .where(businessId ? and(eq(categories.businessId, businessId), notDeleted) : notDeleted);
    return this.present(rows, locale);
  }

  /**
   * Adds ready-made categories and the owner's own names (the wizard's step 2,
   * and "Tayyor kategoriyalar qo'shish"). Only ever adds: an existing category
   * is never renamed or removed, a removed global row is revived (its products
   * come back with it), and nothing is created twice — a global category is
   * skipped when the shop already has its own category of the same name in
   * any language, an own name when any live category already reads the same.
   */
  async applyPreset(
    businessId: string,
    input: {globalKeys?: string[]; customNames?: string[]},
    locale: CatalogLocale,
  ): Promise<ApplyPresetResult> {
    const snap = await this.catalog.snapshot();
    const globalKeys = unique(input.globalKeys ?? [])
      .slice(0, MAX_APPLY_GLOBAL)
      .filter((k) => snap.categories.get(k)?.isHidden === false);
    const customNames = uniqueCi(
      (input.customNames ?? []).map((n) => n.replace(/\s+/g, ' ').trim().slice(0, 255)),
    ).slice(0, MAX_APPLY_CUSTOM);

    let added = 0;
    let skipped = 0;
    await this.dbService.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(categories)
        .where(eq(categories.businessId, businessId));
      const plan = planPreset(rows, snap, globalKeys, customNames);
      skipped = plan.skipped;

      for (const id of plan.revive) {
        await tx
          .update(categories)
          .set({isDeleted: false, updatedAt: new Date()})
          .where(and(eq(categories.businessId, businessId), eq(categories.id, id)));
        added++;
      }
      for (const key of plan.insertGlobal) {
        const inserted = await tx
          .insert(categories)
          .values({
            id: globalCategoryRowId(key),
            businessId,
            name: null,
            globalKey: key,
            isDeleted: false,
          })
          .onConflictDoNothing()
          .returning({id: categories.id});
        // Lost a race with a parallel apply: the row is there all the same.
        if (inserted.length === 0) skipped++;
        else added++;
      }
      if (plan.insertCustom.length > 0) {
        await tx.insert(categories).values(
          plan.insertCustom.map((name) => ({
            id: generateId(),
            businessId,
            name,
            isDeleted: false,
          })),
        );
        added += plan.insertCustom.length;
      }
    });

    await this.cache.del(CacheKeys.categories(businessId));
    return {added, skipped, categories: await this.findAll(businessId, locale)};
  }

  /** "Nima sotasiz?" in the owner's own words → categories to start with (AI). */
  suggest(businessId: string, text: string, locale: CatalogLocale): Promise<CategorySuggestion> {
    return this.suggester.suggest(businessId, text, locale);
  }

  /** Names filled in for `locale`, sorted the way people read them. */
  private async present(rows: Category[], locale: CatalogLocale): Promise<CategoryView[]> {
    const needsCatalog = rows.some((r) => r.globalKey);
    const snap = needsCatalog ? await this.catalog.snapshot() : null;
    const collator = new Intl.Collator(locale === 'uzc' ? 'uz-Cyrl' : locale, {sensitivity: 'base'});
    return rows
      .map((r) => viewOf(r, snap, locale))
      .sort((a, b) => collator.compare(a.name, b.name));
  }
}

export interface PresetPlan {
  /** Removed rows to bring back (a global key's own row, or a same-named own category). */
  revive: string[];
  /** Global keys that get a new nameless row. */
  insertGlobal: string[];
  /** Own names that get a new row. */
  insertCustom: string[];
  skipped: number;
}

/**
 * What an "apply" does to a shop's rows (live and removed), decided up front.
 * `globalKeys` must already be visible keys of `snap`, `customNames` trimmed
 * and de-duplicated. A global category is skipped when its row is live or the
 * shop already has a live category answering to any of its names; an own name
 * when any live category already reads the same, in any language.
 */
export function planPreset(
  rows: Pick<Category, 'id' | 'name' | 'globalKey' | 'isDeleted'>[],
  snap: Pick<CatalogSnapshot, 'categories'>,
  globalKeys: string[],
  customNames: string[],
): PresetPlan {
  const plan: PresetPlan = {revive: [], insertGlobal: [], insertCustom: [], skipped: 0};
  // Every name a live category answers to, lowercased.
  const liveNames = new Set<string>();
  for (const r of rows) {
    if (r.isDeleted) continue;
    if (r.name) liveNames.add(r.name.trim().toLowerCase());
    const g = r.globalKey ? snap.categories.get(r.globalKey) : undefined;
    if (g) allNames(g).forEach((n) => liveNames.add(n));
  }

  for (const key of globalKeys) {
    const g = snap.categories.get(key);
    if (!g) continue;
    const row = rows.find((r) => r.globalKey === key);
    if ((row && !row.isDeleted) || allNames(g).some((n) => liveNames.has(n))) {
      plan.skipped++;
      continue;
    }
    if (row) plan.revive.push(row.id);
    else plan.insertGlobal.push(key);
    allNames(g).forEach((n) => liveNames.add(n));
  }

  for (const name of customNames) {
    const lower = name.toLowerCase();
    if (liveNames.has(lower)) {
      plan.skipped++;
      continue;
    }
    const removed = rows.find(
      (r) => r.isDeleted && !r.globalKey && r.name?.trim().toLowerCase() === lower,
    );
    if (removed) plan.revive.push(removed.id);
    else plan.insertCustom.push(name);
    liveNames.add(lower);
  }
  return plan;
}

function viewOf(row: Category, snap: CatalogSnapshot | null, locale: CatalogLocale): CategoryView {
  const g = row.globalKey ? snap?.categories.get(row.globalKey) : undefined;
  if (!g) return {...row, name: row.name ?? row.globalKey ?? row.id};
  return {...row, name: localizedName(g, locale), image: row.image ?? g.image};
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/** Case-insensitive de-duplication, first spelling kept, blanks dropped. */
function uniqueCi(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const lower = v.toLowerCase();
    if (!v || seen.has(lower)) continue;
    seen.add(lower);
    out.push(v);
  }
  return out;
}
