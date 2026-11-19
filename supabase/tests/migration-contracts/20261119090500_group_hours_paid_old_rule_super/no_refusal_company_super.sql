-- The helper with the no-split refusal removed: a billed old-rule invoice
-- with no super record silently adds 0 (the guess the director ruled out).
CREATE OR REPLACE FUNCTION public.group_work_order_hours_paid_company_super(p_job uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_g bigint;
  v_total bigint := 0;
BEGIN
  FOR r IN
    SELECT i.id, i.super_basis, i.gross_earned, i.net_pay, i.super_amount, i.super_base_ex,
      sum(COALESCE(l.line_total_ex, 0)) AS gross_ex
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
    WHERE l.job_id = p_job
      AND i.user_id IS NOT NULL
      AND public.group_work_order_invoice_billed(i.status, i.xero_bill_id, i.xero_bill_status)
      AND public.group_work_order_line_is_paid_hours(l.line_type, l.source_work_order_id, l.description)
    GROUP BY i.id, i.super_basis, i.gross_earned, i.net_pay, i.super_amount, i.super_base_ex
  LOOP
    v_g := round(r.gross_ex * 100)::bigint;
    IF v_g <= 0 OR r.super_basis = 'inclusive_12_112_v1' THEN
      CONTINUE;
    ELSIF r.super_basis = 'employer_12_v2' THEN
      v_total := v_total + round(v_g * .12)::bigint;
    ELSIF r.super_basis IS NOT NULL THEN
      RAISE EXCEPTION 'group_pay_basis_unsupported';
    ELSIF r.gross_earned IS NULL THEN
      CONTINUE;
    ELSIF r.net_pay = round(r.gross_earned - round(COALESCE(r.super_base_ex, r.gross_earned) * 0.06, 2), 2) THEN
      v_total := v_total + round(v_g * .12)::bigint - round(v_g * .06)::bigint;
    ELSIF r.super_base_ex IS NULL AND r.net_pay = round(r.gross_earned - r.super_amount, 2) THEN
      CONTINUE;
    ELSE
      RAISE EXCEPTION 'group_hours_invoice_split_unknown: %', r.id;
    END IF;
  END LOOP;
  RETURN v_total / 100.0;
END;
$$;
