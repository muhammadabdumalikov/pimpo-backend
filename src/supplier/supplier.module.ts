import { Module } from '@nestjs/common';
import { SupplierController } from './supplier.controller';
import { SupplierService } from './supplier.service';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [SupplierController],
  providers: [SupplierService],
  exports: [SupplierService],
})
export class SupplierModule {}
