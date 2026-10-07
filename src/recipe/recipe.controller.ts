import {Body, Controller, Get, Param, Put, Query, UseGuards} from '@nestjs/common';
import {businessDay} from '../common/business-time';
import {ApiBearerAuth, ApiOperation, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../business/jwt-auth.guard';
import {CurrentBusiness} from '../business/decorators/current-business.decorator';
import {IBusiness} from '../business/types';
import {PermissionsGuard} from '../permission/permissions.guard';
import {RequirePermission} from '../permission/permission.decorator';
import {RecipeService} from './recipe.service';
import {SaveRecipeDto, UpdateFoodSettingsDto} from './dto/recipe.dto';

// Recipes of dish / semi-finished cards (FASTFOOD.md §3). They reveal what
// every dish costs, so reading them is gated like editing them.
@ApiTags('recipes')
@Controller('products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class RecipeController {
  constructor(private readonly recipeService: RecipeService) {}

  @Get(':id/recipe')
  @RequirePermission('recipe:manage')
  @ApiOperation({summary: "A dish/semi card's recipe with today's costs"})
  getRecipe(@CurrentBusiness() business: IBusiness, @Param('id') id: string) {
    return this.recipeService.getRecipe(business.id, id);
  }

  @Put(':id/recipe')
  @RequirePermission('recipe:manage')
  @ApiOperation({summary: "Replace a dish/semi card's recipe"})
  saveRecipe(
    @CurrentBusiness() business: IBusiness,
    @Param('id') id: string,
    @Body() dto: SaveRecipeDto,
  ) {
    return this.recipeService.saveRecipe(business.id, id, dto);
  }
}

// Fast-food settings. Reading is open — the till needs the note presets.
@ApiTags('food-settings')
@Controller('food-settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth('JWT-auth')
export class FoodSettingsController {
  constructor(private readonly recipeService: RecipeService) {}

  // The combos' parts for the kitchen ticket — open like the settings: the
  // till prints it, and it carries no cost.
  @Get('combos')
  @ApiOperation({summary: "Direct parts of every combo, for the kitchen ticket"})
  combos(@CurrentBusiness() business: IBusiness) {
    return this.recipeService.getCombos(business.id);
  }

  @Get('menu-cost')
  @RequirePermission('report:profit:view')
  @ApiOperation({summary: "Report: every dish's cost at today's prices vs its price"})
  menuCost(@CurrentBusiness() business: IBusiness) {
    return this.recipeService.getMenuCost(business.id);
  }

  @Get('negative')
  @RequirePermission('report:profit:view')
  @ApiOperation({summary: 'Report: stock cards below zero (sold ahead of their nakladnoy)'})
  negative(@CurrentBusiness() business: IBusiness) {
    return this.recipeService.getNegativeStock(business.id);
  }

  // Declared before nothing that could swallow it — the class has no ':id'.
  @Get('summary')
  @RequirePermission('report:profit:view')
  @ApiOperation({
    summary:
      'Dashboard: food cost % for the business days from..to, and ingredients below zero',
  })
  summary(
    @CurrentBusiness() business: IBusiness,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const today = businessDay();
    const valid = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today);
    return this.recipeService.getSummary(business.id, valid(from), valid(to));
  }

  @Get()
  @ApiOperation({summary: 'Note presets and the food-cost target'})
  get(@CurrentBusiness() business: IBusiness) {
    return this.recipeService.getSettings(business.id);
  }

  @Put()
  @RequirePermission('settings:manage')
  @ApiOperation({summary: 'Update the note presets / food-cost target'})
  update(
    @CurrentBusiness() business: IBusiness,
    @Body() dto: UpdateFoodSettingsDto,
  ) {
    return this.recipeService.updateSettings(business.id, dto);
  }
}
