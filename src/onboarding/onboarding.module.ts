import {Module} from '@nestjs/common';
import {DatabaseModule} from '../database/database.module';
import {BusinessModule} from '../business/business.module';
import {CategoryModule} from '../category/category.module';
import {RoleModule} from '../role/role.module';
import {StaffModule} from '../staff/staff.module';
import {BranchModule} from '../branch/branch.module';
import {OnboardingController} from './onboarding.controller';
import {OnboardingService} from './onboarding.service';

// The getting-started checklist. Step derivation lives in onboarding.steps.ts
// (pure) and OnboardingService (the per-business facts query).
@Module({
  // Role, staff and branch: the wizard's seller step (addCashier).
  imports: [DatabaseModule, BusinessModule, CategoryModule, RoleModule, StaffModule, BranchModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
