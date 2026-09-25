import {Controller, Get, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {FeatureService} from './feature.service';

/**
 * Tenant side of feature flags: which rolling-out features this shop sees.
 * The web app and kpos-mobile read it once per session to show or hide
 * screens; the endpoints themselves are gated by FeatureGuard regardless.
 */
@ApiTags('features')
@Controller('features')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class FeatureController {
  constructor(private readonly featureService: FeatureService) {}

  @Get('me')
  @ApiOperation({summary: 'Feature flags enabled for the current business'})
  async mine(@CurrentBusiness() business: IBusiness) {
    return {features: await this.featureService.enabledFor(business.id)};
  }
}
