import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export default defineConfig({
  schema: './src/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:oLCvicppN1ALpQDNyCpORztaAT22jUtcyBE5mJYrS47ujmsZ19mkYf1clU4TEpka@116.202.26.85:5454/pimpo',
  },
});
