import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {ScaleService} from './scale.service';
import {UpdateScaleSettingsDto} from './dto/update-scale-settings.dto';

// Label-scale support is plain retail plumbing, not a paid differentiator, so
// it ships on every plan.
@ApiTags('scale')
@Controller('scale')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ScaleController {
  constructor(private readonly scaleService: ScaleService) {}

  @Get('settings')
  @ApiOperation({summary: 'Scale barcode settings for the current business'})
  async getSettings(@CurrentBusiness() business: IBusiness) {
    const [settings, maxPlu] = await Promise.all([
      this.scaleService.getSettings(business.id),
      this.scaleService.maxPlu(business.id),
    ]);
    // maxPlu rides along so the till and the product form can bound a PLU
    // input without re-deriving it from the format widths.
    return {...settings, maxPlu};
  }

  @Put('settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Update scale barcode settings'})
  async updateSettings(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateScaleSettingsDto,
  ) {
    const settings = await this.scaleService.updateSettings(business.id, dto);
    return {...settings, maxPlu: await this.scaleService.maxPlu(business.id)};
  }
}
