import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {CategoryModule} from '../category/category.module';
import {ProductModule} from '../product/product.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {FoodSettingsController, RecipeController} from './recipe.controller';
import {RecipeService} from './recipe.service';
import {MenuImportService} from './menu-import.service';

@Module({
  imports: [DatabaseModule, BusinessModule, CategoryModule, ProductModule, SubscriptionModule],
  controllers: [RecipeController, FoodSettingsController],
  providers: [RecipeService, MenuImportService],
  exports: [RecipeService],
})
export class RecipeModule {}
