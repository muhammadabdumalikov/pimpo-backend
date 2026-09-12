import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
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
import {CreateLabelTemplateDto} from './dto/create-label-template.dto';
import {UpdateLabelTemplateDto} from './dto/update-label-template.dto';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';

@ApiTags('settings')
@Controller('settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('receipt')
  @ApiOperation({summary: 'Get receipt settings for the current business'})
  async getReceiptSettings(@CurrentBusiness() business: IBusiness) {
    return this.settingsService.getReceiptSettings(business.id);
  }

  @Put('receipt')
  @RequirePermission('settings:manage')
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
  @RequirePermission('settings:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Update the label (etiketka) layout'})
  async updateLabelSettings(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateLabelSettingsDto,
  ) {
    return this.settingsService.updateLabelSettings(business.id, dto);
  }

  // Reading the templates is open: whoever may print a label has to be able to
  // pick one. Only editing them is settings:manage.
  @Get('label-templates')
  @ApiOperation({summary: 'List the label (etiketka) templates, default first'})
  async listLabelTemplates(@CurrentBusiness() business: IBusiness) {
    return this.settingsService.listLabelTemplates(business.id);
  }

  @Post('label-templates')
  @RequirePermission('settings:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({summary: 'Add a label template'})
  async createLabelTemplate(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: CreateLabelTemplateDto,
  ) {
    return this.settingsService.createLabelTemplate(business.id, dto);
  }

  @Put('label-templates/:id')
  @RequirePermission('settings:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Edit, rename or promote a label template'})
  async updateLabelTemplate(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateLabelTemplateDto,
  ) {
    return this.settingsService.updateLabelTemplate(business.id, id, dto);
  }

  @Delete('label-templates/:id')
  @RequirePermission('settings:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({summary: 'Delete a label template (the last one stays)'})
  async deleteLabelTemplate(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
  ) {
    await this.settingsService.deleteLabelTemplate(business.id, id);
    return {success: true};
  }
}
