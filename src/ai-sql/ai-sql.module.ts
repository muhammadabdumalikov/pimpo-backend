import {
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import postgres, {Sql} from 'postgres';
import {AI_SQL_CLIENT} from './ai-sql.constants';
import {AiSqlService} from './ai-sql.service';

/**
 * A second, deliberately tiny database pool that connects as a read-only role.
 *
 * NOT `@Global()`, unlike DatabaseModule: only a module that explicitly imports
 * this one can reach the AI pool, so it cannot be injected into ordinary
 * application code by accident.
 */
@Module({
  providers: [
    {
      provide: AI_SQL_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Sql | null => {
        const dsn = config.get<string>('AI_DATABASE_URL');

        // Fail closed. Never derive this DSN from DATABASE_URL by string
        // surgery — a malformed URL would silently fall back to the privileged
        // application role, which is the worst possible outcome here.
        if (!dsn) {
          new Logger('AiSqlModule').log(
            'AI_DATABASE_URL is unset — ad-hoc SQL is disabled. The assistant ' +
              'still answers everything the report tools cover.',
          );
          return null;
        }

        return postgres(dsn, {
          // Small on purpose: a runaway analytical query must never starve the
          // application pool (DB_POOL_MAX defaults to 10) on a 2 vCPU host.
          // Mirrored server-side by the role's CONNECTION LIMIT.
          max: Number(config.get('AI_DB_POOL_MAX')) || 2,
          idle_timeout: 20,
          connect_timeout: 5,
          max_lifetime: 60 * 30,
          // Unnamed statements only: PgBouncer-safe, and no plan is ever reused
          // across the ad-hoc queries we run here anyway.
          prepare: false,
          connection: {application_name: 'pimpo-ai-ro'},
          // A NOTICE raised by model-written SQL must not reach the app log.
          onnotice: () => {},
        });
      },
    },
    AiSqlService,
  ],
  exports: [AiSqlService],
})
export class AiSqlModule implements OnApplicationShutdown {
  constructor(
    @Optional() @Inject(AI_SQL_CLIENT) private readonly sql: Sql | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.sql?.end({timeout: 5});
  }
}
