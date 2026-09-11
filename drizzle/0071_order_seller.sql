-- Credit a sale to a salesperson ("sotuvchi") picked at the register.
--
-- `cashier_id` is the account that rang the sale up and stays accountable for
-- the drawer and the shift. In many shops the person who actually sold the
-- goods (the floor consultant) is someone else — often a staff record with no
-- login at all. `seller_id` records that person; `seller_name` is a snapshot
-- so reports survive renames and deletions, same as `cashier_name`.
--
-- Both nullable: every existing row (and every sale where nobody is picked)
-- keeps crediting the cashier, because readers use COALESCE(seller, cashier).
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "seller_id" varchar(36);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "seller_name" varchar(255);
