import {Module} from '@nestjs/common';
import {AiSqlModule} from '../ai-sql/ai-sql.module';
import {BranchModule} from '../branch/branch.module';
import {BusinessModule} from '../business/business.module';
import {DatabaseModule} from '../database/database.module';
import {OrderModule} from '../order/order.module';
import {ReportModule} from '../report/report.module';
import {SubscriptionModule} from '../subscription/subscription.module';
import {TargetModule} from '../target/target.module';
import {AiSettingsController} from './ai-settings.controller';
import {AiSettingsService} from './ai-settings.service';
import {AiController} from './ai.controller';
import {AiService} from './ai.service';
import {AiToolsService} from './tools/ai-tools.service';

/**
 * "Do'koningdan so'ra" — the natural-language assistant.
 *
 * The report/order/branch/target modules are imported for their services, which
 * the tool registry calls. Nothing new queries the database here: every tool is
 * a thin wrapper over an endpoint the app already exposes, so tenant scoping
 * and the accounting rules come for free.
 *
 * BusinessModule and SubscriptionModule are needed because JwtAuthGuard and
 * PlanTierGuard inject their services.
 */
@Module({
  imports: [
    DatabaseModule,
    BusinessModule,
    SubscriptionModule,
    ReportModule,
    OrderModule,
    BranchModule,
    TargetModule,
    // Non-global on purpose: the read-only pool is reachable only from here.
    AiSqlModule,
  ],
  controllers: [AiSettingsController, AiController],
  providers: [AiSettingsService, AiToolsService, AiService],
  exports: [AiSettingsService],
})
export class AiModule {}
