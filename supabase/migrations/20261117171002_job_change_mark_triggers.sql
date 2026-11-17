-- P0-02.2: mark only meaningful record changes, including both sides of a job move.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.job_mark_changed_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_source text := TG_ARGV[0];
 v_col text := coalesce(TG_ARGV[1], 'job_id');
 v_new jsonb; v_old jsonb; v_new_id uuid; v_old_id uuid;
 c_skip constant text[] := ARRAY['updated_at','created_at','synced_at','last_synced_at','raw_json'];
BEGIN
 IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); v_new_id := nullif(v_new ->> v_col, '')::uuid; END IF;
 IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); v_old_id := nullif(v_old ->> v_col, '')::uuid; END IF;
 IF TG_OP = 'UPDATE' AND (v_new - c_skip) IS NOT DISTINCT FROM (v_old - c_skip) THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME = 'xero_invoices' AND TG_OP = 'UPDATE'
    AND ((v_new ->> 'status') IS DISTINCT FROM (v_old ->> 'status')
      OR (v_new ->> 'amount_paid') IS DISTINCT FROM (v_old ->> 'amount_paid')) THEN
  v_source := 'payment';
 END IF;
 PERFORM public.job_mark_changed(v_new_id, v_source);
 IF v_old_id IS DISTINCT FROM v_new_id THEN PERFORM public.job_mark_changed(v_old_id, v_source); END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.job_mark_changed_trg() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_mark_changed_trg() TO service_role;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'business_events' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_business_events ON public.business_events;
  CREATE TRIGGER job_mark_changed_business_events
   AFTER INSERT OR DELETE OR UPDATE OF job_id, attribution_status ON public.business_events FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('message');
 ELSE
  RAISE NOTICE 'job change marks: public.business_events.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'context_ledger_items' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_context_ledger_items ON public.context_ledger_items;
  CREATE TRIGGER job_mark_changed_context_ledger_items
   AFTER INSERT OR DELETE OR UPDATE OF status, person_locked, what, due_date ON public.context_ledger_items FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('notes');
 ELSE
  RAISE NOTICE 'job change marks: public.context_ledger_items.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'context_ledger_generations' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_context_ledger_generations ON public.context_ledger_generations;
  CREATE TRIGGER job_mark_changed_context_ledger_generations
   AFTER INSERT OR UPDATE OF status ON public.context_ledger_generations FOR EACH ROW
   WHEN (NEW.status = 'live')
   EXECUTE FUNCTION public.job_mark_changed_trg('notes');
 ELSE
  RAISE NOTICE 'job change marks: public.context_ledger_generations.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'xero_invoices' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_xero_invoices ON public.xero_invoices;
  CREATE TRIGGER job_mark_changed_xero_invoices
   AFTER INSERT OR UPDATE OR DELETE ON public.xero_invoices FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('invoice');
 ELSE
  RAISE NOTICE 'job change marks: public.xero_invoices.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_documents' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_documents ON public.job_documents;
  CREATE TRIGGER job_mark_changed_job_documents
   AFTER INSERT OR UPDATE OR DELETE ON public.job_documents FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('document');
 ELSE
  RAISE NOTICE 'job change marks: public.job_documents.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'email_events' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_email_events ON public.email_events;
  CREATE TRIGGER job_mark_changed_email_events
   AFTER INSERT OR UPDATE OF status, sent_at ON public.email_events FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('document');
 ELSE
  RAISE NOTICE 'job change marks: public.email_events.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_assignments' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_assignments ON public.job_assignments;
  CREATE TRIGGER job_mark_changed_job_assignments
   AFTER INSERT OR UPDATE OR DELETE ON public.job_assignments FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('booking');
 ELSE
  RAISE NOTICE 'job change marks: public.job_assignments.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_events' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_events ON public.job_events;
  CREATE TRIGGER job_mark_changed_job_events
   AFTER INSERT ON public.job_events FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('status');
 ELSE
  RAISE NOTICE 'job change marks: public.job_events.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_jobs ON public.jobs;
  CREATE TRIGGER job_mark_changed_jobs
   AFTER UPDATE OF status, completed_at ON public.jobs FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('status', 'id');
 ELSE
  RAISE NOTICE 'job change marks: public.jobs.id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_materials_facts' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_materials_facts ON public.job_materials_facts;
  CREATE TRIGGER job_mark_changed_job_materials_facts
   AFTER INSERT OR UPDATE OR DELETE ON public.job_materials_facts FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('bill');
 ELSE
  RAISE NOTICE 'job change marks: public.job_materials_facts.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'trade_invoice_lines' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_trade_invoice_lines ON public.trade_invoice_lines;
  CREATE TRIGGER job_mark_changed_trade_invoice_lines
   AFTER INSERT OR UPDATE OR DELETE ON public.trade_invoice_lines FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('crew_line');
 ELSE
  RAISE NOTICE 'job change marks: public.trade_invoice_lines.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'work_orders' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_work_orders ON public.work_orders;
  CREATE TRIGGER job_mark_changed_work_orders
   AFTER INSERT OR UPDATE OR DELETE ON public.work_orders FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('work_order');
 ELSE
  RAISE NOTICE 'job change marks: public.work_orders.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_purchase_orders ON public.purchase_orders;
  CREATE TRIGGER job_mark_changed_purchase_orders
   AFTER INSERT OR UPDATE OR DELETE ON public.purchase_orders FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('order');
 ELSE
  RAISE NOTICE 'job change marks: public.purchase_orders.job_id absent, trigger skipped';
 END IF;
END $trigger$;

DO $trigger$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_client_signoffs' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_client_signoffs ON public.job_client_signoffs;
  CREATE TRIGGER job_mark_changed_job_client_signoffs
   AFTER INSERT ON public.job_client_signoffs FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('signoff');
 ELSE
  RAISE NOTICE 'job change marks: public.job_client_signoffs.job_id absent, trigger skipped';
 END IF;
END $trigger$;
