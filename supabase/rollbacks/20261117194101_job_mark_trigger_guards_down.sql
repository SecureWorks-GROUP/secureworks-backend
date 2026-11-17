-- Remove the complete installed set, including split update triggers, before restoring definitions.
-- Director explicitly reinstalls the original set after rollback proof.
SET LOCAL lock_timeout = '5s';
SELECT public.job_change_mark_triggers_remove();

CREATE OR REPLACE FUNCTION public.job_change_mark_triggers_install() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $install$
BEGIN
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'business_events' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_business_events ON public.business_events;
  CREATE TRIGGER job_mark_changed_business_events
   AFTER INSERT OR DELETE OR UPDATE OF job_id, attribution_status ON public.business_events FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('message');
 ELSE
  RAISE EXCEPTION 'job change marks: public.business_events.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'context_ledger_items' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_context_ledger_items ON public.context_ledger_items;
  CREATE TRIGGER job_mark_changed_context_ledger_items
   AFTER INSERT OR DELETE OR UPDATE OF status, person_locked, what, due_date ON public.context_ledger_items FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('notes');
 ELSE
  RAISE EXCEPTION 'job change marks: public.context_ledger_items.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'context_ledger_generations' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_context_ledger_generations ON public.context_ledger_generations;
  CREATE TRIGGER job_mark_changed_context_ledger_generations
   AFTER INSERT OR UPDATE OF status ON public.context_ledger_generations FOR EACH ROW
   WHEN (NEW.status = 'live')
   EXECUTE FUNCTION public.job_mark_changed_trg('notes');
 ELSE
  RAISE EXCEPTION 'job change marks: public.context_ledger_generations.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'xero_invoices' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_xero_invoices ON public.xero_invoices;
  CREATE TRIGGER job_mark_changed_xero_invoices
   AFTER INSERT OR UPDATE OR DELETE ON public.xero_invoices FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('invoice');
 ELSE
  RAISE EXCEPTION 'job change marks: public.xero_invoices.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_documents' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_documents ON public.job_documents;
  CREATE TRIGGER job_mark_changed_job_documents
   AFTER INSERT OR UPDATE OR DELETE ON public.job_documents FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('document');
 ELSE
  RAISE EXCEPTION 'job change marks: public.job_documents.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'email_events' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_email_events ON public.email_events;
  CREATE TRIGGER job_mark_changed_email_events
   AFTER INSERT OR UPDATE OF status, sent_at ON public.email_events FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('document');
 ELSE
  RAISE EXCEPTION 'job change marks: public.email_events.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_assignments' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_assignments ON public.job_assignments;
  CREATE TRIGGER job_mark_changed_job_assignments
   AFTER INSERT OR UPDATE OR DELETE ON public.job_assignments FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('booking');
 ELSE
  RAISE EXCEPTION 'job change marks: public.job_assignments.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_events' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_events ON public.job_events;
  CREATE TRIGGER job_mark_changed_job_events
   AFTER INSERT ON public.job_events FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('status');
 ELSE
  RAISE EXCEPTION 'job change marks: public.job_events.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_jobs ON public.jobs;
  CREATE TRIGGER job_mark_changed_jobs
   AFTER UPDATE OF status, completed_at ON public.jobs FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('status', 'id');
 ELSE
  RAISE EXCEPTION 'job change marks: public.jobs.id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_materials_facts' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_materials_facts ON public.job_materials_facts;
  CREATE TRIGGER job_mark_changed_job_materials_facts
   AFTER INSERT OR UPDATE OR DELETE ON public.job_materials_facts FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('bill');
 ELSE
  RAISE EXCEPTION 'job change marks: public.job_materials_facts.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'trade_invoice_lines' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_trade_invoice_lines ON public.trade_invoice_lines;
  CREATE TRIGGER job_mark_changed_trade_invoice_lines
   AFTER INSERT OR UPDATE OR DELETE ON public.trade_invoice_lines FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('crew_line');
 ELSE
  RAISE EXCEPTION 'job change marks: public.trade_invoice_lines.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'work_orders' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_work_orders ON public.work_orders;
  CREATE TRIGGER job_mark_changed_work_orders
   AFTER INSERT OR UPDATE OR DELETE ON public.work_orders FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('work_order');
 ELSE
  RAISE EXCEPTION 'job change marks: public.work_orders.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_purchase_orders ON public.purchase_orders;
  CREATE TRIGGER job_mark_changed_purchase_orders
   AFTER INSERT OR UPDATE OR DELETE ON public.purchase_orders FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('order');
 ELSE
  RAISE EXCEPTION 'job change marks: public.purchase_orders.job_id absent, install refused';
 END IF;
END;

BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_client_signoffs' AND column_name = 'job_id') THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_client_signoffs ON public.job_client_signoffs;
  CREATE TRIGGER job_mark_changed_job_client_signoffs
   AFTER INSERT ON public.job_client_signoffs FOR EACH ROW
   EXECUTE FUNCTION public.job_mark_changed_trg('signoff');
 ELSE
  RAISE EXCEPTION 'job change marks: public.job_client_signoffs.job_id absent, install refused';
 END IF;
END;
END $install$;
REVOKE ALL ON FUNCTION public.job_change_mark_triggers_install() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_change_mark_triggers_install() TO service_role;

CREATE OR REPLACE FUNCTION public.job_change_mark_triggers_remove() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $remove$
BEGIN
BEGIN
 IF to_regclass('public.business_events') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_business_events ON public.business_events;
 END IF;
END;
BEGIN
 IF to_regclass('public.context_ledger_items') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_context_ledger_items ON public.context_ledger_items;
 END IF;
END;
BEGIN
 IF to_regclass('public.context_ledger_generations') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_context_ledger_generations ON public.context_ledger_generations;
 END IF;
END;
BEGIN
 IF to_regclass('public.xero_invoices') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_xero_invoices ON public.xero_invoices;
 END IF;
END;
BEGIN
 IF to_regclass('public.job_documents') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_documents ON public.job_documents;
 END IF;
END;
BEGIN
 IF to_regclass('public.email_events') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_email_events ON public.email_events;
 END IF;
END;
BEGIN
 IF to_regclass('public.job_assignments') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_assignments ON public.job_assignments;
 END IF;
END;
BEGIN
 IF to_regclass('public.job_events') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_events ON public.job_events;
 END IF;
END;
BEGIN
 IF to_regclass('public.jobs') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_jobs ON public.jobs;
 END IF;
END;
BEGIN
 IF to_regclass('public.job_materials_facts') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_materials_facts ON public.job_materials_facts;
 END IF;
END;
BEGIN
 IF to_regclass('public.trade_invoice_lines') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_trade_invoice_lines ON public.trade_invoice_lines;
 END IF;
END;
BEGIN
 IF to_regclass('public.work_orders') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_work_orders ON public.work_orders;
 END IF;
END;
BEGIN
 IF to_regclass('public.purchase_orders') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_purchase_orders ON public.purchase_orders;
 END IF;
END;
BEGIN
 IF to_regclass('public.job_client_signoffs') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_client_signoffs ON public.job_client_signoffs;
 END IF;
END;
END $remove$;
REVOKE ALL ON FUNCTION public.job_change_mark_triggers_remove() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_change_mark_triggers_remove() TO service_role;
