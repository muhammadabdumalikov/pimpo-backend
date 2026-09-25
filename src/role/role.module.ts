import { Module } from '@nestjs/common';
import { RoleController } from './role.controller';
import { RoleService } from './role.service';
import { BusinessService } from '../business/business.service';
import { SubscriptionModule } from '../subscription/subscription.module';
import { FeatureModule } from '../feature/feature.module';

@Module({
  imports: [SubscriptionModule, FeatureModule],
  controllers: [RoleController],
  providers: [RoleService, BusinessService],
  exports: [RoleService],
})
export class RoleModule {}
