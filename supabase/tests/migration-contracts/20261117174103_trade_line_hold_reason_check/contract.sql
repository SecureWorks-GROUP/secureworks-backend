BEGIN;
DO $$ DECLARE invoice_id uuid; reason text; refused_by text;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    ('ee410300-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST crew','crew');
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay)
    VALUES('00000000-0000-0000-0000-000000000001','ee410300-0000-4000-8000-000000000001','draft',1000,1000,0,1000,false,.12,120,940) RETURNING id INTO invoice_id;
  FOREACH reason IN ARRAY ARRAY[NULL,'no_work_order','no_amount','over_amount','hourly_no_maximum','no_job','not_job_work','reimbursement','not_on_crew','commission_no_figure','rate_above_rule']::text[] LOOP
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex,office_review_status,hold_reason)
      VALUES(invoice_id,'adjustment',1,'awaiting',reason);
  END LOOP;
  BEGIN
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex,office_review_status,hold_reason)
      VALUES(invoice_id,'adjustment',1,'awaiting','ZZTEST unknown reason');
    RAISE EXCEPTION 'ZZTEST unknown hold reason accepted on pre-existing column';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS refused_by=CONSTRAINT_NAME;
    IF refused_by<>'trade_invoice_lines_hold_reason_check' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
SELECT 'PASS: existing hold_reason column admits the ten reasons and refuses an unknown reason' AS result;
