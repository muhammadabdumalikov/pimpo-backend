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
import {AnnouncementService} from './announcement.service';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

/** Platform console: write and target "Yangiliklar". */
@ApiTags('platform')
@Controller('platform/announcements')
@UseGuards(PlatformJwtGuard)
@ApiBearerAuth('JWT-auth')
export class AnnouncementPlatformController {
  constructor(private readonly announcementService: AnnouncementService) {}

  @Get()
  @ApiOperation({
    summary: 'Every announcement with status, target and read counts',
  })
  list() {
    return this.announcementService.listForPlatform();
  }

  @Get(':id')
  @ApiOperation({summary: 'One announcement with its target shops'})
  @ApiParam({name: 'id', description: 'Announcement ID'})
  get(@Param('id') id: string) {
    return this.announcementService.getForPlatform(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an announcement (publishedAt omitted = draft)',
  })
  create(@Body() dto: CreateAnnouncementDto) {
    return this.announcementService.create(dto);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update an announcement; businessIds replaces the target list',
  })
  @ApiParam({name: 'id', description: 'Announcement ID'})
  update(@Param('id') id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.announcementService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({summary: 'Delete an announcement and its read receipts'})
  @ApiParam({name: 'id', description: 'Announcement ID'})
  async remove(@Param('id') id: string) {
    await this.announcementService.remove(id);
  }
}
