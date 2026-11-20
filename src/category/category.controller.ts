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
import {AppException} from '../common/errors/app.exception';
import {ErrorCode} from '../common/errors/error-codes';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../business/jwt-auth.guard';
import { CurrentBusiness } from '../business/decorators/current-business.decorator';
import { IBusiness } from '../business/types';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryService } from './category.service';
import { PermissionsGuard } from '../permission/permissions.guard';
import { RequirePermission } from '../permission/permission.decorator';
import {ReqLocale, type CatalogLocale} from './category-locale';
import {GlobalCatalogService} from './global-catalog.service';
import {ApplyCategoryPresetDto, SuggestCategoriesDto} from './dto/category-preset.dto';

@ApiTags('categories')
@Controller('categories')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class CategoryController {
  constructor(
    private readonly categoryService: CategoryService,
    private readonly catalog: GlobalCatalogService,
  ) { }

  @Post()
  @RequirePermission('catalog:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201, description: 'Category created' })
  @ApiResponse({ status: 409, description: 'Category id already exists' })
  async create(@CurrentBusiness() business: IBusiness, @Body() dto: CreateCategoryDto) {
    return this.categoryService.create(business.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all categories for current business' })
  @ApiResponse({ status: 200, description: 'List of categories' })
  async findAll(@CurrentBusiness() business: IBusiness, @ReqLocale() locale: CatalogLocale) {
    return this.categoryService.findAll(business.id, locale);
  }

  // Declared before @Get(':id') so the literal path always wins the match.
  @Get('presets')
  @ApiOperation({ summary: 'Lines of trade and ready-made categories (setup wizard)' })
  async presets(@ReqLocale() locale: CatalogLocale) {
    return this.catalog.presets(locale);
  }

  @Post('presets/apply')
  @RequirePermission('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add ready-made categories and own names; only ever adds' })
  async applyPreset(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: ApplyCategoryPresetDto,
    @ReqLocale() locale: CatalogLocale,
  ) {
    return this.categoryService.applyPreset(business.id, dto, locale);
  }

  @Post('presets/suggest')
  @RequirePermission('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'AI: categories for a line of trade typed in the owner\'s words' })
  async suggest(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: SuggestCategoriesDto,
    @ReqLocale() locale: CatalogLocale,
  ) {
    return this.categoryService.suggest(business.id, dto.text, locale);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get category by id' })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiResponse({ status: 200, description: 'Category' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async findOne(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @ReqLocale() locale: CatalogLocale,
  ) {
    const cat = await this.categoryService.findOneView(business.id, id, locale);
    if (!cat) throw new AppException(ErrorCode.CATEGORY_NOT_FOUND);
    return cat;
  }

  @Put(':id')
  @RequirePermission('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update category' })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiResponse({ status: 200, description: 'Category updated' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async update(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoryService.update(business.id, id, dto);
  }

  @Delete(':id')
  @RequirePermission('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete category' })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiResponse({ status: 200, description: 'Category deleted' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async remove(@CurrentBusiness() business: IBusiness, @Param('id') id: string) {
    await this.categoryService.remove(business.id, id);
    return { message: 'Category deleted successfully' };
  }
}
