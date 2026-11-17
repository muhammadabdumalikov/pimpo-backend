import {Controller, Get, HttpCode, HttpStatus, Post, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiResponse, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {OwnerGuard} from '../business/owner.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {OnboardingService} from './onboarding.service';

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
  @ApiResponse({status: 200, description: '{businessType, steps[], completed, dismissed}'})
  get(@CurrentBusiness() business: IBusiness) {
    return this.onboarding.getState(business);
  }

  @Post('dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Hide the checklist for good (idempotent)'})
  @ApiResponse({status: 200, description: 'The checklist, with dismissed: true'})
  dismiss(@CurrentBusiness() business: IBusiness) {
    return this.onboarding.dismiss(business);
  }
}
