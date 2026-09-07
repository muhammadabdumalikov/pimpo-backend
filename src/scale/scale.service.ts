import {Inject, Injectable} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {scaleSettings, type ScaleSettings} from '../database/schema';
import {CacheKeys, TTL} from '../cache/cache.util';
import {
  DEFAULT_SCALE_FORMAT,
  scaleFormatLength,
  type ScaleBarcodeFormat,
} from '../common/weight-barcode';
import {UpdateScaleSettingsDto} from './dto/update-scale-settings.dto';

// Before a business has ever saved: no scales, no layouts. Turning the feature
// on without describing a layout falls back to DEFAULT_SCALE_FORMAT (see
// `activeFormats`), which is what these scales print out of the box here.
const DEFAULTS = {
  enabled: false,
  formats: [] as ScaleBarcodeFormat[],
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
    const next = {
      enabled: dto.enabled ?? current.enabled,
      formats:
        dto.formats !== undefined
          ? this.normalizeFormats(dto.formats)
          : current.formats,
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
