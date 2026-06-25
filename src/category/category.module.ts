import { Module } from '@nestjs/common';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';
import { BusinessService } from 'src/business/business.service';

@Module({
  controllers: [CategoryController],
  providers: [CategoryService, BusinessService],
  exports: [CategoryService],
})
export class CategoryModule { }
