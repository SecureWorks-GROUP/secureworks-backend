-- The registered predecessors supply the cutover marker, both cost readers, the
-- trade sync triggers' functions, the bills twin and the mirror rule.
DO $setup$ BEGIN
 IF to_regclass('public.job_cost_events_cutover') IS NULL
  OR to_regclass('public.v_job_cost_events_lines') IS NULL
  OR to_regclass('public.v_job_cost_events_legacy') IS NULL
  OR to_regprocedure('public.job_cost_lines_install_trade_triggers()') IS NULL
  OR to_regprocedure('public.job_cost_lines_bill_document(uuid,jsonb,boolean)') IS NULL
  OR to_regprocedure('public.trade_invoice_bill_mirror_verdicts(uuid,text[])') IS NULL
  OR to_regclass('public.xero_supplier_credit_notes') IS NULL THEN
  RAISE EXCEPTION 'P2-01.8 cutover prerequisites missing';
 END IF;
END $setup$;
