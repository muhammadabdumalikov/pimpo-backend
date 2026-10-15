import {Injectable, Logger} from '@nestjs/common';
import {and, eq, inArray, isNull, or, sql} from 'drizzle-orm';
import {sharp, toPackshotWebp} from '../../ai/image/packshot-image';
import {AppException} from '../../common/errors/app.exception';
import {ErrorCode} from '../../common/errors/error-codes';
import {DatabaseService} from '../../database/database.service';
import {globalBarcodes, products} from '../../database/schema';
import {StorageService} from '../../storage/storage.service';
import {SubscriptionService} from '../../subscription/subscription.service';
import {tierAtLeast} from '../../subscription/tier';
import {generateId} from '../../utils/uuid';

/** Pictures the console may upload; sharp decodes all of them. */
const ACCEPTED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

export interface GlobalBarcodeView {
  barcode: string;
  name: string;
  categoryName: string | null;
  image: string | null;
  source: string;
  timesUsed: number;
  createdAt: Date;
  updatedAt: Date;
  /** The shops' cards behind this barcode, by the picture they show. */
  usage: {
    shops: number;
    products: number;
    /** Showing the shared picture — they follow it when it changes. */
    showingGlobal: number;
    /** A picture of the shop's own — never touched from here. */
    ownImage: number;
    noImage: number;
  };
}

export interface GlobalImageChange extends GlobalBarcodeView {
  /** Shop cards that now show the new picture (or lost the removed one). */
  updatedProducts: number;
}

/**
 * The shared barcode catalogue's picture, curated from the platform console.
 *
 * A barcode's first picture comes from whichever shop saves the product first
 * (ProductService); from then on only the platform changes it. A shop card
 * "follows" the shared picture while it shows that exact URL — the lookup
 * copied it there — so replacing the picture moves every such card along,
 * while a card with a picture of the shop's own is left alone. Cards with no
 * picture get it too, but only in shops whose plan includes product pictures
 * (pro and up), the same gate the product form applies.
 */
@Injectable()
export class GlobalBarcodeService {
  private readonly logger = new Logger(GlobalBarcodeService.name);

  constructor(
    private readonly dbService: DatabaseService,
    private readonly storage: StorageService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async get(rawBarcode: string): Promise<GlobalBarcodeView> {
    const barcode = normalizeBarcode(rawBarcode);
    const [entry] = await this.db
      .select()
      .from(globalBarcodes)
      .where(eq(globalBarcodes.barcode, barcode))
      .limit(1);
    if (!entry) throw notFound(barcode);
    return this.view(entry);
  }

  async setImage(
    rawBarcode: string,
    file: {buffer: Buffer; mimetype: string},
  ): Promise<GlobalImageChange> {
    const barcode = normalizeBarcode(rawBarcode);
    if (!this.storage.isEnabled()) {
      throw new AppException(ErrorCode.STORAGE_NOT_CONFIGURED);
    }
    // Fail on an unknown barcode before anything is uploaded.
    await this.get(barcode);
    const webp = await toCatalogWebp(file);
    const {url} = await this.storage.upload(webp, {
      key: `global-barcodes/${keySegment(barcode)}/${generateId()}.webp`,
      contentType: 'image/webp',
    });
    return this.replace(barcode, url);
  }

  async removeImage(rawBarcode: string): Promise<GlobalImageChange> {
    return this.replace(normalizeBarcode(rawBarcode), null);
  }

  /**
   * Swap the shared picture and move the cards that follow it, in one
   * transaction. Old S3 objects stay: a receipt, an AI ledger row or a shop
   * that re-uploaded the same file may still point at them.
   */
  private async replace(
    barcode: string,
    next: string | null,
  ): Promise<GlobalImageChange> {
    // Shops whose imageless cards may take the picture — decided before the
    // transaction, since the plan lookup runs on its own connection.
    const fillShops = next ? await this.shopsToFill(barcode) : [];

    const {entry, updatedProducts} = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(globalBarcodes)
        .where(eq(globalBarcodes.barcode, barcode))
        .for('update');
      if (!current) throw notFound(barcode);

      const [entry] = await tx
        .update(globalBarcodes)
        .set({image: next, updatedAt: new Date()})
        .where(eq(globalBarcodes.barcode, barcode))
        .returning();

      const follows = current.image
        ? eq(products.image, current.image)
        : undefined;
      const empty =
        fillShops.length > 0
          ? and(
              or(isNull(products.image), eq(products.image, '')),
              inArray(products.businessId, fillShops),
            )
          : undefined;
      const target = follows && empty ? or(follows, empty) : (follows ?? empty);
      if (!target || current.image === next) {
        return {entry, updatedProducts: 0};
      }

      const moved = await tx
        .update(products)
        .set({image: next, updatedAt: new Date()})
        .where(and(eq(products.barcode, barcode), target))
        .returning({id: products.id});
      return {entry, updatedProducts: moved.length};
    });

    this.logger.log(
      `Shared picture for ${barcode} ${next ? 'set' : 'removed'}; ` +
        `${updatedProducts} shop card(s) updated`,
    );
    return {...(await this.view(entry)), updatedProducts};
  }

  /** Shops with an imageless card for this barcode and pictures in their plan. */
  private async shopsToFill(barcode: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({businessId: products.businessId})
      .from(products)
      .where(
        and(
          eq(products.barcode, barcode),
          or(isNull(products.image), eq(products.image, '')),
        ),
      );
    const tiers = await Promise.all(
      rows.map(async ({businessId}) => ({
        businessId,
        tier: await this.subscriptions.getEffectiveTier(businessId),
      })),
    );
    return tiers
      .filter(({tier}) => tierAtLeast(tier, 'pro'))
      .map(({businessId}) => businessId);
  }

  private async view(
    entry: typeof globalBarcodes.$inferSelect,
  ): Promise<GlobalBarcodeView> {
    const showing = entry.image
      ? sql<number>`count(*) filter (where ${products.image} = ${entry.image})::int`
      : sql<number>`0`;
    const [usage] = await this.db
      .select({
        shops: sql<number>`count(distinct ${products.businessId})::int`,
        products: sql<number>`count(*)::int`,
        showingGlobal: showing,
        noImage: sql<number>`count(*) filter (where coalesce(${products.image}, '') = '')::int`,
      })
      .from(products)
      .where(
        and(eq(products.barcode, entry.barcode), eq(products.isActive, true)),
      );
    const total = usage?.products ?? 0;
    const showingGlobal = usage?.showingGlobal ?? 0;
    const noImage = usage?.noImage ?? 0;
    return {
      barcode: entry.barcode,
      name: entry.name,
      categoryName: entry.categoryName,
      image: entry.image,
      source: entry.source,
      timesUsed: entry.timesUsed,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      usage: {
        shops: usage?.shops ?? 0,
        products: total,
        showingGlobal,
        ownImage: Math.max(0, total - showingGlobal - noImage),
        noImage,
      },
    };
  }
}

function normalizeBarcode(raw: string): string {
  const barcode = (raw ?? '').trim();
  if (!barcode || barcode.length > 100) throw notFound(barcode);
  return barcode;
}

function notFound(barcode: string): AppException {
  return new AppException(ErrorCode.GLOBAL_BARCODE_NOT_FOUND, {barcode});
}

/** A barcode as one S3 path segment: anything unusual becomes "_". */
export function keySegment(barcode: string): string {
  return barcode.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * The console's upload in the catalogue's house format: upright (EXIF), white
 * where transparent, a 1024px square — the same as an AI packshot, so a till
 * grid of shared pictures lines up.
 */
async function toCatalogWebp(file: {
  buffer: Buffer;
  mimetype: string;
}): Promise<Buffer> {
  const invalid = () =>
    new AppException(ErrorCode.INVALID_FILE_TYPE, {
      allowed: 'JPEG, PNG, WebP',
    });
  if (!ACCEPTED_MIMES.includes(file.mimetype)) throw invalid();
  try {
    const upright = await sharp(file.buffer, {failOn: 'none'})
      .rotate()
      .toBuffer();
    return await toPackshotWebp(upright);
  } catch {
    throw invalid();
  }
}
