import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
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
  ): Promise<StreamableFile> {
    const {file, exported, skippedNoPlu} =
      await this.scaleService.buildPluExport(business.id);

    // `.xls` is the vendor's own naming for what is really a UTF-16 TSV; Excel
    // sniffs the BOM and opens it, which is the path PLU Manager's "Import from
    // Excel" takes. Renaming it .txt would break that flow.
    res.set({
      'Content-Type': 'application/vnd.ms-excel',
      'Content-Disposition': 'attachment; filename="pimpo-plu.xls"',
      // The browser can't read the body it's downloading, so the counts ride
      // along in headers the settings page reads off the response.
      'X-Plu-Exported': String(exported),
      'X-Plu-Skipped-No-Plu': String(skippedNoPlu),
      'Access-Control-Expose-Headers': 'X-Plu-Exported, X-Plu-Skipped-No-Plu',
    });

    return new StreamableFile(file);
  }

  @Put('settings')
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
