import {Inject, Injectable} from '@nestjs/common';
import {CACHE_MANAGER, Cache} from '@nestjs/cache-manager';
import {and, asc, desc, eq, ne, sql} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  receiptSettings,
  labelSettings,
  labelTemplates,
  type ReceiptSettings,
  type LabelSettings,
  type LabelTemplate,
} from '../database/schema';
import {UpdateReceiptSettingsDto} from './dto/update-receipt-settings.dto';
import {UpdateLabelSettingsDto} from './dto/update-label-settings.dto';
import {CreateLabelTemplateDto} from './dto/create-label-template.dto';
import {UpdateLabelTemplateDto} from './dto/update-label-template.dto';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {generateId} from '../utils/uuid';
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
  showBarcode: true,
  showBarcodeText: true,
  showPlu: false,
  barcodeHeightMm: 8,
  fontScale: 100,
  copies: 1,
};

/**
 * The layout fields alone — what describes the printed sticker, with no row
 * identity attached. Both `label_settings` and `label_templates` rows satisfy
 * it, which is how one layout is copied into the other.
 */
type LabelLayout = typeof LABEL_DEFAULTS;

/** What the carried-over (or first) template is called. */
const DEFAULT_LABEL_TEMPLATE_NAME = 'Standart';

/**
 * Ceiling on templates per business. A shop has as many templates as it has
 * rolls — a handful — so this is only here to keep a scripted client from
 * turning the print picker into a scroll.
 */
const MAX_LABEL_TEMPLATES = 20;

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

  // ── Label templates ────────────────────────────────────────────────────────

  /**
   * Every label template a business has, the default first.
   *
   * Never empty: a business that has never opened the page gets its "Standart"
   * seeded here, from the single layout it used before templates existed or
   * from the house defaults. Callers can therefore treat `[0]` as something
   * printable without a null branch.
   */
  async listLabelTemplates(businessId: string): Promise<LabelTemplate[]> {
    return this.cache.wrap(
      CacheKeys.settingsLabelTemplates(businessId),
      async () => {
        const rows = await this.readLabelTemplates(businessId);
        if (rows.length > 0) return rows;
        await this.seedLabelTemplate(businessId);
        return this.readLabelTemplates(businessId);
      },
      TTL.SETTINGS,
    );
  }

  private async readLabelTemplates(
    businessId: string,
  ): Promise<LabelTemplate[]> {
    return this.dbService.db
      .select()
      .from(labelTemplates)
      .where(eq(labelTemplates.businessId, businessId))
      .orderBy(
        // The default heads both the settings list and the print picker: it is
        // the answer to "which label?" for anyone who does not want to choose.
        desc(labelTemplates.isDefault),
        asc(labelTemplates.sortOrder),
        asc(labelTemplates.createdAt),
      );
  }

  /**
   * First template for a business, carrying over whatever it had configured
   * before templates existed. `onConflictDoNothing` covers the race of two
   * first requests arriving together — the partial unique index on
   * (business_id) where is_default is what makes the loser fail rather than
   * leave the shop with two defaults.
   */
  private async seedLabelTemplate(businessId: string): Promise<void> {
    const [legacy] = await this.dbService.db
      .select()
      .from(labelSettings)
      .where(eq(labelSettings.businessId, businessId))
      .limit(1);

    const layout = legacy ? this.pickLabelLayout(legacy) : {...LABEL_DEFAULTS};

    await this.dbService.db
      .insert(labelTemplates)
      .values({
        id: generateId(),
        businessId,
        name: DEFAULT_LABEL_TEMPLATE_NAME,
        isDefault: true,
        sortOrder: 0,
        ...layout,
      })
      .onConflictDoNothing();
  }

  /** Just the layout fields of a row — everything that describes the sticker. */
  private pickLabelLayout(row: LabelLayout | LabelSettings): LabelLayout {
    return {
      widthMm: row.widthMm,
      heightMm: row.heightMm,
      paddingMm: row.paddingMm,
      showStoreName: row.showStoreName,
      showName: row.showName,
      nameLines: row.nameLines,
      showPrice: row.showPrice,
      showCode: row.showCode,
      showBarcode: row.showBarcode,
      showBarcodeText: row.showBarcodeText,
      // `label_settings` predates the PLU line, so a layout carried over from
      // there starts with it off rather than failing to copy.
      showPlu: 'showPlu' in row ? row.showPlu : LABEL_DEFAULTS.showPlu,
      barcodeHeightMm: row.barcodeHeightMm,
      fontScale: row.fontScale,
      copies: row.copies,
    };
  }

  private async getLabelTemplateOrThrow(
    businessId: string,
    id: string,
  ): Promise<LabelTemplate> {
    const [row] = await this.dbService.db
      .select()
      .from(labelTemplates)
      .where(
        and(
          eq(labelTemplates.id, id),
          eq(labelTemplates.businessId, businessId),
        ),
      )
      .limit(1);
    if (!row) throw new AppException(ErrorCode.LABEL_TEMPLATE_NOT_FOUND);
    return row;
  }

  /**
   * Two templates in one shop may not share a name — the print picker shows
   * nothing but the name and the size, so a duplicate makes the choice a guess.
   * Compared case-insensitively, the same way the unique index does it;
   * `exceptId` lets a rename keep its own name.
   */
  private async assertLabelNameFree(
    businessId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = and(
      eq(labelTemplates.businessId, businessId),
      sql`lower(${labelTemplates.name}) = lower(${name})`,
      exceptId ? ne(labelTemplates.id, exceptId) : undefined,
    );
    const [row] = await this.dbService.db
      .select({id: labelTemplates.id})
      .from(labelTemplates)
      .where(clash)
      .limit(1);
    if (row) throw new AppException(ErrorCode.LABEL_TEMPLATE_NAME_EXISTS);
  }

  async createLabelTemplate(
    businessId: string,
    dto: CreateLabelTemplateDto,
  ): Promise<LabelTemplate> {
    // Seeds "Standart" if this business has none, so a brand-new template is
    // never the one that has to become the default by accident.
    const existing = await this.listLabelTemplates(businessId);
    if (existing.length >= MAX_LABEL_TEMPLATES) {
      throw new AppException(ErrorCode.LABEL_TEMPLATE_LIMIT, {
        max: MAX_LABEL_TEMPLATES,
      });
    }
    await this.assertLabelNameFree(businessId, dto.name);

    const id = generateId();
    const makeDefault = dto.isDefault === true || existing.length === 0;

    // One transaction, because the two halves of moving the default are only
    // correct together: a cleared flag with no insert behind it would leave the
    // shop with nothing marked as the label it prints.
    await this.dbService.db.transaction(async (tx) => {
      if (makeDefault) {
        await tx
          .update(labelTemplates)
          .set({isDefault: false})
          .where(
            and(
              eq(labelTemplates.businessId, businessId),
              eq(labelTemplates.isDefault, true),
            ),
          );
      }
      await tx.insert(labelTemplates).values({
        id,
        businessId,
        name: dto.name,
        isDefault: makeDefault,
        sortOrder: dto.sortOrder ?? existing.length,
        ...this.applyLabelLayout(LABEL_DEFAULTS, dto),
      });
    });

    await this.cache.del(CacheKeys.settingsLabelTemplates(businessId));
    return this.getLabelTemplateOrThrow(businessId, id);
  }

  async updateLabelTemplate(
    businessId: string,
    id: string,
    dto: UpdateLabelTemplateDto,
  ): Promise<LabelTemplate> {
    const current = await this.getLabelTemplateOrThrow(businessId, id);
    if (dto.name !== undefined) {
      await this.assertLabelNameFree(businessId, dto.name, id);
    }

    // Promotion only. Clearing the flag instead would leave the shop with no
    // default at all; the way to move it is to promote another template.
    const promote = dto.isDefault === true && !current.isDefault;

    await this.dbService.db.transaction(async (tx) => {
      if (promote) {
        await tx
          .update(labelTemplates)
          .set({isDefault: false})
          .where(
            and(
              eq(labelTemplates.businessId, businessId),
              eq(labelTemplates.isDefault, true),
            ),
          );
      }
      await tx
        .update(labelTemplates)
        .set({
          name: dto.name ?? current.name,
          isDefault: promote ? true : current.isDefault,
          sortOrder: dto.sortOrder ?? current.sortOrder,
          ...this.applyLabelLayout(current, dto),
          updatedAt: new Date(),
        })
        .where(eq(labelTemplates.id, id));
    });

    await this.cache.del(CacheKeys.settingsLabelTemplates(businessId));
    return this.getLabelTemplateOrThrow(businessId, id);
  }

  /**
   * Removes a template. The last one stays: a shop with no template has no way
   * to print, and the settings page would have nothing to show. Deleting the
   * default hands the flag to whatever comes first afterwards, rather than
   * leaving the picker with no answer.
   */
  async deleteLabelTemplate(businessId: string, id: string): Promise<void> {
    const template = await this.getLabelTemplateOrThrow(businessId, id);
    const all = await this.readLabelTemplates(businessId);
    if (all.length <= 1) throw new AppException(ErrorCode.LABEL_TEMPLATE_LAST);

    const successor = template.isDefault
      ? all.find((t) => t.id !== id)
      : undefined;

    await this.dbService.db.transaction(async (tx) => {
      await tx.delete(labelTemplates).where(eq(labelTemplates.id, id));
      if (successor) {
        await tx
          .update(labelTemplates)
          .set({isDefault: true, updatedAt: new Date()})
          .where(eq(labelTemplates.id, successor.id));
      }
    });

    await this.cache.del(CacheKeys.settingsLabelTemplates(businessId));
  }

  /** `base` overlaid with whichever layout fields the caller actually sent. */
  private applyLabelLayout(
    base: LabelLayout,
    dto: UpdateLabelSettingsDto,
  ): LabelLayout {
    const current = this.pickLabelLayout(base);
    return {
      widthMm: dto.widthMm ?? current.widthMm,
      heightMm: dto.heightMm ?? current.heightMm,
      paddingMm: dto.paddingMm ?? current.paddingMm,
      showStoreName: dto.showStoreName ?? current.showStoreName,
      showName: dto.showName ?? current.showName,
      nameLines: dto.nameLines ?? current.nameLines,
      showPrice: dto.showPrice ?? current.showPrice,
      showCode: dto.showCode ?? current.showCode,
      showBarcode: dto.showBarcode ?? current.showBarcode,
      showBarcodeText: dto.showBarcodeText ?? current.showBarcodeText,
      showPlu: dto.showPlu ?? current.showPlu,
      barcodeHeightMm: dto.barcodeHeightMm ?? current.barcodeHeightMm,
      fontScale: dto.fontScale ?? current.fontScale,
      copies: dto.copies ?? current.copies,
    };
  }

  // ── The pre-templates endpoints ────────────────────────────────────────────
  //
  // `/settings/label` used to be the whole feature: one layout per business.
  // Clients that predate templates (a cached frontend bundle mid-deploy, the
  // mobile app) still call it, so it now reads and writes the default template
  // instead of its own row. `label_settings` itself is no longer touched.

  /** The default template, in the pre-templates shape. */
  async getLabelSettings(businessId: string): Promise<LabelSettings> {
    const [primary] = await this.listLabelTemplates(businessId);
    return {
      businessId,
      ...this.pickLabelLayout(primary),
      updatedAt: primary.updatedAt,
    };
  }

  /** Edits the default template through the pre-templates endpoint. */
  async updateLabelSettings(
    businessId: string,
    dto: UpdateLabelSettingsDto,
  ): Promise<LabelSettings> {
    const [primary] = await this.listLabelTemplates(businessId);
    await this.updateLabelTemplate(businessId, primary.id, dto);
    return this.getLabelSettings(businessId);
  }
}
