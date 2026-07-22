ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "avatar_url" varchar(500);--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "avatar_url" varchar(500);
