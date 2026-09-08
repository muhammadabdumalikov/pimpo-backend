import {Inject, Injectable} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {eq} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  receiptSettings,
  labelSettings,
  type ReceiptSettings,
  type LabelSettings,
} from '../database/schema';
import {UpdateReceiptSettingsDto} from './dto/update-receipt-settings.dto';
import {UpdateLabelSettingsDto} from './dto/update-label-settings.dto';
import {CacheKeys, TTL} from '../cache/cache.util';

const DEFAULTS = {
  receiptName: 'Standart',
  showLogo: true,
  logoUrl: null as string | null,
  vatEnabled: false,
  vatRate: '12',
  costingMethod: 'AVERAGE',
  priceIncreaseMode: 'KEEP_OLD',
  // No house markup until someone sets one — selling prices stay hand-typed.
  defaultMarkupPercent: null as string | null,
};

// A shop that never opened the label page still prints: 58x40 mm stock with
// the name, the price and the barcode, which is what a shelf label is.
const LABEL_DEFAULTS = {
  widthMm: 58,
  heightMm: 40,
  paddingMm: 2,
  showStoreName: false,
  showName: true,
  nameLines: 2,
  showPrice: true,
  showCode: false,
  showBarcodeText: true,
  barcodeHeightMm: 12,
  fontScale: 100,
  copies: 1,
};

@Injectable()
export class SettingsService {
  constructor(
    private readonly dbService: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Receipt settings for a business, falling back to defaults if unset. */
  async getReceiptSettings(businessId: string): Promise<ReceiptSettings> {
    return this.cache.wrap(
      CacheKeys.settingsReceipt(businessId),
      async () => {
        const [row] = await this.dbService.db
          .select()
          .from(receiptSettings)
          .where(eq(receiptSettings.businessId, businessId))
          .limit(1);

        if (row) return row;
        return {
          businessId,
          receiptName: DEFAULTS.receiptName,
          showLogo: DEFAULTS.showLogo,
          logoUrl: DEFAULTS.logoUrl,
          vatEnabled: DEFAULTS.vatEnabled,
          vatRate: DEFAULTS.vatRate,
          costingMethod: DEFAULTS.costingMethod,
          priceIncreaseMode: DEFAULTS.priceIncreaseMode,
          defaultMarkupPercent: DEFAULTS.defaultMarkupPercent,
          updatedAt: new Date(),
        };
      },
      TTL.SETTINGS,
    );
  }

  /** Upsert: create the row on first save, update it thereafter. */
  async updateReceiptSettings(
    businessId: string,
    dto: UpdateReceiptSettingsDto,
  ): Promise<ReceiptSettings> {
    const current = await this.getReceiptSettings(businessId);
    const next = {
      receiptName: dto.receiptName ?? current.receiptName,
      showLogo: dto.showLogo ?? current.showLogo,
      logoUrl: dto.logoUrl === undefined ? current.logoUrl : dto.logoUrl,
      vatEnabled: dto.vatEnabled ?? current.vatEnabled,
      vatRate:
        dto.vatRate !== undefined ? String(dto.vatRate) : current.vatRate,
      costingMethod: dto.costingMethod ?? current.costingMethod,
      priceIncreaseMode: dto.priceIncreaseMode ?? current.priceIncreaseMode,
      // null is a meaningful value here (clears the rule), so only `undefined`
      // means "leave it alone".
      defaultMarkupPercent:
        dto.defaultMarkupPercent === undefined
          ? current.defaultMarkupPercent
          : dto.defaultMarkupPercent === null
            ? null
            : String(dto.defaultMarkupPercent),
    };

    await this.dbService.db
      .insert(receiptSettings)
      .values({businessId, ...next, updatedAt: new Date()})
      .onConflictDoUpdate({
        target: receiptSettings.businessId,
        set: {...next, updatedAt: new Date()},
      });

    await this.cache.del(CacheKeys.settingsReceipt(businessId));

    return this.getReceiptSettings(businessId);
  }

  /** Label layout for a business, falling back to the defaults if unset. */
  async getLabelSettings(businessId: string): Promise<LabelSettings> {
    return this.cache.wrap(
      CacheKeys.settingsLabel(businessId),
      async () => {
        const [row] = await this.dbService.db
          .select()
          .from(labelSettings)
          .where(eq(labelSettings.businessId, businessId))
          .limit(1);

        if (row) return row;
        return {businessId, ...LABEL_DEFAULTS, updatedAt: new Date()};
      },
      TTL.SETTINGS,
    );
  }

  /** Upsert: create the row on first save, update it thereafter. */
  async updateLabelSettings(
    businessId: string,
    dto: UpdateLabelSettingsDto,
  ): Promise<LabelSettings> {
    const current = await this.getLabelSettings(businessId);
    const next = {
      widthMm: dto.widthMm ?? current.widthMm,
      heightMm: dto.heightMm ?? current.heightMm,
      paddingMm: dto.paddingMm ?? current.paddingMm,
      showStoreName: dto.showStoreName ?? current.showStoreName,
      showName: dto.showName ?? current.showName,
      nameLines: dto.nameLines ?? current.nameLines,
      showPrice: dto.showPrice ?? current.showPrice,
      showCode: dto.showCode ?? current.showCode,
      showBarcodeText: dto.showBarcodeText ?? current.showBarcodeText,
      barcodeHeightMm: dto.barcodeHeightMm ?? current.barcodeHeightMm,
      fontScale: dto.fontScale ?? current.fontScale,
      copies: dto.copies ?? current.copies,
    };

    await this.dbService.db
      .insert(labelSettings)
      .values({businessId, ...next, updatedAt: new Date()})
      .onConflictDoUpdate({
        target: labelSettings.businessId,
        set: {...next, updatedAt: new Date()},
      });

    await this.cache.del(CacheKeys.settingsLabel(businessId));

    return this.getLabelSettings(businessId);
  }
}
