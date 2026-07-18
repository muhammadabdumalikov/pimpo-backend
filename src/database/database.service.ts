import {Injectable, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {drizzle} from 'drizzle-orm/postgres-js';
import * as postgres from 'postgres';
import * as schema from './schema';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private connectionString: string;
  private client: postgres.Sql;
  public db: ReturnType<typeof drizzle>;

  constructor(private readonly configService: ConfigService) {
    this.connectionString =
      this.configService.get<string>('DATABASE_URL') ||
      'postgresql://postgres:oLCvicppN1ALpQDNyCpORztaAT22jUtcyBE5mJYrS47ujmsZ19mkYf1clU4TEpka@116.202.26.85:5454/KPOS';
  }

  async onModuleInit() {
    // Connection pool size. The DB is remote, so each query carries network
    // round-trip latency — a single connection serializes everything. A modest
    // pool lets queries overlap that latency. Configurable via DB_POOL_MAX;
    // keep it well under Postgres `max_connections` (default 100), accounting
    // for other app instances sharing the same database.
    const poolMax = Number(this.configService.get('DB_POOL_MAX')) || 10;

    this.client = postgres(this.connectionString, {
      max: poolMax,
      // Drop idle connections after 30s so we don't hold sockets open needlessly.
      idle_timeout: 30,
      // Fail fast if the remote DB is unreachable rather than hanging requests.
      connect_timeout: 10,
    });
    this.db = drizzle(this.client, {schema});
  }

  async onModuleDestroy() {
    await this.client.end();
  }
}
