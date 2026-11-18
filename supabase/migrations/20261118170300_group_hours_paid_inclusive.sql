-- P1-13.4 (director ruling (b), 18 Nov 2026): the pot an hourly payment uses
-- up, for a group on the inclusive basis (inclusive_12_112_v1, P1-13.1).
--
-- group_work_order_hours_paid_budget (20261106160000) knew only gross_v1,
-- all_in_12_6_v1 and all_in_12_v2 and raised group_pay_basis_unsupported for
-- any other basis. Since P1-13.4 a new group opened while the pay rule
-- applies is inclusive, so without this branch such a group on a job where
-- anyone was paid by the hour could not price, freeze, release or confirm its
-- split (write_split, release_state and the claim confirm all read it).
--
-- Inclusive: super sits inside the amount, so a payment uses up its gross,
-- the same as group_work_order_pay_for_basis's company_total_out for that
-- basis. The function receives the gross only, not the basis the hourly
-- invoice was priced on; an hourly invoice priced on employer_12_v2 before the
-- rule's start date is therefore counted at its gross here (12% less than it
-- cost). Every other basis is unchanged, byte for byte.
--
-- Replaces one function only: no table, trigger, schedule, switch or row
-- write.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Rule 15 pre-image guard: the body on main (20261106160000), or this file's
-- own body on a re-apply. Anything else refuses.
DO $guard$
DECLARE v_md5 text;
/* block */ BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.group_work_order_hours_paid_budget(text,numeric)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('ae305a17368f5384daed0b778b00ab26', '63d2b0cfe4356ee9fbd6b363304d9b56') THEN
    RAISE EXCEPTION 'p1_13_4_preimage_mismatch: group_work_order_hours_paid_budget(text,numeric) (%)',
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
  ELSIF p_basis = 'inclusive_12_112_v1' THEN
    -- P1-13.4: super inside the amount; the payment uses up its gross.
    RETURN v_gross / 100.0;
  END IF;
  RAISE EXCEPTION 'group_pay_basis_unsupported';
END;
$$;

REVOKE ALL ON FUNCTION public.group_work_order_hours_paid_budget(text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_hours_paid_budget(text, numeric) TO service_role;
