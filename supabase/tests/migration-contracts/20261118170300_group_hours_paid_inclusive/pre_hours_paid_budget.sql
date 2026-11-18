-- Byte copy of group_work_order_hours_paid_budget from 20261106160000, for an
-- isolated local proof only (CI already holds it from the registered stack).
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
