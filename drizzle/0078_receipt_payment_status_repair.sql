-- Supplier receipts: recompute payment_status with returns counted.
--
-- Idempotent; safe to re-run, before or after deploying the backend. Data only
-- — no schema change.
--
-- Why: adding a payment rolled the status from what was PAID alone, while a
-- return rolled it from paid + RETURNED. A receipt settled partly by goods sent
-- back and partly by money could read 'partial' with nothing owed, depending
-- on which of the two happened last. The backend now always counts both; this
-- brings the rows already written into line. Compared in whole cents, as the
-- backend does.

UPDATE goods_receipts AS gr
SET payment_status = fixed.status
FROM (
  SELECT
    id,
    CASE
      WHEN round((paid_amount + returned_amount) * 100) <= 0 THEN 'unpaid'
      WHEN round((paid_amount + returned_amount) * 100) >= round(total_amount * 100) THEN 'paid'
      ELSE 'partial'
    END AS status
  FROM goods_receipts
) AS fixed
WHERE gr.id = fixed.id
  AND gr.payment_status IS DISTINCT FROM fixed.status;

-- Read-only check, run on its own afterwards: receipts already paid past what
-- they owe, from before overpayment was refused. Nothing here fixes them —
-- each is a real payment that left an account; cancel the extra one from the
-- receipt page if it was a mistake.
--
-- SELECT id, business_id, supplier_name, currency,
--        total_amount, paid_amount, returned_amount,
--        paid_amount + returned_amount - total_amount AS overpaid
-- FROM goods_receipts
-- WHERE paid_amount + returned_amount > total_amount
-- ORDER BY overpaid DESC;
