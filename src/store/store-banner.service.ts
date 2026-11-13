import {Injectable} from '@nestjs/common';
import {and, asc, eq, inArray} from 'drizzle-orm';
import {businessDay} from '../common/business-time';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {DatabaseService} from '../database/database.service';
import {
  categories,
  products,
  storeBanners,
  type StoreBanner,
} from '../database/schema';
import {StorageService} from '../storage/storage.service';
import {generateId} from '../utils/uuid';
import {BannerLinkType, SaveStoreBannerDto} from './dto/store-banner.dto';

// sharp is CommonJS at runtime; see ai/image/packshot-image.ts for why require().
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const sharp: typeof import('sharp').default = require('sharp');

/** Most banners one storefront may hold (shown or not). */
export const STORE_BANNER_LIMIT = 6;
/** The stored banner picture: 2:1, cropped to fit, WebP. */
const BANNER_WIDTH = 1600;
const BANNER_HEIGHT = 800;
const BANNER_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

/** Where a banner stands today, for the settings list. */
export type BannerStatus = 'live' | 'scheduled' | 'expired' | 'off';

export interface StoreBannerView {
  id: string;
  image: string;
  title: string | null;
  subtitle: string | null;
  buttonLabel: string | null;
  linkType: BannerLinkType;
  linkValue: string | null;
  /** The linked product's / category's name, for the settings list. */
  linkLabel: string | null;
  isActive: boolean;
  startsOn: string | null;
  endsOn: string | null;
  status: BannerStatus;
}

/** What the storefront gets: only what it draws. */
export interface PublicStoreBanner {
  id: string;
  image: string;
  title: string | null;
  subtitle: string | null;
  buttonLabel: string | null;
  link: {type: BannerLinkType; value: string | null};
}

/**
 * Storefront banners: the carousel at the top of a shop's online store.
 *
 * The owner uploads a picture (cropped to 2:1 and stored as WebP), may lay a
 * title, a subtitle and a button label over it, picks where a tap leads and,
 * optionally, the days it runs. The storefront reads only the banners that
 * are switched on and inside their dates, in the owner's order; a banner whose
 * product or category has since gone still shows, it just leads nowhere.
 */
@Injectable()
export class StoreBannerService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // ── Storefront ───────────────────────────────────────────────────────────

  async listPublic(businessId: string | null): Promise<PublicStoreBanner[]> {
    if (!businessId) return [];
    const today = businessDay();
    const rows = (await this.rows(businessId)).filter(
      (b) => statusOf(b, today) === 'live',
    );
    const alive = await this.liveTargets(businessId, rows);
    return rows.map((b) => {
      const type = b.linkType as BannerLinkType;
      const dangling =
        (type === 'product' || type === 'category') &&
        !alive.has(`${type}:${b.linkValue}`);
      return {
        id: b.id,
        image: b.image,
        title: b.title,
        subtitle: b.subtitle,
        buttonLabel: b.buttonLabel,
        link: dangling
          ? {type: 'none' as const, value: null}
          : {type, value: b.linkValue},
      };
    });
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  async list(businessId: string): Promise<{
    limit: number;
    banners: StoreBannerView[];
  }> {
    const rows = await this.rows(businessId);
    const labels = await this.targetLabels(businessId, rows);
    const today = businessDay();
    return {
      limit: STORE_BANNER_LIMIT,
      banners: rows.map((b) => toView(b, today, labels)),
    };
  }

  /** Crops the upload to 2:1 and stores it; the URL then goes into save. */
  async uploadImage(
    businessId: string,
    file: {buffer: Buffer; mimetype: string},
  ): Promise<{url: string}> {
    if (!this.storage.isEnabled()) {
      throw new AppException(ErrorCode.STORAGE_NOT_CONFIGURED);
    }
    const invalid = () =>
      new AppException(ErrorCode.INVALID_FILE_TYPE, {
        allowed: 'JPEG, PNG, WebP',
      });
    if (!BANNER_MIMES.includes(file.mimetype)) throw invalid();
    let webp: Buffer;
    try {
      webp = await sharp(file.buffer, {failOn: 'none'})
        .rotate()
        .flatten({background: '#ffffff'})
        .resize(BANNER_WIDTH, BANNER_HEIGHT, {
          fit: 'cover',
          position: 'attention',
          withoutEnlargement: false,
        })
        .webp({quality: 80, effort: 6, smartSubsample: true})
        .toBuffer();
    } catch {
      throw invalid();
    }
    const {url} = await this.storage.upload(webp, {
      key: `${bannerPrefix(businessId)}${generateId()}.webp`,
      contentType: 'image/webp',
    });
    return {url};
  }

  async create(
    businessId: string,
    dto: SaveStoreBannerDto,
  ): Promise<StoreBannerView> {
    const existing = await this.rows(businessId);
    if (existing.length >= STORE_BANNER_LIMIT) {
      throw new AppException(ErrorCode.STORE_BANNER_LIMIT_REACHED, {
        limit: STORE_BANNER_LIMIT,
      });
    }
    if (!dto.image) throw new AppException(ErrorCode.VALIDATION_ERROR);
    const link = await this.checkedLink(
      businessId,
      dto.linkType ?? 'none',
      dto.linkValue ?? null,
    );
    assertDates(dto.startsOn ?? null, dto.endsOn ?? null);
    const now = new Date();
    const [row] = await this.db
      .insert(storeBanners)
      .values({
        id: generateId(),
        businessId,
        image: this.ownImage(businessId, dto.image),
        title: clean(dto.title),
        subtitle: clean(dto.subtitle),
        buttonLabel: clean(dto.buttonLabel),
        linkType: link.type,
        linkValue: link.value,
        sortOrder:
          existing.reduce((max, b) => Math.max(max, b.sortOrder), -1) + 1,
        isActive: dto.isActive ?? true,
        startsOn: dto.startsOn ?? null,
        endsOn: dto.endsOn ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.view(businessId, row);
  }

  async update(
    businessId: string,
    id: string,
    dto: SaveStoreBannerDto,
  ): Promise<StoreBannerView> {
    const current = await this.one(businessId, id);
    const set: Partial<typeof storeBanners.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (dto.image !== undefined) {
      set.image = this.ownImage(businessId, dto.image);
    }
    if (dto.title !== undefined) set.title = clean(dto.title);
    if (dto.subtitle !== undefined) set.subtitle = clean(dto.subtitle);
    if (dto.buttonLabel !== undefined) set.buttonLabel = clean(dto.buttonLabel);
    if (dto.isActive !== undefined) set.isActive = dto.isActive;
    if (dto.linkType !== undefined || dto.linkValue !== undefined) {
      const link = await this.checkedLink(
        businessId,
        dto.linkType ?? (current.linkType as BannerLinkType),
        dto.linkValue !== undefined ? dto.linkValue : current.linkValue,
      );
      set.linkType = link.type;
      set.linkValue = link.value;
    }
    if (dto.startsOn !== undefined) set.startsOn = dto.startsOn;
    if (dto.endsOn !== undefined) set.endsOn = dto.endsOn;
    assertDates(
      set.startsOn !== undefined ? set.startsOn : current.startsOn,
      set.endsOn !== undefined ? set.endsOn : current.endsOn,
    );
    const [row] = await this.db
      .update(storeBanners)
      .set(set)
      .where(
        and(eq(storeBanners.id, id), eq(storeBanners.businessId, businessId)),
      )
      .returning();
    return this.view(businessId, row);
  }

  /** The picture stays in S3: a cached storefront page may still point at it. */
  async remove(businessId: string, id: string): Promise<{ok: true}> {
    await this.one(businessId, id);
    await this.db
      .delete(storeBanners)
      .where(
        and(eq(storeBanners.id, id), eq(storeBanners.businessId, businessId)),
      );
    return {ok: true};
  }

  /** `ids` = every banner of the shop, in the order they should show. */
  async reorder(businessId: string, ids: string[]) {
    const rows = await this.rows(businessId);
    const known = new Set(rows.map((b) => b.id));
    const unique = [...new Set(ids)];
    if (unique.length !== rows.length || unique.some((id) => !known.has(id))) {
      throw new AppException(ErrorCode.VALIDATION_ERROR);
    }
    await this.db.transaction(async (tx) => {
      for (const [index, id] of unique.entries()) {
        await tx
          .update(storeBanners)
          .set({sortOrder: index, updatedAt: new Date()})
          .where(
            and(
              eq(storeBanners.id, id),
              eq(storeBanners.businessId, businessId),
            ),
          );
      }
    });
    return this.list(businessId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private rows(businessId: string): Promise<StoreBanner[]> {
    return this.db
      .select()
      .from(storeBanners)
      .where(eq(storeBanners.businessId, businessId))
      .orderBy(asc(storeBanners.sortOrder), asc(storeBanners.createdAt));
  }

  private async one(businessId: string, id: string): Promise<StoreBanner> {
    const [row] = await this.db
      .select()
      .from(storeBanners)
      .where(
        and(eq(storeBanners.id, id), eq(storeBanners.businessId, businessId)),
      )
      .limit(1);
    if (!row) throw new AppException(ErrorCode.STORE_BANNER_NOT_FOUND);
    return row;
  }

  private async view(
    businessId: string,
    row: StoreBanner,
  ): Promise<StoreBannerView> {
    const labels = await this.targetLabels(businessId, [row]);
    return toView(row, businessDay(), labels);
  }

  /**
   * Only a picture this shop uploaded through uploadImage: the storefront
   * must never be made to load an address a client chose.
   */
  private ownImage(businessId: string, url: string): string {
    const key = this.storage.keyFromUrl(url);
    if (!key || !key.startsWith(bannerPrefix(businessId))) {
      throw new AppException(ErrorCode.VALIDATION_ERROR);
    }
    return url;
  }

  private async checkedLink(
    businessId: string,
    type: BannerLinkType,
    rawValue: string | null,
  ): Promise<{type: BannerLinkType; value: string | null}> {
    const value = rawValue?.trim() || null;
    if (type === 'none') return {type, value: null};
    const invalid = () => new AppException(ErrorCode.STORE_BANNER_INVALID_LINK);
    if (!value) throw invalid();
    if (type === 'url') {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw invalid();
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw invalid();
      }
      return {type, value: parsed.toString()};
    }
    const labels = await this.targetLabels(businessId, [
      {linkType: type, linkValue: value},
    ]);
    if (!labels.has(`${type}:${value}`)) throw invalid();
    return {type, value};
  }

  /** `type:id` → name, for the products and categories these banners name. */
  private async targetLabels(
    businessId: string,
    rows: Pick<StoreBanner, 'linkType' | 'linkValue'>[],
  ): Promise<Map<string, string>> {
    const ids = (type: string) => [
      ...new Set(
        rows
          .filter((b) => b.linkType === type && b.linkValue)
          .map((b) => b.linkValue as string),
      ),
    ];
    const productIds = ids('product');
    const categoryIds = ids('category');
    const out = new Map<string, string>();
    if (productIds.length > 0) {
      const found = await this.db
        .select({id: products.id, name: products.name})
        .from(products)
        .where(
          and(
            eq(products.businessId, businessId),
            inArray(products.id, productIds),
            eq(products.isActive, true),
          ),
        );
      for (const p of found) out.set(`product:${p.id}`, p.name);
    }
    if (categoryIds.length > 0) {
      const found = await this.db
        .select({id: categories.id, name: categories.name})
        .from(categories)
        .where(
          and(
            eq(categories.businessId, businessId),
            inArray(categories.id, categoryIds),
            eq(categories.isDeleted, false),
          ),
        );
      for (const c of found) out.set(`category:${c.id}`, c.name);
    }
    return out;
  }

  private async liveTargets(
    businessId: string,
    rows: StoreBanner[],
  ): Promise<Set<string>> {
    return new Set((await this.targetLabels(businessId, rows)).keys());
  }
}

function bannerPrefix(businessId: string): string {
  return `banners/${businessId}/`;
}

function clean(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function assertDates(startsOn: string | null, endsOn: string | null): void {
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new AppException(ErrorCode.VALIDATION_ERROR);
  }
}

/** Dates are business-zone days, both inclusive; YYYY-MM-DD compares as text. */
export function statusOf(
  banner: Pick<StoreBanner, 'isActive' | 'startsOn' | 'endsOn'>,
  today: string,
): BannerStatus {
  if (!banner.isActive) return 'off';
  if (banner.endsOn && banner.endsOn < today) return 'expired';
  if (banner.startsOn && banner.startsOn > today) return 'scheduled';
  return 'live';
}

function toView(
  b: StoreBanner,
  today: string,
  labels: Map<string, string>,
): StoreBannerView {
  return {
    id: b.id,
    image: b.image,
    title: b.title,
    subtitle: b.subtitle,
    buttonLabel: b.buttonLabel,
    linkType: b.linkType as BannerLinkType,
    linkValue: b.linkValue,
    linkLabel: labels.get(`${b.linkType}:${b.linkValue}`) ?? null,
    isActive: b.isActive,
    startsOn: b.startsOn,
    endsOn: b.endsOn,
    status: statusOf(b, today),
  };
}
