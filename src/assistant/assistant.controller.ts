import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags} from '@nestjs/swagger';
import {timingSafeEqual} from 'crypto';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import type {IBusiness} from '../business/types';
import {FeatureGuard} from '../feature/feature.guard';
import {RequireFeature} from '../feature/require-feature.decorator';
import {PlanTierGuard} from '../subscription/plan-tier.guard';
import {MinTier} from '../subscription/required-tier.decorator';
import {PermissionsGuard} from '../permission/permissions.guard';
import {RequirePermission} from '../permission/permission.decorator';
import type {TgUpdate} from '../telegram/telegram-update-hooks';
import {AssistantService} from './assistant.service';
import {AssistantSettingsService} from './assistant-settings.service';
import {AssistantTelegram} from './assistant-telegram';
import {
  CreateFaqDto,
  TestAssistantDto,
  UpdateAssistantSettingsDto,
  UpdateFaqDto,
} from './dto/assistant.dto';

/**
 * Telegram → us. Public (Telegram has no JWT); trusted only through the
 * per-shop secret Telegram echoes back. Always answers 200 at once — the
 * answer is sent later through the Bot API, and a slow or failed response here
 * would make Telegram retry the same update.
 */
@ApiTags('assistant')
@Controller('telegram/store-bot')
export class AssistantWebhookController {
  constructor(private readonly assistant: AssistantService) {}

  @Post(':businessId/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  webhook(
    @Param('businessId') businessId: string,
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TgUpdate,
  ) {
    const expected = Buffer.from(AssistantTelegram.webhookSecret(businessId));
    const given = Buffer.from(secret ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return {ok: true}; // say nothing to a stranger
    }
    this.assistant.enqueue(businessId, update);
    return {ok: true};
  }
}

/**
 * Settings → AI yordamchi (AI-YORDAMCHI.md Q8). Flag first, then the plan
 * (the store bot it speaks through is a Business feature), then the
 * permission — all enforced here.
 */
@ApiTags('assistant')
@Controller('assistant')
@UseGuards(JwtAuthGuard, FeatureGuard, PlanTierGuard, PermissionsGuard)
@RequireFeature('ai_assistant')
@MinTier('pro')
@RequirePermission('settings:manage')
@ApiBearerAuth('JWT-auth')
export class AssistantSettingsController {
  constructor(private readonly settings: AssistantSettingsService) {}

  @Get('settings')
  @ApiOperation({summary: 'Assistant settings, FAQ, bot status and usage'})
  get(@CurrentBusiness() business: IBusiness) {
    return this.settings.get(business.id);
  }

  @Put('settings')
  @ApiOperation({summary: 'Change settings; enabling sets the store bot webhook'})
  update(@CurrentBusiness() business: IBusiness, @Body() dto: UpdateAssistantSettingsDto) {
    return this.settings.update(business.id, dto);
  }

  @Post('faqs')
  @ApiOperation({summary: 'Add a FAQ entry'})
  createFaq(@CurrentBusiness() business: IBusiness, @Body() dto: CreateFaqDto) {
    return this.settings.createFaq(business.id, dto.question, dto.answer);
  }

  @Put('faqs/:id')
  @ApiOperation({summary: 'Edit a FAQ entry'})
  updateFaq(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateFaqDto,
  ) {
    return this.settings.updateFaq(business.id, id, dto);
  }

  @Delete('faqs/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({summary: 'Delete a FAQ entry'})
  async deleteFaq(@CurrentBusiness() business: IBusiness, @Param('id') id: string) {
    await this.settings.deleteFaq(business.id, id);
  }

  @Post('test')
  @ApiOperation({summary: "Sinab ko'rish: one answer as a customer would get it"})
  test(@CurrentBusiness() business: IBusiness, @Body() dto: TestAssistantDto) {
    return this.settings.test(business.id, dto.history ?? [], dto.question);
  }
}
