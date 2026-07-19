import {Module} from '@nestjs/common';
import {ProductController} from './product.controller';
import {ProductService} from './product.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from 'src/business/business.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {BranchModule} from '../branch/branch.module';

@Module({
  imports: [DatabaseModule, BusinessModule, SubscriptionModule, BranchModule],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
