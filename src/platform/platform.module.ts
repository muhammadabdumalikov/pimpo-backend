import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformJwtGuard } from './platform-jwt.guard';
import { DatabaseModule } from '../database/database.module';
import { BusinessModule } from '../business/business.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformAuthService, PlatformJwtGuard],
})
export class PlatformModule {}
