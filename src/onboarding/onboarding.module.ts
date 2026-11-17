import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {OnboardingController} from './onboarding.controller';
import {OnboardingService} from './onboarding.service';

// The getting-started checklist. Step derivation lives in onboarding.steps.ts
// (pure) and OnboardingService (the per-business facts query).
@Module({
  imports: [DatabaseModule, BusinessModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
