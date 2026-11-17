-- P1-13.1: admit the inclusive group basis without changing any existing group.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE public.group_work_orders DROP CONSTRAINT group_work_orders_pay_basis_check;
ALTER TABLE public.group_work_orders ADD CONSTRAINT group_work_orders_pay_basis_check
  CHECK (pay_basis IN ('gross_v1','all_in_12_6_v1','all_in_12_v2','inclusive_12_112_v1'));

CREATE OR REPLACE FUNCTION public.group_work_order_pay_for_basis(p_basis text, p_budget_ex numeric)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_budget bigint; v_gross bigint; v_super bigint; v_withhold bigint; v_cost bigint;
BEGIN
  IF p_budget_ex IS NULL OR p_budget_ex < 0 THEN RAISE EXCEPTION 'group_share_amount_invalid'; END IF;
  v_budget := round(p_budget_ex * 100)::bigint;
  IF p_basis = 'inclusive_12_112_v1' THEN
    v_super := round(v_budget::numeric * 12 / 112)::bigint;
    RETURN jsonb_build_object('pay_basis', p_basis, 'budget_ex', v_budget / 100.0,
      'invoice_ex', v_budget / 100.0, 'super_amount', v_super / 100.0,
      'cash_pay', (v_budget - v_super) / 100.0, 'company_contribution', 0,
      'company_total_out', v_budget / 100.0, 'budget_remainder', 0);
  END IF;
  IF p_basis = 'gross_v1' THEN
    v_gross := v_budget;
  ELSIF p_basis = 'all_in_12_6_v1' THEN
    v_gross := floor(v_budget::numeric / 1.06)::bigint;
    WHILE v_gross + round(v_gross * .12)::bigint - round(v_gross * .06)::bigint > v_budget LOOP v_gross := v_gross - 1; END LOOP;
    WHILE v_gross + 1 + round((v_gross + 1) * .12)::bigint - round((v_gross + 1) * .06)::bigint <= v_budget LOOP v_gross := v_gross + 1; END LOOP;
  ELSIF p_basis = 'all_in_12_v2' THEN
    -- Largest whole-cent gross whose gross plus 12% super fits the share.
    v_gross := floor(v_budget::numeric / 1.12)::bigint;
    WHILE v_gross + round(v_gross * .12)::bigint > v_budget LOOP v_gross := v_gross - 1; END LOOP;
    WHILE v_gross + 1 + round((v_gross + 1) * .12)::bigint <= v_budget LOOP v_gross := v_gross + 1; END LOOP;
  ELSE
    RAISE EXCEPTION 'group_pay_basis_unsupported';
  END IF;
  v_super := round(v_gross * .12)::bigint;
  v_withhold := CASE WHEN p_basis = 'all_in_12_6_v1' THEN round(v_gross * .06)::bigint ELSE 0 END;
  IF p_basis = 'gross_v1' THEN v_withhold := round(v_gross * .06)::bigint; END IF;
  v_cost := v_gross + v_super - v_withhold;
  RETURN jsonb_build_object('pay_basis', p_basis, 'budget_ex', v_budget / 100.0, 'invoice_ex', v_gross / 100.0,
    'cash_pay', (v_gross - v_withhold) / 100.0, 'super_amount', v_super / 100.0,
    'company_contribution', (v_super - v_withhold) / 100.0, 'company_total_out', v_cost / 100.0,
    'budget_remainder', CASE WHEN p_basis = 'gross_v1' THEN NULL ELSE (v_budget - v_cost) / 100.0 END);
END; $$;

DO $patch$
DECLARE
  body text := pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure);
  before_text text := $before$(v_basis = 'all_in_12_v2') IS DISTINCT FROM (v_invoice_basis IS NOT DISTINCT FROM 'employer_12_v2')$before$;
  after_text text := $after$(v_basis = 'all_in_12_v2') IS DISTINCT FROM (v_invoice_basis IS NOT DISTINCT FROM 'employer_12_v2')
       OR (v_basis = 'inclusive_12_112_v1') IS DISTINCT FROM (v_invoice_basis IS NOT DISTINCT FROM 'inclusive_12_112_v1')$after$;
  hits integer;
BEGIN
  IF strpos(body, after_text) > 0 THEN RETURN; END IF;
  hits := (length(body)-length(replace(body,before_text,'')))/length(before_text);
  IF hits <> 1 THEN RAISE EXCEPTION 'group inclusive basis guard expected one hit, found %',hits; END IF;
  EXECUTE replace(body,before_text,after_text);
END $patch$;
