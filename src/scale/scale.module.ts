import {Module} from '@nestjs/common';
import {ScaleController} from './scale.controller';
import {ScaleService} from './scale.service';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';

@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [ScaleController],
  providers: [ScaleService],
  exports: [ScaleService],
})
export class ScaleModule {}
