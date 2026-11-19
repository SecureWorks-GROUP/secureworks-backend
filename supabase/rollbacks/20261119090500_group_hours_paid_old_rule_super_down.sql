-- Rollback for 20261119090500: restore group_work_order_hours_paid_total's
-- body from 20261106160000 and drop the company-super helper. Refuses when
-- either live body is neither this migration's nor the original, so a later
-- change is never undone blind. After this, an inclusive group again takes
-- old-rule hourly pay off its pot at the gross only (20261118170300).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE v_md5 text;
/* block */ BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.group_work_order_hours_paid_total(uuid,text)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('83c3347b2d203e623886089a488481c9', '88c6927c03ef2485b10d76859c6cf160') THEN
    RAISE EXCEPTION 'p1_13_4b_rollback_mismatch: group_work_order_hours_paid_total(uuid,text) (%)',
      coalesce(v_md5, 'missing');
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.group_work_order_hours_paid_company_super(uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '9d912a362656e6d1a4458d5bca519f73' THEN
    RAISE EXCEPTION 'p1_13_4b_rollback_mismatch: group_work_order_hours_paid_company_super(uuid) (%)', v_md5;
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.group_work_order_hours_paid_total(p_job uuid, p_basis text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(sum(public.group_work_order_hours_paid_budget(p_basis, h.gross_ex)), 0)
  FROM public.group_work_order_hours_paid(p_job) h;
$$;

DROP FUNCTION IF EXISTS public.group_work_order_hours_paid_company_super(uuid);
