import { Module } from '@nestjs/common';
import { SupplierController } from './supplier.controller';
import { SupplierService } from './supplier.service';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from 'src/business/business.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { FeatureModule } from '../feature/feature.module';
import { DefectiveModule } from '../defective/defective.module';

@Module({
  imports: [
    DatabaseModule,
    BusinessModule,
    SubscriptionModule,
    FeatureModule,
    DefectiveModule,
  ],
  controllers: [SupplierController],
  providers: [SupplierService],
  exports: [SupplierService],
})
export class SupplierModule {}
