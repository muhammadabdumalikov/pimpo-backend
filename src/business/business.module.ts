import { Module } from '@nestjs/common';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  controllers: [BusinessController],
  providers: [BusinessService, AuthService, JwtAuthGuard],
  exports: [BusinessService, AuthService],
})
export class BusinessModule {}
