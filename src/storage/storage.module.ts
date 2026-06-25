import { Module, Global } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { BusinessService } from 'src/business/business.service';

@Global()
@Module({
  controllers: [StorageController],
  providers: [StorageService, BusinessService],
  exports: [StorageService],
})
export class StorageModule {}
