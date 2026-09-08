import {
  Controller,
  Get,
  Put,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {ApiTags, ApiOperation, ApiBearerAuth} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {SettingsService} from './settings.service';
import {UpdateReceiptSettingsDto} from './dto/update-receipt-settings.dto';
import {UpdateLabelSettingsDto} from './dto/update-label-settings.dto';

@ApiTags('settings')
@Controller('settings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('receipt')
  @ApiOperation({summary: 'Get receipt settings for the current business'})
  async getReceiptSettings(@CurrentBusiness() business: IBusiness) {
    return this.settingsService.getReceiptSettings(business.id);
  }

  @Put('receipt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Update receipt settings for the current business'})
  async updateReceiptSettings(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateReceiptSettingsDto,
  ) {
    return this.settingsService.updateReceiptSettings(business.id, dto);
  }

  @Get('label')
  @ApiOperation({summary: 'Get the label (etiketka) layout for this business'})
  async getLabelSettings(@CurrentBusiness() business: IBusiness) {
    return this.settingsService.getLabelSettings(business.id);
  }

  @Put('label')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Update the label (etiketka) layout'})
  async updateLabelSettings(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateLabelSettingsDto,
  ) {
    return this.settingsService.updateLabelSettings(business.id, dto);
  }
}
