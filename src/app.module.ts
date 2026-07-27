import {Module, Global} from '@nestjs/common';
import {ConfigModule, ConfigService} from '@nestjs/config';
import {AppController} from './app.controller';
import {AppService} from './app.service';
import {DatabaseModule} from './database/database.module';
import {BusinessModule} from './business/business.module';
import {SubscriptionModule} from './subscription/subscription.module';
import {ProductModule} from './product/product.module';
import {CategoryModule} from './category/category.module';
import {StoreModule} from './store/store.module';
import {DebtModule} from './debt/debt.module';
import {UserModule} from './user/user.module';
import {StorageModule} from './storage/storage.module';
import {RoleModule} from './role/role.module';
import {StaffModule} from './staff/staff.module';
import {OrderModule} from './order/order.module';
import {SettingsModule} from './settings/settings.module';
import {SupplierModule} from './supplier/supplier.module';
import {BranchModule} from './branch/branch.module';
import {UnitModule} from './unit/unit.module';
import {PaymentMethodModule} from './payment-method/payment-method.module';
import {BrandModule} from './brand/brand.module';
import {ReceiptModule} from './receipt/receipt.module';
import {ReceiptTemplateModule} from './receipt-template/receipt-template.module';
import {ShiftModule} from './shift/shift.module';
import {StockTakeModule} from './stock-take/stock-take.module';
import {StockTransferModule} from './stock-transfer/stock-transfer.module';
import {FinanceModule} from './finance/finance.module';
import {PayrollModule} from './payroll/payroll.module';
import {ReportModule} from './report/report.module';
import {TargetModule} from './target/target.module';
import {DigestModule} from './digest/digest.module';
import {TelegramModule} from './telegram/telegram.module';
import {BillzModule} from './billz/billz.module';
import {PlatformModule} from './platform/platform.module';
import {LoyaltyModule} from './loyalty/loyalty.module';
import {ScheduleModule} from '@nestjs/schedule';
import {JwtModule} from '@nestjs/jwt';
import {CacheModule} from '@nestjs/cache-manager';
import {buildCacheOptions} from './cache/cache.store';

// Global module for JWT - makes JwtService available everywhere.
// Uses registerAsync so the secret is read from ConfigService AFTER
// ConfigModule has loaded .env. A synchronous register() would read
// process.env at import time, before .env is loaded.
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>(
          'JWT_SECRET',
          'your-secret-key-change-in-production',
        ),
        signOptions: {
          expiresIn: Number(config.get('JWT_EXPIRES_IN')) || 60 * 60 * 24 * 7,
        },
      }),
    }),
  ],
  exports: [JwtModule],
})
class JwtGlobalModule {}

@Module({
  imports: [
    ConfigModule.forRoot({isGlobal: true}),
    // Shared cache, available app-wide (isGlobal → CACHE_MANAGER injectable
    // everywhere without importing CacheModule per feature module). Backed by
    // Redis when configured (shared across instances, survives deploys), else an
    // in-memory fallback for local dev — see buildCacheOptions. Per-call TTLs are
    // passed explicitly via cache.wrap(); the returned ttl is only a fallback.
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildCacheOptions(config),
    }),
    // In-process cron scheduler (R30 daily digest at 21:00 Asia/Tashkent).
    ScheduleModule.forRoot(),
    JwtGlobalModule,
    DatabaseModule,
    BusinessModule,
    SubscriptionModule,
    ProductModule,
    CategoryModule,
    StoreModule,
    DebtModule,
    UserModule,
    StorageModule,
    RoleModule,
    StaffModule,
    OrderModule,
    SettingsModule,
    SupplierModule,
    BranchModule,
    UnitModule,
    PaymentMethodModule,
    BrandModule,
    ReceiptModule,
    ReceiptTemplateModule,
    ShiftModule,
    StockTakeModule,
    StockTransferModule,
    FinanceModule,
    PayrollModule,
    ReportModule,
    TargetModule,
    DigestModule,
    TelegramModule,
    BillzModule,
    PlatformModule,
    LoyaltyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
