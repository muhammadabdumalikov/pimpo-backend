import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
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
      'postgresql://postgres:oLCvicppN1ALpQDNyCpORztaAT22jUtcyBE5mJYrS47ujmsZ19mkYf1clU4TEpka@116.202.26.85:5454/pimpo';
  }

  async onModuleInit() {
    this.client = postgres(this.connectionString, { max: 1 });
    this.db = drizzle(this.client, { schema });
  }

  async onModuleDestroy() {
    await this.client.end();
  }
}
