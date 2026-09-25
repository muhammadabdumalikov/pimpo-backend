import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiParam, ApiTags} from '@nestjs/swagger';
import {PlatformJwtGuard} from '../platform/platform-jwt.guard';
import {FeatureService} from './feature.service';
import {
  SetBusinessFeatureDto,
  SetFeatureOverridesDto,
  SetRolloutDto,
} from './dto/feature.dto';

/**
 * Platform console: roll features out per do'kon. The flag list itself is
 * FEATURE_CATALOG in code — the console only sets each flag's rollout and
 * which shops are on its beta / exclusion list.
 */
@ApiTags('platform')
@Controller('platform')
@UseGuards(PlatformJwtGuard)
@ApiBearerAuth('JWT-auth')
export class FeaturePlatformController {
  constructor(private readonly featureService: FeatureService) {}

  @Get('features')
  @ApiOperation({summary: 'Every feature flag with its rollout and reach'})
  list() {
    return this.featureService.listForPlatform();
  }

  @Get('features/:key')
  @ApiOperation({
    summary: 'One flag with the shops on its beta / exclusion list',
  })
  @ApiParam({name: 'key', description: 'Feature key'})
  get(@Param('key') key: string) {
    return this.featureService.getForPlatform(key);
  }

  @Put('features/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: "Set a flag's rollout: off / selected / all"})
  @ApiParam({name: 'key', description: 'Feature key'})
  setRollout(@Param('key') key: string, @Body() dto: SetRolloutDto) {
    return this.featureService.setRollout(key, dto.rollout);
  }

  @Post('features/:key/businesses')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Add shops to the beta list (or, with enabled=false, the exclusion list)',
  })
  @ApiParam({name: 'key', description: 'Feature key'})
  addBusinesses(
    @Param('key') key: string,
    @Body() dto: SetFeatureOverridesDto,
  ) {
    return this.featureService.setOverrides(
      key,
      dto.businessIds,
      dto.enabled ?? true,
    );
  }

  @Delete('features/:key/businesses/:businessId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Remove a shop's exception so it follows the rollout",
  })
  @ApiParam({name: 'key', description: 'Feature key'})
  @ApiParam({name: 'businessId', description: 'Business ID'})
  async removeBusiness(
    @Param('key') key: string,
    @Param('businessId') businessId: string,
  ) {
    await this.featureService.removeOverride(key, businessId);
  }

  @Get('businesses/:id/features')
  @ApiOperation({summary: 'Every flag as it stands for one shop'})
  @ApiParam({name: 'id', description: 'Business ID'})
  forBusiness(@Param('id') id: string) {
    return this.featureService.forBusiness(id);
  }

  @Put('businesses/:id/features/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Set (true/false) or clear (null) one shop's exception to one flag",
  })
  @ApiParam({name: 'id', description: 'Business ID'})
  @ApiParam({name: 'key', description: 'Feature key'})
  setForBusiness(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: SetBusinessFeatureDto,
  ) {
    return this.featureService.setBusinessOverride(id, key, dto.enabled);
  }
}
