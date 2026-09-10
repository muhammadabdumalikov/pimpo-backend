import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {Response} from 'express';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {ScaleService} from './scale.service';
import {UpdateScaleSettingsDto} from './dto/update-scale-settings.dto';
import {type PluExportFormat} from './plu-export';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';

// Label-scale support is plain retail plumbing, not a paid differentiator, so
// it ships on every plan.
@ApiTags('scale')
@Controller('scale')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class ScaleController {
  constructor(private readonly scaleService: ScaleService) {}

  @Get('settings')
  @ApiOperation({summary: 'Scale barcode settings for the current business'})
  async getSettings(@CurrentBusiness() business: IBusiness) {
    const [settings, maxPlu, pluRange] = await Promise.all([
      this.scaleService.getSettings(business.id),
      this.scaleService.maxPlu(business.id),
      this.scaleService.pluRange(business.id),
    ]);
    // maxPlu (the hardware cap) and the effective window ride along so the till
    // and the product form can bound a PLU input without re-deriving either
    // from the format widths and the saved range.
    return {...settings, maxPlu, pluMin: pluRange.min, pluMax: pluRange.max};
  }

  @Get('plu-export')
  @ApiOperation({
    summary: 'PLU catalogue file for the scale vendor’s Windows software',
  })
  async pluExport(
    @CurrentBusiness() business: IBusiness,
    @Res({passthrough: true}) res: Response,
    @Query('format') format?: string,
  ): Promise<StreamableFile> {
    // Unknown values fall back to the vendor's spreadsheet rather than 400 —
    // this is a download link, and the safe shape is the verified one.
    const picked: PluExportFormat =
      format === 'txt' || format === 'txp' ? format : 'xls';

    const {file, filename, contentType, exported, skippedNoPlu} =
      await this.scaleService.buildPluExport(business.id, picked);

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      // The browser can't read the body it's downloading, so the counts ride
      // along in headers the settings page reads off the response.
      'X-Plu-Exported': String(exported),
      'X-Plu-Skipped-No-Plu': String(skippedNoPlu),
      'Access-Control-Expose-Headers': 'X-Plu-Exported, X-Plu-Skipped-No-Plu',
    });

    return new StreamableFile(file);
  }

  @Put('settings')
  @RequirePermission('settings:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Update scale barcode settings'})
  async updateSettings(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateScaleSettingsDto,
  ) {
    const settings = await this.scaleService.updateSettings(business.id, dto);
    const [maxPlu, pluRange] = await Promise.all([
      this.scaleService.maxPlu(business.id),
      this.scaleService.pluRange(business.id),
    ]);
    return {...settings, maxPlu, pluMin: pluRange.min, pluMax: pluRange.max};
  }
}
