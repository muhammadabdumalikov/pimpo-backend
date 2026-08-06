import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {OwnerGuard} from '../business/owner.guard';
import {IBusiness} from '../business/types';
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {MinTier} from '../subscription/required-tier.decorator';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {AiSettingsService} from './ai-settings.service';
import {decryptSecret} from './crypto.util';
import {
  AiProviderId,
  PROVIDER_MODELS,
} from './providers/llm-provider.interface';
import {SaveAiSettingsDto} from './dto/save-ai-settings.dto';
import {TestAiConnectionDto} from './dto/test-ai-connection.dto';

/**
 * BYOK configuration for the AI assistant.
 *
 * Owner-only: an API key is a billable credential on the owner's own provider
 * account, so staff accounts must not be able to read, replace, or delete it.
 * Pro tier, matching the assistant itself — there is nothing to configure on a
 * plan that cannot use it.
 */
@ApiTags('ai')
@Controller('ai/settings')
@UseGuards(JwtAuthGuard, PlanTierGuard, OwnerGuard)
@MinTier('pro')
@ApiBearerAuth('JWT-auth')
export class AiSettingsController {
  constructor(private readonly settings: AiSettingsService) {}

  @Get()
  @ApiOperation({summary: 'AI sozlamalari (kalitning oxirgi 4 belgisi bilan)'})
  async get(@CurrentBusiness() business: IBusiness) {
    return this.settings.getView(business.id);
  }

  @Put()
  @ApiOperation({summary: 'Provayder / model / API kalitni saqlash'})
  async save(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: SaveAiSettingsDto,
  ) {
    return this.settings.save(business.id, dto);
  }

  @Post('test')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Kalit va modelni tekshirish (hech narsa saqlanmaydi)',
  })
  async test(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: TestAiConnectionDto,
  ) {
    if (!dto.model) throw new AppException(ErrorCode.AI_UNKNOWN_MODEL);

    // No key in the payload means "test what's already saved" — used by the
    // settings page's Test button after a reload, when the input shows ••••.
    const apiKey = dto.apiKey?.trim() || (await this.storedKey(business.id));

    await this.settings.testConnection(dto.provider, dto.model, apiKey);
    return {ok: true};
  }

  /** Decrypts this business's saved key, or fails as "not configured". */
  private async storedKey(businessId: string): Promise<string> {
    const row = await this.settings.getRow(businessId);
    if (!row?.apiKeyCipher) throw new AppException(ErrorCode.AI_NOT_CONFIGURED);
    try {
      return decryptSecret(row.apiKeyCipher);
    } catch {
      throw new AppException(ErrorCode.AI_NOT_CONFIGURED);
    }
  }

  @Get('models')
  @ApiOperation({summary: 'Tanlash mumkin bo‘lgan modellar ro‘yxati'})
  models(@Query('provider') provider?: string) {
    // Static catalogue, so this needs no key and cannot fail — it replaced a
    // live vendor call that filled the dropdown with image, video and music
    // models. See PROVIDER_MODELS.
    const id = (provider ?? '') as AiProviderId;
    return {models: PROVIDER_MODELS[id] ?? []};
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({summary: 'Saqlangan kalitni butunlay o‘chirish'})
  async remove(@CurrentBusiness() business: IBusiness) {
    await this.settings.remove(business.id);
  }
}
