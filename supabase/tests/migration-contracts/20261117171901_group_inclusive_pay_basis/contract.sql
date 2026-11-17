BEGIN;
\ir fixture.sql
DO $$
DECLARE grp uuid; pay jsonb; projected jsonb; inv uuid; refused boolean;
BEGIN
  pay := public.group_work_order_pay_for_basis('inclusive_12_112_v1',672);
  IF (pay->>'invoice_ex')::numeric IS DISTINCT FROM 672 OR (pay->>'super_amount')::numeric IS DISTINCT FROM 72
     OR (pay->>'cash_pay')::numeric IS DISTINCT FROM 600 OR (pay->>'budget_remainder')::numeric IS DISTINCT FROM 0
     OR (pay->>'company_contribution')::numeric IS DISTINCT FROM 0 OR (pay->>'company_total_out')::numeric IS DISTINCT FROM 672 THEN
    RAISE EXCEPTION 'ZZTEST inclusive share pay differs from spec test 15';
  END IF;
  pay := public.group_work_order_pay_for_basis('inclusive_12_112_v1',1000);
  IF (pay->>'super_amount')::numeric IS DISTINCT FROM 107.14 OR (pay->>'cash_pay')::numeric IS DISTINCT FROM 892.86 THEN
    RAISE EXCEPTION 'ZZTEST inclusive share rounding differs';
  END IF;
  pay := public.group_work_order_pay_for_basis('all_in_12_v2',672);
  IF (pay->>'invoice_ex')::numeric IS DISTINCT FROM 600 OR (pay->>'cash_pay')::numeric IS DISTINCT FROM 600
     OR (pay->>'super_amount')::numeric IS DISTINCT FROM 72 OR (pay->>'company_contribution')::numeric IS DISTINCT FROM 72 THEN
    RAISE EXCEPTION 'ZZTEST legacy employer share changed';
  END IF;
  grp := pg_temp.zztest_group_fixture();
  projected := public.freeze_group_work_order_split(grp);
  IF (SELECT array_agg((s->>'share_ex')::numeric ORDER BY s->>'user_id') FROM jsonb_array_elements(projected->'shares') s)
       IS DISTINCT FROM ARRAY[672,336,1232]::numeric[] THEN
    RAISE EXCEPTION 'ZZTEST inclusive projected shares differ';
  END IF;
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES('00000000-0000-0000-0000-000000000001','f1171901-0000-4000-8000-000000000002','pending_acknowledgment',672,672,0,672,false,.12,72,600,'inclusive_12_112_v1','ZZTEST-P4-I') RETURNING id INTO inv;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
    VALUES(inv,'f1171901-0000-4000-8000-000000000101','group share',672);
  IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id=inv AND group_share_id IS NOT NULL AND line_total_ex=672) THEN
    RAISE EXCEPTION 'ZZTEST inclusive group share was not bound';
  END IF;
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES('00000000-0000-0000-0000-000000000001','f1171901-0000-4000-8000-000000000002','pending_acknowledgment',672,672,0,672,false,.12,80.64,672,'employer_12_v2','ZZTEST-P4-WRONG') RETURNING id INTO inv;
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex)
      VALUES(inv,'f1171901-0000-4000-8000-000000000101','group share',672);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM='group_super_basis_mismatch'; END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST inclusive group accepted an employer invoice'; END IF;
END $$;
SELECT 'PASS: P1-13.1 inclusive pay, exact shares and invoice basis guard' AS result;
ROLLBACK;
