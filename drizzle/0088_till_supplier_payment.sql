-- Kassa: "Ta'minotchiga to'lov" — paying a supplier out of the till.
--
-- Idempotent; safe to re-run. Run BEFORE deploying the backend (the new code
-- writes these columns). Run with `psql -f`: `db:migrate` stops at the 0052
-- journal and `db:push` never runs hand-written SQL.
--
-- Why: the till could only book cash out as an expense category, so a shop
-- paying its agents from the drawer wrote "Do'kon xarajati" and the P&L took
-- the goods' cost twice — once as COGS when sold, once as that expense. A till
-- payment to a supplier now settles their oldest open receipts as ordinary
-- supplier payments, and whatever is left over becomes their advance
-- (supplier_credits, kind 'advance'), spent later with "Avansdan".
--
--   cash_movements.supplier_id / supplier_name   who got the money (name is a
--                                                snapshot, like receipts keep)
--
-- And "Avansni o'tkazish": an advance moved from one supplier to another (money
-- booked to the wrong name, or parked on a temporary supplier until the owner
-- knows whose it was). Kinds 'transfer_out' (−) / 'transfer_in' (+):
--
--   supplier_credits.related_supplier_id / _name  the other side of a transfer
--
-- supplier_credits.kind is varchar(16) with no check constraint, so the new
-- 'advance' / 'transfer_*' kinds need no DDL.
ALTER TABLE "cash_movements" ADD COLUMN IF NOT EXISTS "supplier_id" varchar(36);
ALTER TABLE "cash_movements" ADD COLUMN IF NOT EXISTS "supplier_name" varchar(255);
ALTER TABLE "supplier_credits" ADD COLUMN IF NOT EXISTS "related_supplier_id" varchar(36);
ALTER TABLE "supplier_credits" ADD COLUMN IF NOT EXISTS "related_supplier_name" varchar(255);
