-- After the down migration the view is back to the earlier lanes, with the
-- same output columns, and its dependents still read it.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.users (id, org_id, name) VALUES
  ('a7f10000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'JP04 Rollback Trade');
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex,
                                   gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay) VALUES
  ('a7f20000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001',
   'a7f10000-0000-4000-8000-000000000002', '2026-08-03', 'approved', 1000,
   false, 0, 1000, 0.12, 120, 1000, 940);
INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, line_type, description, line_total_ex, line_date) VALUES
  ('a7f30000-0000-4000-8000-000000000010', 'a7f20000-0000-4000-8000-000000000002', 'work order', 'Work order pay', 1000, '2026-08-04');
DO $$
BEGIN
  IF (SELECT cost_lane FROM public.v_trade_charge_resolved
      WHERE line_id = 'a7f30000-0000-4000-8000-000000000010') IS DISTINCT FROM 'unclassified' THEN
    RAISE EXCEPTION 'jp04 rollback: work order pay must be unclassified again';
  END IF;
  PERFORM 1 FROM public.job_financials LIMIT 1;
  PERFORM 1 FROM public.v_job_cost_events LIMIT 1;
  PERFORM 1 FROM public.v_job_profit LIMIT 1;
END $$;
ROLLBACK;
