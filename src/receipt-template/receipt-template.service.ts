import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {and, desc, eq, isNull} from 'drizzle-orm';
import {DatabaseService} from '../database/database.service';
import {
  receiptSettings,
  receiptTemplates,
  type ReceiptTemplate,
} from '../database/schema';
import {generateId} from '../utils/uuid';
import {CreateReceiptTemplateDto} from './dto/create-receipt-template.dto';
import {UpdateReceiptTemplateDto} from './dto/update-receipt-template.dto';
import {
  DEFAULT_FOOTER_LINKS,
  DEFAULT_FOOTER_TEXT,
  DEFAULT_INFO_FIELDS,
} from './receipt-template.constants';

@Injectable()
export class ReceiptTemplateService {
  constructor(private readonly dbService: DatabaseService) {}

  /** All templates for a business, default first, then newest. */
  async findAll(businessId: string): Promise<ReceiptTemplate[]> {
    await this.ensureDefault(businessId);
    return this.dbService.db
      .select()
      .from(receiptTemplates)
      .where(eq(receiptTemplates.businessId, businessId))
      .orderBy(
        desc(receiptTemplates.isDefault),
        desc(receiptTemplates.createdAt),
      );
  }

  async findOne(businessId: string, id: string): Promise<ReceiptTemplate> {
    const [row] = await this.dbService.db
      .select()
      .from(receiptTemplates)
      .where(
        and(
          eq(receiptTemplates.id, id),
          eq(receiptTemplates.businessId, businessId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Receipt template not found');
    return row;
  }

  /**
   * The template that applies to a register: its own if it has one, otherwise
   * the business-wide default. Lazily creates the default when missing.
   */
  async resolve(
    businessId: string,
    registerId?: string,
  ): Promise<ReceiptTemplate> {
    if (registerId) {
      const [own] = await this.dbService.db
        .select()
        .from(receiptTemplates)
        .where(
          and(
            eq(receiptTemplates.businessId, businessId),
            eq(receiptTemplates.registerId, registerId),
          ),
        )
        .limit(1);
      if (own) return own;
    }
    return this.ensureDefault(businessId);
  }

  async create(
    businessId: string,
    dto: CreateReceiptTemplateDto,
  ): Promise<ReceiptTemplate> {
    // A default template must be business-wide (no register binding), and only
    // one default may exist at a time.
    const makeDefault = dto.isDefault ?? false;
    if (makeDefault) await this.clearDefault(businessId);

    const [row] = await this.dbService.db
      .insert(receiptTemplates)
      .values({
        id: generateId(),
        businessId,
        name: dto.name,
        printType: dto.printType ?? 'receipt',
        registerId: makeDefault ? null : (dto.registerId ?? null),
        showLogo: dto.showLogo ?? true,
        logoUrl: dto.logoUrl ?? null,
        extraImageUrl: dto.extraImageUrl ?? null,
        showCustomerBalance: dto.showCustomerBalance ?? false,
        showCustomerDebt: dto.showCustomerDebt ?? false,
        showProductAttributes: dto.showProductAttributes ?? false,
        showPoweredBy: dto.showPoweredBy ?? true,
        infoFields: dto.infoFields ?? DEFAULT_INFO_FIELDS,
        footerLinks: dto.footerLinks ?? DEFAULT_FOOTER_LINKS,
        footerText: dto.footerText ?? DEFAULT_FOOTER_TEXT,
        isDefault: makeDefault,
      })
      .returning();
    return row;
  }

  async update(
    businessId: string,
    id: string,
    dto: UpdateReceiptTemplateDto,
  ): Promise<ReceiptTemplate> {
    const existing = await this.findOne(businessId, id);

    const makeDefault = dto.isDefault ?? existing.isDefault;
    if (dto.isDefault === true && !existing.isDefault) {
      await this.clearDefault(businessId);
    }

    const set: Partial<ReceiptTemplate> = {updatedAt: new Date()};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.printType !== undefined) set.printType = dto.printType;
    if (dto.registerId !== undefined) set.registerId = dto.registerId;
    if (dto.showLogo !== undefined) set.showLogo = dto.showLogo;
    if (dto.logoUrl !== undefined) set.logoUrl = dto.logoUrl;
    if (dto.extraImageUrl !== undefined) set.extraImageUrl = dto.extraImageUrl;
    if (dto.showCustomerBalance !== undefined)
      set.showCustomerBalance = dto.showCustomerBalance;
    if (dto.showCustomerDebt !== undefined)
      set.showCustomerDebt = dto.showCustomerDebt;
    if (dto.showProductAttributes !== undefined)
      set.showProductAttributes = dto.showProductAttributes;
    if (dto.showPoweredBy !== undefined) set.showPoweredBy = dto.showPoweredBy;
    if (dto.infoFields !== undefined) set.infoFields = dto.infoFields;
    if (dto.footerLinks !== undefined) set.footerLinks = dto.footerLinks;
    if (dto.footerText !== undefined) set.footerText = dto.footerText;
    if (dto.isDefault !== undefined) set.isDefault = makeDefault;
    // A default template is always business-wide.
    if (makeDefault) set.registerId = null;

    const [row] = await this.dbService.db
      .update(receiptTemplates)
      .set(set)
      .where(
        and(
          eq(receiptTemplates.id, id),
          eq(receiptTemplates.businessId, businessId),
        ),
      )
      .returning();
    return row;
  }

  async remove(businessId: string, id: string): Promise<void> {
    const existing = await this.findOne(businessId, id);
    if (existing.isDefault) {
      throw new BadRequestException(
        'Cannot delete the default template. Set another as default first.',
      );
    }
    await this.dbService.db
      .delete(receiptTemplates)
      .where(
        and(
          eq(receiptTemplates.id, id),
          eq(receiptTemplates.businessId, businessId),
        ),
      );
  }

  /** Unset any current default (used before assigning a new one). */
  private async clearDefault(businessId: string): Promise<void> {
    await this.dbService.db
      .update(receiptTemplates)
      .set({isDefault: false, updatedAt: new Date()})
      .where(
        and(
          eq(receiptTemplates.businessId, businessId),
          eq(receiptTemplates.isDefault, true),
        ),
      );
  }

  /**
   * Return the business-wide default, creating one from receipt_settings the
   * first time (covers businesses created after the seed migration ran).
   */
  private async ensureDefault(businessId: string): Promise<ReceiptTemplate> {
    const [current] = await this.dbService.db
      .select()
      .from(receiptTemplates)
      .where(
        and(
          eq(receiptTemplates.businessId, businessId),
          eq(receiptTemplates.isDefault, true),
        ),
      )
      .limit(1);
    if (current) return current;

    // No default yet — fall back to any business-wide (null register) template,
    // else create one from the existing receipt settings.
    const [orphan] = await this.dbService.db
      .select()
      .from(receiptTemplates)
      .where(
        and(
          eq(receiptTemplates.businessId, businessId),
          isNull(receiptTemplates.registerId),
        ),
      )
      .limit(1);
    if (orphan) {
      const [promoted] = await this.dbService.db
        .update(receiptTemplates)
        .set({isDefault: true, updatedAt: new Date()})
        .where(eq(receiptTemplates.id, orphan.id))
        .returning();
      return promoted;
    }

    const [settings] = await this.dbService.db
      .select()
      .from(receiptSettings)
      .where(eq(receiptSettings.businessId, businessId))
      .limit(1);

    const [created] = await this.dbService.db
      .insert(receiptTemplates)
      .values({
        id: generateId(),
        businessId,
        name: settings?.receiptName ?? 'Standart',
        printType: 'receipt',
        registerId: null,
        showLogo: settings?.showLogo ?? true,
        logoUrl: settings?.logoUrl ?? null,
        showPoweredBy: true,
        infoFields: DEFAULT_INFO_FIELDS,
        footerLinks: DEFAULT_FOOTER_LINKS,
        footerText: DEFAULT_FOOTER_TEXT,
        isDefault: true,
      })
      .returning();
    return created;
  }
}
