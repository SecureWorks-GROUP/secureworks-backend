-- Rollback for 20261118170300: restore group_work_order_hours_paid_budget's
-- body from 20261106160000 (no inclusive branch). Refuses when the live body is
-- neither this migration's nor the original, so a later change is never undone
-- blind. After this, an inclusive group on a job with hourly pay refuses its
-- split again (group_pay_basis_unsupported).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE v_md5 text;
/* block */ BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.group_work_order_hours_paid_budget(text,numeric)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('63d2b0cfe4356ee9fbd6b363304d9b56', 'ae305a17368f5384daed0b778b00ab26') THEN
    RAISE EXCEPTION 'p1_13_4_rollback_mismatch: group_work_order_hours_paid_budget(text,numeric) (%)',
      coalesce(v_md5, 'missing');
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.group_work_order_hours_paid_budget(p_basis text, p_gross_ex numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE v_gross bigint;
BEGIN
  IF p_gross_ex IS NULL OR p_gross_ex <= 0 THEN RETURN 0; END IF;
  v_gross := round(p_gross_ex * 100)::bigint;
  IF p_basis = 'gross_v1' THEN
    RETURN v_gross / 100.0;
  ELSIF p_basis = 'all_in_12_6_v1' THEN
    RETURN (v_gross + round(v_gross * .12)::bigint - round(v_gross * .06)::bigint) / 100.0;
  ELSIF p_basis = 'all_in_12_v2' THEN
    RETURN (v_gross + round(v_gross * .12)::bigint) / 100.0;
  END IF;
  RAISE EXCEPTION 'group_pay_basis_unsupported';
END;
$$;
