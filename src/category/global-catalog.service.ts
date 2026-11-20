import {Injectable} from '@nestjs/common';
import {asc, eq} from 'drizzle-orm';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {DatabaseService} from '../database/database.service';
import {
  globalCategories,
  storeDirections,
  type GlobalCategory,
  type StoreDirection,
} from '../database/schema';
import {toCatalogWebp} from '../product/global-barcode/global-barcode.service';
import {StorageService} from '../storage/storage.service';
import {generateId} from '../utils/uuid';
import type {CatalogLocale} from './category-locale';

/**
 * How long a container trusts its copy of the global list. Edits from the
 * console clear this container's copy at once; other containers catch up
 * within this window. The list is ~100 rows and changes rarely.
 */
const SNAPSHOT_TTL_MS = 60_000;

/** A global key: lowercase latin, digits, underscores; starts with a letter. */
export const GLOBAL_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

interface Names {
  nameUz: string;
  nameUzc: string;
  nameRu: string;
  nameEn: string;
}

export interface CatalogSnapshot {
  categories: Map<string, GlobalCategory>;
  /** In display order (sort, then key). */
  directions: StoreDirection[];
}

/** One line of trade as the wizard lists it, in the caller's language. */
export interface PresetDirection {
  key: string;
  name: string;
  /** Visible global category keys, in the direction's own order. */
  categoryKeys: string[];
}

export interface PresetCategory {
  key: string;
  name: string;
  image: string | null;
}

export interface CategoryPresets {
  directions: PresetDirection[];
  categories: PresetCategory[];
}

export interface SaveGlobalCategory extends Partial<Names> {
  key?: string;
  isHidden?: boolean;
  sort?: number;
}

export interface SaveStoreDirection extends Partial<Names> {
  key?: string;
  categoryKeys?: string[];
  isHidden?: boolean;
  sort?: number;
}

/** The name in `locale`, falling back to Uzbek Latin when a column is blank. */
export function localizedName(row: Names, locale: CatalogLocale): string {
  const byLocale = {
    uz: row.nameUz,
    uzc: row.nameUzc,
    ru: row.nameRu,
    en: row.nameEn,
  }[locale];
  return byLocale?.trim() ? byLocale : row.nameUz;
}

/** Every spelling of a global name, lowercased — for "same name" checks. */
export function allNames(row: Names): string[] {
  return [row.nameUz, row.nameUzc, row.nameRu, row.nameEn]
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The shared category list and the lines of trade built from it
 * (AI-SOZLASH.md §3). Read by every shop (names, the wizard's presets) and
 * written only from the platform console.
 */
@Injectable()
export class GlobalCatalogService {
  private snapshotCache: {at: number; value: Promise<CatalogSnapshot>} | null = null;

  constructor(
    private readonly dbService: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  /** The whole list, cached per container (see SNAPSHOT_TTL_MS). */
  snapshot(): Promise<CatalogSnapshot> {
    const now = Date.now();
    if (this.snapshotCache && now - this.snapshotCache.at < SNAPSHOT_TTL_MS) {
      return this.snapshotCache.value;
    }
    const value = this.load();
    this.snapshotCache = {at: now, value};
    // A failed read must not stick for a minute.
    value.catch(() => {
      if (this.snapshotCache?.value === value) this.snapshotCache = null;
    });
    return value;
  }

  private invalidate(): void {
    this.snapshotCache = null;
  }

  private async load(): Promise<CatalogSnapshot> {
    const db = this.dbService.db;
    const [cats, dirs] = await Promise.all([
      db.select().from(globalCategories).orderBy(asc(globalCategories.sort), asc(globalCategories.key)),
      db.select().from(storeDirections).orderBy(asc(storeDirections.sort), asc(storeDirections.key)),
    ]);
    return {categories: new Map(cats.map((c) => [c.key, c])), directions: dirs};
  }

  /** What the wizard and "Tayyor kategoriyalar qo'shish" offer: visible rows only. */
  async presets(locale: CatalogLocale): Promise<CategoryPresets> {
    const snap = await this.snapshot();
    const visible = [...snap.categories.values()].filter((c) => !c.isHidden);
    const visibleKeys = new Set(visible.map((c) => c.key));
    return {
      directions: snap.directions
        .filter((d) => !d.isHidden)
        .map((d) => ({
          key: d.key,
          name: localizedName(d, locale),
          categoryKeys: d.categoryKeys.filter((k) => visibleKeys.has(k)),
        }))
        .filter((d) => d.categoryKeys.length > 0),
      categories: visible.map((c) => ({
        key: c.key,
        name: localizedName(c, locale),
        image: c.image,
      })),
    };
  }

  // ── Platform console ─────────────────────────────────────────────────────

  async listForPlatform(): Promise<{categories: GlobalCategory[]; directions: StoreDirection[]}> {
    const snap = await this.load();
    return {categories: [...snap.categories.values()], directions: snap.directions};
  }

  async createCategory(dto: SaveGlobalCategory): Promise<GlobalCategory> {
    const key = this.requireKey(dto.key);
    const names = this.requireNames(dto);
    const [row] = await this.dbService.db
      .insert(globalCategories)
      .values({key, ...names, isHidden: dto.isHidden ?? false, sort: dto.sort ?? 0})
      .onConflictDoNothing()
      .returning();
    if (!row) throw new AppException(ErrorCode.GLOBAL_CATALOG_KEY_TAKEN);
    this.invalidate();
    return row;
  }

  async updateCategory(key: string, dto: SaveGlobalCategory): Promise<GlobalCategory> {
    const [row] = await this.dbService.db
      .update(globalCategories)
      .set({...this.namePatch(dto), ...this.flagPatch(dto), updatedAt: new Date()})
      .where(eq(globalCategories.key, key))
      .returning();
    if (!row) throw new AppException(ErrorCode.CATEGORY_NOT_FOUND);
    this.invalidate();
    return row;
  }

  async setCategoryImage(
    key: string,
    file: {buffer: Buffer; mimetype: string},
  ): Promise<GlobalCategory> {
    if (!this.storage.isEnabled()) {
      throw new AppException(ErrorCode.STORAGE_NOT_CONFIGURED);
    }
    const snap = await this.load();
    if (!snap.categories.has(key)) throw new AppException(ErrorCode.CATEGORY_NOT_FOUND);
    const webp = await toCatalogWebp(file);
    const {url, key: objectKey} = await this.storage.upload(webp, {
      key: `global-categories/${key}/${generateId()}.webp`,
      contentType: 'image/webp',
    });
    await this.storage.uploadThumb(objectKey, webp);
    return this.updateImage(key, url);
  }

  async removeCategoryImage(key: string): Promise<GlobalCategory> {
    return this.updateImage(key, null);
  }

  private async updateImage(key: string, image: string | null): Promise<GlobalCategory> {
    const [row] = await this.dbService.db
      .update(globalCategories)
      .set({image, updatedAt: new Date()})
      .where(eq(globalCategories.key, key))
      .returning();
    if (!row) throw new AppException(ErrorCode.CATEGORY_NOT_FOUND);
    this.invalidate();
    return row;
  }

  async createDirection(dto: SaveStoreDirection): Promise<StoreDirection> {
    const key = this.requireKey(dto.key);
    const names = this.requireNames(dto);
    const categoryKeys = await this.checkCategoryKeys(dto.categoryKeys ?? []);
    const [row] = await this.dbService.db
      .insert(storeDirections)
      .values({key, ...names, categoryKeys, isHidden: dto.isHidden ?? false, sort: dto.sort ?? 0})
      .onConflictDoNothing()
      .returning();
    if (!row) throw new AppException(ErrorCode.GLOBAL_CATALOG_KEY_TAKEN);
    this.invalidate();
    return row;
  }

  async updateDirection(key: string, dto: SaveStoreDirection): Promise<StoreDirection> {
    const categoryKeys =
      dto.categoryKeys !== undefined ? await this.checkCategoryKeys(dto.categoryKeys) : undefined;
    const [row] = await this.dbService.db
      .update(storeDirections)
      .set({
        ...this.namePatch(dto),
        ...this.flagPatch(dto),
        ...(categoryKeys !== undefined && {categoryKeys}),
        updatedAt: new Date(),
      })
      .where(eq(storeDirections.key, key))
      .returning();
    if (!row) throw new AppException(ErrorCode.GLOBAL_DIRECTION_NOT_FOUND);
    this.invalidate();
    return row;
  }

  private requireKey(raw: string | undefined): string {
    const key = raw?.trim() ?? '';
    if (!GLOBAL_KEY_PATTERN.test(key)) {
      throw new AppException(ErrorCode.GLOBAL_CATALOG_KEY_INVALID);
    }
    return key;
  }

  private requireNames(dto: Partial<Names>): Names {
    const names = {
      nameUz: dto.nameUz?.trim() ?? '',
      nameUzc: dto.nameUzc?.trim() ?? '',
      nameRu: dto.nameRu?.trim() ?? '',
      nameEn: dto.nameEn?.trim() ?? '',
    };
    if (!names.nameUz || !names.nameUzc || !names.nameRu || !names.nameEn) {
      throw new AppException(ErrorCode.GLOBAL_CATALOG_NAMES_REQUIRED);
    }
    return names;
  }

  /** Only the names that were sent; a blank one is refused, not stored. */
  private namePatch(dto: Partial<Names>): Partial<Names> {
    const patch: Partial<Names> = {};
    for (const k of ['nameUz', 'nameUzc', 'nameRu', 'nameEn'] as const) {
      if (dto[k] === undefined) continue;
      const v = dto[k]!.trim();
      if (!v) throw new AppException(ErrorCode.GLOBAL_CATALOG_NAMES_REQUIRED);
      patch[k] = v;
    }
    return patch;
  }

  private flagPatch(dto: {isHidden?: boolean; sort?: number}) {
    return {
      ...(dto.isHidden !== undefined && {isHidden: dto.isHidden}),
      ...(dto.sort !== undefined && {sort: dto.sort}),
    };
  }

  /** Known keys only, each once, in the order given. */
  private async checkCategoryKeys(keys: string[]): Promise<string[]> {
    const snap = await this.load();
    const out: string[] = [];
    for (const k of keys) {
      if (!snap.categories.has(k)) {
        throw new AppException(ErrorCode.CATEGORY_NOT_FOUND, {key: k});
      }
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }
}
