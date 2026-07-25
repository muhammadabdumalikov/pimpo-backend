-- Email becomes optional on businesses (platform admin can create a business
-- without one). The UNIQUE constraint stays; Postgres treats NULLs as distinct,
-- so multiple email-less businesses are allowed. Idempotent: DROP NOT NULL on an
-- already-nullable column is a no-op.
ALTER TABLE "businesses" ALTER COLUMN "email" DROP NOT NULL;
