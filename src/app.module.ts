import { Module, Global } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { BusinessModule } from './business/business.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { ProductModule } from './product/product.module';
import { DebtModule } from './debt/debt.module';
import { UserModule } from './user/user.module';
import { JwtModule } from '@nestjs/jwt';

// Global module for JWT - makes JwtService available everywhere
@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
      signOptions: {
        expiresIn: Number(process.env.JWT_EXPIRES_IN) || 60 * 60 * 24 * 7,
      },
    }),
  ],
  exports: [JwtModule],
})
class JwtGlobalModule {}

@Module({
  imports: [
    JwtGlobalModule,
    DatabaseModule,
    BusinessModule,
    SubscriptionModule,
    ProductModule,
    DebtModule,
    UserModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
