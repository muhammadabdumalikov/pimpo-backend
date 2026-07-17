import { Module } from '@nestjs/common';
import { BrandController } from './brand.controller';
import { BrandService } from './brand.service';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [BrandController],
  providers: [BrandService],
  exports: [BrandService],
})
export class BrandModule {}
