import {Inject, Injectable} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {and, asc, eq} from 'drizzle-orm';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {DatabaseService} from '../database/database.service';
import {products, scaleSettings, type ScaleSettings} from '../database/schema';
import {CacheKeys, TTL} from '../cache/cache.util';
import {
  DEFAULT_SCALE_FORMAT,
  scaleFormatLength,
  type ScaleBarcodeFormat,
} from '../common/weight-barcode';
import {
  PLU_EXPORT_FILES,
  buildPluExport,
  pluBarcodeCoding,
  type PluExportFormat,
} from './plu-export';
import {UpdateScaleSettingsDto} from './dto/update-scale-settings.dto';

// Before a business has ever saved: no scales, no layouts. Turning the feature
// on without describing a layout falls back to DEFAULT_SCALE_FORMAT (see
// `activeFormats`), which is what these scales print out of the box here.
const DEFAULTS = {
  enabled: false,
  formats: [] as ScaleBarcodeFormat[],
  // PLU numbering window: from 1 up to whatever the barcode layout can carry.
  pluStart: 1,
  pluEnd: null as number | null,
};

@Injectable()
export class ScaleService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Scale settings for a business, falling back to defaults if unset. */
  async getSettings(businessId: string): Promise<ScaleSettings> {
    return this.cache.wrap(
      CacheKeys.scaleSettings(businessId),
      async () => {
        const [row] = await this.dbService.db
          .select()
          .from(scaleSettings)
          .where(eq(scaleSettings.businessId, businessId))
          .limit(1);

        if (row) return row;
        return {businessId, ...DEFAULTS, updatedAt: new Date()};
      },
      TTL.SCALE_SETTINGS,
    );
  }

  /** Upsert: create the row on first save, update it thereafter. */
  async updateSettings(
    businessId: string,
    dto: UpdateScaleSettingsDto,
  ): Promise<ScaleSettings> {
    const current = await this.getSettings(businessId);
    // null is a real value for pluEnd ("no window end, use the layout cap"), so
    // these merge on `undefined`, not on falsiness.
    const pluStart = dto.pluStart ?? current.pluStart;
    const pluEnd = dto.pluEnd !== undefined ? dto.pluEnd : current.pluEnd;
    if (pluEnd !== null && pluEnd < pluStart) {
      throw new AppException(ErrorCode.PLU_RANGE_INVALID);
    }

    const next = {
      enabled: dto.enabled ?? current.enabled,
      formats:
        dto.formats !== undefined
          ? this.normalizeFormats(dto.formats)
          : current.formats,
      pluStart,
      pluEnd,
    };

    await this.dbService.db
      .insert(scaleSettings)
      .values({businessId, ...next, updatedAt: new Date()})
      .onConflictDoUpdate({
        target: scaleSettings.businessId,
        set: {...next, updatedAt: new Date()},
      });

    await this.cache.del(CacheKeys.scaleSettings(businessId));

    return this.getSettings(businessId);
  }

  /**
   * The layouts the till should actually try, or an empty list when the
   * business has no scales. Callers can treat "empty" as "never parse a scan as
   * a label", which keeps the scan path unchanged for shops without scales.
   */
  async activeFormats(businessId: string): Promise<ScaleBarcodeFormat[]> {
    const settings = await this.getSettings(businessId);
    if (!settings.enabled) return [];
    return settings.formats.length > 0
      ? settings.formats
      : [DEFAULT_SCALE_FORMAT];
  }

  /**
   * Largest PLU the shop can assign. A PLU has to fit in EVERY layout its
   * scales print, so the narrowest PLU field is what caps it — assigning 12345
   * while one scale prints 4-digit PLUs would produce labels that resolve to
   * the wrong product (or to nothing).
   *
   * With no scales configured this still answers for the default layout, so the
   * product form can offer a PLU before the settings page is ever visited.
   */
  async maxPlu(businessId: string): Promise<number> {
    const settings = await this.getSettings(businessId);
    const formats =
      settings.formats.length > 0 ? settings.formats : [DEFAULT_SCALE_FORMAT];
    const digits = Math.min(...formats.map((f) => f.pluDigits));
    return Math.pow(10, digits) - 1;
  }

  /**
   * The window PLU numbers are actually handed out from: the shop's configured
   * range, clamped to what the barcode layouts can carry. The hardware cap
   * always wins — a window ending at 99999 is meaningless on scales that print
   * 4-digit PLUs, and the label would resolve to the wrong product.
   */
  async pluRange(businessId: string): Promise<{min: number; max: number}> {
    const [settings, cap] = await Promise.all([
      this.getSettings(businessId),
      this.maxPlu(businessId),
    ]);
    const max = Math.min(settings.pluEnd ?? cap, cap);
    // A window that starts above the cap would leave nothing to hand out; pin
    // the floor to 1 in that case so the pool degrades to "the whole range".
    const min = Math.min(Math.max(settings.pluStart, 1), max);
    return {min, max};
  }

  /**
   * Build the PLU catalogue file the shop loads into the scale vendor's
   * Windows software (see plu-export.ts for the format).
   *
   * Only weighed products with a PLU can go: a scale sells by the kilogram, and
   * without a PLU there is no number for the operator to press. Piece goods and
   * un-numbered rows are counted rather than silently dropped, so the settings
   * page can say "42 of 57 exported" instead of leaving the shop to discover
   * the gap at the counter.
   *
   * The first active layout wins. A shop running a weight format and a price
   * format side by side is describing two scales, and the file carries one
   * `Barcode Type` — exporting the second layout is a separate download, not a
   * silent merge.
   */
  async buildPluExport(
    businessId: string,
    format: PluExportFormat = 'xls',
  ): Promise<{
    file: Buffer;
    filename: string;
    contentType: string;
    exported: number;
    skippedNoPlu: number;
  }> {
    const formats = await this.activeFormats(businessId);
    const coding = formats.length ? pluBarcodeCoding(formats[0]) : null;
    if (!coding) {
      throw new AppException(ErrorCode.PLU_EXPORT_FORMAT_UNSUPPORTED);
    }

    // Weighed goods only. `quantityType` is derived from the unit on every
    // write, so it stays the cheap way to ask "is this sold by weight?".
    const rows = await this.dbService.db
      .select({
        plu: products.plu,
        name: products.name,
        priceOut: products.priceOut,
      })
      .from(products)
      .where(
        and(
          eq(products.businessId, businessId),
          eq(products.isActive, true),
          eq(products.quantityType, 'kg'),
        ),
      )
      .orderBy(asc(products.plu));

    const withPlu = rows.filter((r) => r.plu !== null);
    if (withPlu.length === 0) {
      throw new AppException(ErrorCode.PLU_EXPORT_EMPTY);
    }

    const file = buildPluExport(
      withPlu.map((r) => ({
        plu: r.plu as number,
        name: r.name,
        price: Number(r.priceOut),
      })),
      coding,
      format,
    );

    return {
      file,
      ...PLU_EXPORT_FILES[format],
      exported: withPlu.length,
      skippedNoPlu: rows.length - withPlu.length,
    };
  }

  /**
   * Keep the list unambiguous. Two layouts of the same width and prefix cannot
   * be told apart — the parser would silently always pick the first — so later
   * duplicates are dropped rather than saved as dead configuration.
   */
  private normalizeFormats(
    formats: ScaleBarcodeFormat[],
  ): ScaleBarcodeFormat[] {
    const seen = new Set<string>();
    const out: ScaleBarcodeFormat[] = [];
    for (const format of formats) {
      const key = `${format.prefix}:${scaleFormatLength(format)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        prefix: format.prefix,
        pluDigits: format.pluDigits,
        valueDigits: format.valueDigits,
        mode: format.mode,
        divisor: format.divisor,
        checkDigit: format.checkDigit,
      });
    }
    return out;
  }
}
