-- Inbox (AI-YORDAMCHI.md, I1): the owner/staff view of customer chats.
-- Chat state (bot paused, closed, linked customer), per-account read markers,
-- internal notes, quick replies and a review flag on bot answers.
--
-- Idempotent; additive only — defaulted/nullable columns and new tables that
-- the running code never reads.

-- 1. customer_chats
ALTER TABLE "customer_chats" ADD COLUMN IF NOT EXISTS "bot_paused" boolean DEFAULT false NOT NULL;
ALTER TABLE "customer_chats" ADD COLUMN IF NOT EXISTS "closed_at" timestamp;
ALTER TABLE "customer_chats" ADD COLUMN IF NOT EXISTS "customer_id" varchar(36);
ALTER TABLE "customer_chats" ADD COLUMN IF NOT EXISTS "last_customer_message_at" timestamp;
DO $$ BEGIN
 ALTER TABLE "customer_chats" ADD CONSTRAINT "customer_chats_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "customer_chats_business_last_idx" ON "customer_chats" USING btree ("business_id","last_message_at");
UPDATE "customer_chats" c
   SET "last_customer_message_at" = (
     SELECT max(m."created_at") FROM "customer_chat_messages" m
      WHERE m."chat_id" = c."id" AND m."role" = 'customer')
 WHERE c."last_customer_message_at" IS NULL;

-- 2. customer_chat_messages
ALTER TABLE "customer_chat_messages" ADD COLUMN IF NOT EXISTS "flag" varchar(12);

-- 3. Read markers
CREATE TABLE IF NOT EXISTS "customer_chat_reads" (
  "chat_id" varchar(36) NOT NULL,
  "account_id" varchar(36) NOT NULL,
  "last_read_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "customer_chat_reads_chat_id_account_id_pk" PRIMARY KEY("chat_id","account_id")
);
DO $$ BEGIN
 ALTER TABLE "customer_chat_reads" ADD CONSTRAINT "customer_chat_reads_chat_id_customer_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."customer_chats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- 4. Internal notes
CREATE TABLE IF NOT EXISTS "customer_chat_notes" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "chat_id" varchar(36) NOT NULL,
  "account_id" varchar(36) NOT NULL,
  "author_name" varchar(255) NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "customer_chat_notes" ADD CONSTRAINT "customer_chat_notes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "customer_chat_notes" ADD CONSTRAINT "customer_chat_notes_chat_id_customer_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."customer_chats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "customer_chat_notes_chat_idx" ON "customer_chat_notes" USING btree ("chat_id","created_at");

-- 5. Quick replies
CREATE TABLE IF NOT EXISTS "assistant_quick_replies" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "title" varchar(100) NOT NULL,
  "text" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "assistant_quick_replies" ADD CONSTRAINT "assistant_quick_replies_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "assistant_quick_replies_business_idx" ON "assistant_quick_replies" USING btree ("business_id","sort_order");
