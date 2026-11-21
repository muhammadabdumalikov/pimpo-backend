-- More personal details on an employee card: home address, birthday, gender.
-- All three are optional and nullable, so existing rows and the still-running
-- old code are unaffected. Idempotent.

ALTER TABLE staff ADD COLUMN IF NOT EXISTS address varchar(255);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS birth_date date;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS gender varchar(10);
