import { Module } from '@nestjs/common';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';
import { BusinessService } from 'src/business/business.service';
import {GlobalCatalogService} from './global-catalog.service';
import {CategorySuggestService} from './category-suggest.service';
import {GlobalCatalogPlatformController} from './global-catalog-platform.controller';

@Module({
  controllers: [CategoryController, GlobalCatalogPlatformController],
  providers: [CategoryService, BusinessService, GlobalCatalogService, CategorySuggestService],
  exports: [CategoryService, GlobalCatalogService],
})
export class CategoryModule { }
