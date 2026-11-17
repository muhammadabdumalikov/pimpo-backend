-- The "Boshlash" (getting started) checklist on the owner's dashboard: steps
-- toward the first sale, each read from real data (src/onboarding). The only
-- thing stored is when the owner closed the card.
--
-- Idempotent; additive only — the old server never reads the column. Nullable
-- with no default, so adding it rewrites nothing.

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "onboarding_dismissed_at" timestamp;

-- Shops that have already sold are past getting started: mark them dismissed
-- so only new or never-activated shops see the card. "Sold" is the `sale`
-- step's condition in onboarding.service.ts — a 'Completed' order (not a Held
-- till draft, an online order still in progress, or a cancelled one). The
-- IS NULL guard keeps a re-run from moving a time already set.
UPDATE "businesses" b
SET "onboarding_dismissed_at" = now()
WHERE b."onboarding_dismissed_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "orders" o
    WHERE o."business_id" = b."id" AND o."status" = 'Completed'
  );
