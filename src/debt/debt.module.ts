import { Module } from '@nestjs/common';
import { DebtController } from './debt.controller';
import { DebtService } from './debt.service';
import { DatabaseModule } from '../database/database.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { BusinessModule } from '../business/business.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [DatabaseModule, SubscriptionModule, BusinessModule, UserModule],
  controllers: [DebtController],
  providers: [DebtService],
  exports: [DebtService],
})
export class DebtModule {}
