BEGIN;
DO $$
DECLARE pay jsonb;
BEGIN
  pay := public.group_work_order_pay_for_basis('all_in_12_v2',672);
  IF (pay->>'invoice_ex')::numeric IS DISTINCT FROM 600 OR (pay->>'super_amount')::numeric IS DISTINCT FROM 72 THEN
    RAISE EXCEPTION 'ZZTEST rollback changed legacy employer pay';
  END IF;
  BEGIN
    PERFORM public.group_work_order_pay_for_basis('inclusive_12_112_v1',672);
    RAISE EXCEPTION 'ZZTEST rollback retained inclusive pay';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'group_pay_basis_unsupported' THEN RAISE; END IF;
  END;
END $$;
SELECT 'PASS: P1-13.1 rollback restores legacy pay' AS result;
ROLLBACK;
