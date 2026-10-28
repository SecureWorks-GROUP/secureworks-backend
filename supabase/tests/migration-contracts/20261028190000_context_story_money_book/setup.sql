-- Prerequisites for 20261028190000_context_story_money_book: nothing new. The saved job story
-- (20261009100000), the job profit engine (20261009130000, 20261019120000), the job work orders
-- (20261012130000), Bills to place (20260705000010 and later) and the client sign-offs come from
-- earlier registered cases. This check fails early, and by name, if one is missing.
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.jobs', 'public.context_job_story_texts', 'public.context_job_story_requests', 'public.v_job_profit',
   'public.v_job_cost_events', 'public.v_job_revenue_events', 'public.materials_reconciliation_queue', 'public.job_materials_facts',
   'public.trade_invoices', 'public.trade_invoice_lines', 'public.purchase_orders', 'public.work_orders', 'public.job_client_signoffs',
   'public.xero_projects', 'public.xero_invoices'] LOOP
  IF to_regclass(f) IS NULL THEN RAISE EXCEPTION 'story money book setup: % is missing from the registered stack', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_job_story_text_get(uuid,jsonb,boolean)', 'public.context_job_story_enqueue_changed(integer)',
   'public.context_job_story_writer_input(uuid)', 'public.context_job_story_day(date,date)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'story money book setup: % is missing from the registered stack', f; END IF;
 END LOOP;
 IF to_regprocedure('public.context_job_story_book(uuid,timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'story money book setup: the book exists before the migration';
 END IF;
END $$;
