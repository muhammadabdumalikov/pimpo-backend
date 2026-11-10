-- AI yordamchi (AI-YORDAMCHI.md §5): the customer-facing assistant on the
-- shop's own Telegram bot. Branch contact details (Q7), assistant settings +
-- FAQ (Q8), customer chats, their messages (kept 90 days, Q12) and handoffs to
-- staff (Q5, Q6, Q18).
--
-- Idempotent; safe to re-run. Additive only: nullable columns and new tables
-- the old code never reads. No grants to pimpo_ai_ro — the owner's AI SQL has
-- no business reading customer conversations.

-- 1. branches: contact details
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "phone" varchar(32);
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "working_hours" jsonb;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "map_url" varchar(500);

-- 2. Assistant settings, one row per business (missing = off)
CREATE TABLE IF NOT EXISTS "ai_assistant_settings" (
  "business_id" varchar(36) PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "tone" varchar(12) DEFAULT 'formal' NOT NULL,
  "greeting" text,
  "policies" text,
  "share_with_platform" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "ai_assistant_settings" ADD CONSTRAINT "ai_assistant_settings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- 3. FAQ
CREATE TABLE IF NOT EXISTS "ai_assistant_faqs" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "question" text NOT NULL,
  "answer" text NOT NULL,
  "source" varchar(12) DEFAULT 'manual' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "ai_assistant_faqs" ADD CONSTRAINT "ai_assistant_faqs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "ai_assistant_faqs_business_idx" ON "ai_assistant_faqs" USING btree ("business_id","created_at");

-- 4. Customer chats
CREATE TABLE IF NOT EXISTS "customer_chats" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "telegram_chat_id" varchar(32) NOT NULL,
  "telegram_user_id" varchar(32),
  "first_name" varchar(255),
  "username" varchar(255),
  "human_until" timestamp,
  "human_account_id" varchar(36),
  "last_message_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "customer_chats" ADD CONSTRAINT "customer_chats_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "customer_chats_business_chat_uq" ON "customer_chats" USING btree ("business_id","telegram_chat_id");

-- 5. Messages
CREATE TABLE IF NOT EXISTS "customer_chat_messages" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "chat_id" varchar(36) NOT NULL,
  "role" varchar(12) NOT NULL,
  "text" text,
  "media" jsonb,
  "staff_account_id" varchar(36),
  "tool_calls" jsonb,
  "model" varchar(64),
  "tokens_in" integer,
  "tokens_out" integer,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "customer_chat_messages" ADD CONSTRAINT "customer_chat_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "customer_chat_messages" ADD CONSTRAINT "customer_chat_messages_chat_id_customer_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."customer_chats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "customer_chat_messages_chat_idx" ON "customer_chat_messages" USING btree ("chat_id","created_at");
CREATE INDEX IF NOT EXISTS "customer_chat_messages_business_idx" ON "customer_chat_messages" USING btree ("business_id","created_at");

-- 6. Handoffs to staff
CREATE TABLE IF NOT EXISTS "customer_chat_handoffs" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "business_id" varchar(36) NOT NULL,
  "chat_id" varchar(36) NOT NULL,
  "reason" varchar(20) NOT NULL,
  "summary" text,
  "status" varchar(16) DEFAULT 'open' NOT NULL,
  "claimed_by_account_id" varchar(36),
  "claimed_by_name" varchar(255),
  "claimed_at" timestamp,
  "auto_replied_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "customer_chat_handoffs" ADD CONSTRAINT "customer_chat_handoffs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "customer_chat_handoffs" ADD CONSTRAINT "customer_chat_handoffs_chat_id_customer_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."customer_chats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "customer_chat_handoffs_chat_idx" ON "customer_chat_handoffs" USING btree ("chat_id","created_at");

-- 7. The platform-bot copies of each handoff (reply matching + edits)
CREATE TABLE IF NOT EXISTS "customer_chat_handoff_messages" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "handoff_id" varchar(36) NOT NULL,
  "staff_chat_id" varchar(32) NOT NULL,
  "message_id" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
 ALTER TABLE "customer_chat_handoff_messages" ADD CONSTRAINT "customer_chat_handoff_messages_handoff_id_customer_chat_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."customer_chat_handoffs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "customer_chat_handoff_messages_msg_uq" ON "customer_chat_handoff_messages" USING btree ("staff_chat_id","message_id");
CREATE INDEX IF NOT EXISTS "customer_chat_handoff_messages_handoff_idx" ON "customer_chat_handoff_messages" USING btree ("handoff_id");
