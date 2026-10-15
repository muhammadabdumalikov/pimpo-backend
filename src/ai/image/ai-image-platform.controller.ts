import {Body, Controller, Get, Param, Put, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiOperation, ApiParam, ApiTags} from '@nestjs/swagger';
import {PlatformJwtGuard} from '../../platform/platform-jwt.guard';
import {SetAiImageQuotaDto} from './ai-image.dto';
import {AiImageService} from './ai-image.service';

/**
 * Platform console for AI product images: this month's spend against the
 * platform budget, and each shop's allowance (Q9 — raise it for a shop filling
 * its catalogue, permanently or for this month only).
 */
@ApiTags('platform')
@Controller('platform')
@UseGuards(PlatformJwtGuard)
@ApiBearerAuth('JWT-auth')
export class AiImagePlatformController {
  constructor(private readonly images: AiImageService) {}

  @Get('ai-images/summary')
  @ApiOperation({summary: 'AI image spend this month, budget, top shops'})
  summary() {
    return this.images.platformSummary();
  }

  @Get('businesses/:id/ai-image-quota')
  @ApiOperation({summary: "A shop's AI image allowance and this month's use"})
  @ApiParam({name: 'id', description: 'Business ID'})
  getQuota(@Param('id') id: string) {
    return this.images.getQuota(id);
  }

  @Put('businesses/:id/ai-image-quota')
  @ApiOperation({
    summary: "Set a shop's AI image allowance / this month's bonus",
  })
  @ApiParam({name: 'id', description: 'Business ID'})
  setQuota(@Param('id') id: string, @Body() dto: SetAiImageQuotaDto) {
    return this.images.setQuota(id, dto);
  }
}
