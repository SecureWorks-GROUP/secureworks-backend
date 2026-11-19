-- Same one-send reads as the decision, amid unrelated history.
SET LOCAL session_replication_role=replica;
INSERT INTO public.trade_invoices(org_id,user_id,invoice_number,week_start,week_end,total_hours,status,send_id,
 subtotal_ex,gst,total_inc,gst_on,super_rate,super_amount,gross_earned,net_pay)
SELECT gen_random_uuid(),gen_random_uuid(),'ZZTEST-0510-PLAN-'||n,'2026-11-23','2026-11-29',0,'pending_ops_review',
 gen_random_uuid(),0,0,0,false,.12,0,0,0 FROM generate_series(1,3000) n;
INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,line_total_ex,sent_amount_ex)
SELECT id,'other',0,0 FROM public.trade_invoices WHERE invoice_number LIKE 'ZZTEST-0510-PLAN-%';
ANALYZE public.trade_invoices;
ANALYZE public.trade_invoice_lines;
DO $$ DECLARE target public.trade_invoices; target_line uuid; plan jsonb; q text; BEGIN
 SELECT * INTO STRICT target FROM public.trade_invoices WHERE invoice_number='ZZTEST-0510-PLAN-1';
 SELECT id INTO STRICT target_line FROM public.trade_invoice_lines WHERE trade_invoice_id=target.id;
 FOREACH q IN ARRAY ARRAY[
  format('SELECT l.* FROM public.trade_invoice_lines l JOIN public.trade_invoices i ON i.id=l.trade_invoice_id
          WHERE l.id=%L AND i.org_id=%L FOR UPDATE OF l',target_line,target.org_id),
  format('SELECT * FROM public.trade_invoices WHERE send_id=%L AND invoice_kind=''follow_on''
          AND pay_run_id IS NULL AND xero_bill_id IS NULL AND status=''pending_ops_review'' FOR UPDATE',target.send_id),
  format('SELECT sum(line_total_ex) FROM public.trade_invoice_lines WHERE trade_invoice_id=%L',target.id),
  format('SELECT 1 FROM public.trade_invoices i JOIN public.trade_invoice_lines l ON l.trade_invoice_id=i.id
          WHERE i.send_id=%L AND (l.sent_amount_ex IS NULL OR l.line_total_ex IS NULL)',target.send_id)
 ] LOOP
   EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) '||q INTO plan;
   PERFORM pg_temp.check_true(NOT jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Seq Scan")') AND
     jsonb_path_exists(plan,'$.** ? (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Index Scan")')
     AND NOT jsonb_path_exists(plan,'$.** ? (@."Actual Rows" > 10 || @."Rows Removed by Filter" > 10)'),'indexed send or line lookup');
 END LOOP;
END $$;
