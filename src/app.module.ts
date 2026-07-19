import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { BusinessModule } from './business/business.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { ProductModule } from './product/product.module';
import { CategoryModule } from './category/category.module';
import { StoreModule } from './store/store.module';
import { DebtModule } from './debt/debt.module';
import { UserModule } from './user/user.module';
import { StorageModule } from './storage/storage.module';
import { RoleModule } from './role/role.module';
import { StaffModule } from './staff/staff.module';
import { OrderModule } from './order/order.module';
import { SettingsModule } from './settings/settings.module';
import { SupplierModule } from './supplier/supplier.module';
import { BranchModule } from './branch/branch.module';
import { BrandModule } from './brand/brand.module';
import { ReceiptModule } from './receipt/receipt.module';
import { ReceiptTemplateModule } from './receipt-template/receipt-template.module';
import { ShiftModule } from './shift/shift.module';
import { StockTakeModule } from './stock-take/stock-take.module';
import { FinanceModule } from './finance/finance.module';
import { ReportModule } from './report/report.module';
import { JwtModule } from '@nestjs/jwt';
import { CacheModule } from '@nestjs/cache-manager';

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
    ConfigModule.forRoot({ isGlobal: true }),
    // In-memory cache, available app-wide (isGlobal → CACHE_MANAGER injectable
    // everywhere without importing CacheModule per feature module). Per-call
    // TTLs are passed explicitly via cache.wrap(); this default is a fallback.
    CacheModule.register({ isGlobal: true, ttl: 60_000 }),
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
    BrandModule,
    ReceiptModule,
    ReceiptTemplateModule,
    ShiftModule,
    StockTakeModule,
    FinanceModule,
    ReportModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
