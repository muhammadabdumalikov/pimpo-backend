-- Feature flags per do'kon + platform announcements ("Yangiliklar").
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend.
--
-- Why: a new feature went to every shop at once, the moment it was deployed.
-- There was no way to hand it to three friendly shops first, and no way to
-- tell a shop inside the app that something new had arrived. Plan tiers gate
-- by what a shop PAYS for; this gates by WHICH shop — a separate axis.
--
-- Flag keys live in code (src/feature/feature.catalog.ts); these tables only
-- hold the state the platform console sets for them. A key with no row in
-- feature_flags is 'off'.

CREATE TABLE IF NOT EXISTS "feature_flags" (
  "key" varchar(64) PRIMARY KEY NOT NULL,
  -- 'off' (kill switch — the list is kept but ignored) | 'selected' | 'all'
  "rollout" varchar(16) NOT NULL DEFAULT 'off',
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Per-business exceptions: the beta list under 'selected' (enabled = true), the
-- exclusion list under 'all' (enabled = false). No FK to feature_flags on
-- purpose: a shop can be put on a beta before its rollout row exists.
CREATE TABLE IF NOT EXISTS "business_feature_flags" (
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "feature_key" varchar(64) NOT NULL,
  "enabled" boolean NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "business_feature_flags_business_id_feature_key_pk" PRIMARY KEY ("business_id", "feature_key")
);

-- "Which shops are on this beta" — the platform console's per-flag list.
CREATE INDEX IF NOT EXISTS "business_feature_flags_feature_idx"
  ON "business_feature_flags" ("feature_key");

CREATE TABLE IF NOT EXISTS "announcements" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  -- 'feature' | 'improvement' | 'fix' | 'notice'
  "kind" varchar(16) NOT NULL DEFAULT 'feature',
  -- {"uz": "...", "ru": "...", "en": "..."}; uz is required and the fallback
  "title" jsonb NOT NULL,
  "body" jsonb NOT NULL,
  "link_url" varchar(500),
  -- 'all' | 'tier' (min_tier) | 'selected' (announcement_targets) | 'feature' (feature_key)
  "audience" varchar(16) NOT NULL DEFAULT 'all',
  "min_tier" varchar(16),
  "feature_key" varchar(64),
  "popup" boolean NOT NULL DEFAULT false,
  -- NULL = draft; a future value schedules it
  "published_at" timestamp,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "announcements_published_idx"
  ON "announcements" ("published_at");

CREATE TABLE IF NOT EXISTS "announcement_targets" (
  "announcement_id" varchar(36) NOT NULL REFERENCES "announcements"("id") ON DELETE CASCADE,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  CONSTRAINT "announcement_targets_announcement_id_business_id_pk" PRIMARY KEY ("announcement_id", "business_id")
);

CREATE INDEX IF NOT EXISTS "announcement_targets_business_idx"
  ON "announcement_targets" ("business_id");

-- One row per account (owner = business.id, staff = staff.id) that has seen it.
CREATE TABLE IF NOT EXISTS "announcement_reads" (
  "announcement_id" varchar(36) NOT NULL REFERENCES "announcements"("id") ON DELETE CASCADE,
  "account_id" varchar(36) NOT NULL,
  "business_id" varchar(36) NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "read_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "announcement_reads_announcement_id_account_id_pk" PRIMARY KEY ("announcement_id", "account_id")
);
