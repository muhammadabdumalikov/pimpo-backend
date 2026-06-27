import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { receiptSettings, type ReceiptSettings } from '../database/schema';
import { UpdateReceiptSettingsDto } from './dto/update-receipt-settings.dto';

const DEFAULTS = {
  receiptName: 'Standart',
  showLogo: true,
  logoUrl: null as string | null,
};

@Injectable()
export class SettingsService {
  constructor(private readonly dbService: DatabaseService) {}

  /** Receipt settings for a business, falling back to defaults if unset. */
  async getReceiptSettings(businessId: string): Promise<ReceiptSettings> {
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
      updatedAt: new Date(),
    };
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
    };

    await this.dbService.db
      .insert(receiptSettings)
      .values({ businessId, ...next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: receiptSettings.businessId,
        set: { ...next, updatedAt: new Date() },
      });

    return this.getReceiptSettings(businessId);
  }
}
