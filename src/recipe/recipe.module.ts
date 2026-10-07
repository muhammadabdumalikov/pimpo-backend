import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {FoodSettingsController, RecipeController} from './recipe.controller';
import {RecipeService} from './recipe.service';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [RecipeController, FoodSettingsController],
  providers: [RecipeService],
  exports: [RecipeService],
})
export class RecipeModule {}
