-- The 29 Oct all-in 12/6 basis, before the 30 Oct employer basis.
DO $$
DECLARE r jsonb;
BEGIN
  r := public.group_work_order_pay_for_basis('all_in_12_6_v1', 911.56);
  IF (r->>'invoice_ex')::numeric <> 859.96 OR (r->>'cash_pay')::numeric <> 808.36 OR (r->>'super_amount')::numeric <> 103.20 THEN
    RAISE EXCEPTION 'all-in 12/6 split changed: %', r;
  END IF;
END $$;
SELECT 'PASS: all-in 12/6 share 911.56 = 859.96 gross, 808.36 cash, 103.20 super' AS result;
