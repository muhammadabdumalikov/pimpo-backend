import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { BusinessService } from '../business/business.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService, BusinessService],
  exports: [SettingsService],
})
export class SettingsModule {}
