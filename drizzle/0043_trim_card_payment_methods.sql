-- Drop the bank-card sub-brands as seeded system methods: they were noise in
-- the till and settings. Naqd, Karta and Click remain. Custom methods (any
-- non-system row a business created) are untouched. Past orders keep their
-- payment code snapshot, so this is safe.
DELETE FROM "payment_methods"
WHERE "type" = 'system'
  AND "code" IN ('uzcard', 'humo', 'visa', 'mastercard', 'unionpay');
