import {Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiResponse, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {OwnerGuard} from '../business/owner.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {OnboardingService} from './onboarding.service';
import {SaveSetupWizardDto} from './dto/setup-wizard.dto';
import {CreateWizardCashierDto} from './dto/wizard-cashier.dto';
import {ReqLocale, type CatalogLocale} from '../category/category-locale';

/**
 * The owner's "Boshlash" card on the dashboard: steps toward the first sale,
 * each read from real data (never ticked by hand). Owner only — staff tokens
 * get OWNER_ONLY — and always the caller's own business.
 */
@ApiTags('onboarding')
@Controller('onboarding')
@UseGuards(JwtAuthGuard, OwnerGuard)
@ApiBearerAuth('JWT-auth')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @ApiOperation({summary: 'Getting-started checklist for the current business'})
  @ApiResponse({status: 200, description: '{businessType, steps[], completed, dismissed, wizard}'})
  get(@CurrentBusiness() business: IBusiness) {
    return this.onboarding.getState(business);
  }

  @Post('dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Hide the checklist until the owner restores it (idempotent)'})
  @ApiResponse({status: 200, description: 'The checklist, with dismissed: true'})
  dismiss(@CurrentBusiness() business: IBusiness) {
    return this.onboarding.dismiss(business);
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Bring a hidden checklist back (idempotent)'})
  @ApiResponse({status: 200, description: 'The checklist, with dismissed: false'})
  restore(@CurrentBusiness() business: IBusiness) {
    return this.onboarding.restore(business);
  }

  @Post('wizard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Save the setup wizard progress: step, lines of trade, done/skipped'})
  @ApiResponse({status: 200, description: 'The checklist with the updated wizard state'})
  saveWizard(@CurrentBusiness() business: IBusiness, @Body() dto: SaveSetupWizardDto) {
    return this.onboarding.saveWizard(business, dto);
  }

  // The role is named in the Accept-Language the dashboard sends, like the
  // wizard's category names.
  @Post('wizard/cashier')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: "Wizard seller step: a till account on a ready-made 'Kassir' role"})
  @ApiResponse({status: 200, description: '{staff: {id, name, login}, role: {id, name}}'})
  @ApiResponse({status: 400, description: 'SETUP_STEP_NOT_AVAILABLE for an online seller or a kitchen'})
  @ApiResponse({status: 409, description: 'STAFF_LOGIN_EXISTS'})
  addCashier(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateWizardCashierDto,
    @ReqLocale() locale: CatalogLocale,
  ) {
    return this.onboarding.addCashier(business, dto, locale);
  }
}
