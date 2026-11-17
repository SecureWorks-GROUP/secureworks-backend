-- Real PostgreSQL install and trigger behavior, with a captured mark-writer boundary.
-- Existing mark-storage and append-writer contracts retain responsibility for durable storage.
BEGIN;
CREATE SCHEMA trigger_guard_saved;
CREATE TEMP TABLE trigger_marks(job_id uuid, source text);
CREATE OR REPLACE FUNCTION public.job_mark_changed(p_job_id uuid,p_source text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF p_job_id IS NOT NULL THEN INSERT INTO pg_temp.trigger_marks VALUES(p_job_id,p_source); END IF;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['business_events','xero_invoices','context_ledger_items','context_ledger_generations','job_documents','email_events','job_assignments','job_events','jobs','job_materials_facts','trade_invoice_lines','work_orders','purchase_orders','job_client_signoffs'] LOOP
  IF to_regclass('public.'||t) IS NOT NULL THEN
   EXECUTE format('ALTER TABLE public.%I SET SCHEMA trigger_guard_saved',t);
  END IF;
  EXECUTE format('CREATE TABLE public.%I(id uuid PRIMARY KEY,job_id uuid,status text,attribution_status text,
   person_locked boolean,what text,due_date date,completed_at timestamptz,sent_at timestamptz,
   updated_at timestamptz,created_at timestamptz,synced_at timestamptz,last_synced_at timestamptz,
   raw_json jsonb,amount_paid numeric)',t);
 END LOOP;
END $$;
CREATE FUNCTION pg_temp.expect_marks(want_source text, want_jobs uuid[]) RETURNS void
LANGUAGE plpgsql AS $$ DECLARE got uuid[]; BEGIN
 SELECT coalesce(array_agg(job_id ORDER BY job_id),'{}'::uuid[]) INTO got FROM pg_temp.trigger_marks;
 IF got IS DISTINCT FROM want_jobs OR EXISTS(SELECT 1 FROM pg_temp.trigger_marks WHERE source<>want_source) THEN
  RAISE EXCEPTION 'trigger guards: expected % %, got %', want_source,want_jobs,got;
 END IF;
 TRUNCATE pg_temp.trigger_marks;
END $$;
SELECT public.job_change_mark_triggers_install();
SELECT public.job_change_mark_triggers_install();
-- Every pre-existing install/remove grant remains private.
DO $$ BEGIN
 IF has_function_privilege('anon','public.job_change_mark_triggers_install()','EXECUTE')
 OR has_function_privilege('authenticated','public.job_change_mark_triggers_remove()','EXECUTE') THEN
  RAISE EXCEPTION 'trigger guards: private install/remove grant widened';
 END IF;
END $$;

-- business_events: insert, meaningful update, housekeeping, delete.
INSERT INTO public.business_events(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('message',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.business_events SET attribution_status='matched' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('message',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.business_events SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('message','{}'::uuid[]);
DELETE FROM public.business_events WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('message',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);

-- xero_invoices: insert, meaningful update, housekeeping, delete.
INSERT INTO public.xero_invoices(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('invoice',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.xero_invoices SET job_id='00000000-0000-4000-8000-000000000942'::uuid WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('invoice',ARRAY['00000000-0000-4000-8000-000000000941'::uuid,'00000000-0000-4000-8000-000000000942'::uuid]);
UPDATE public.xero_invoices SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('invoice','{}'::uuid[]);
DELETE FROM public.xero_invoices WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('invoice',ARRAY['00000000-0000-4000-8000-000000000942'::uuid]);

-- context_ledger_items: insert, meaningful update, housekeeping, delete.
INSERT INTO public.context_ledger_items(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('notes',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.context_ledger_items SET what='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('notes',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.context_ledger_items SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('notes','{}'::uuid[]);
DELETE FROM public.context_ledger_items WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('notes',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);

-- context_ledger_generations: insert, meaningful update, housekeeping, delete.
INSERT INTO public.context_ledger_generations(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('notes','{}'::uuid[]);
UPDATE public.context_ledger_generations SET status='live' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('notes',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.context_ledger_generations SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('notes','{}'::uuid[]);
UPDATE public.context_ledger_generations SET status='retired' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('notes','{}'::uuid[]);
DELETE FROM public.context_ledger_generations WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('notes','{}'::uuid[]);

-- job_documents: insert, meaningful update, housekeeping, delete.
INSERT INTO public.job_documents(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('document',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.job_documents SET status='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('document',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.job_documents SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('document','{}'::uuid[]);
DELETE FROM public.job_documents WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('document',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);

-- email_events: insert, meaningful update, housekeeping, delete.
INSERT INTO public.email_events(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('document',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.email_events SET status='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('document',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.email_events SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('document','{}'::uuid[]);
DELETE FROM public.email_events WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('document','{}'::uuid[]);

-- job_assignments: insert, meaningful update, housekeeping, delete.
INSERT INTO public.job_assignments(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('booking',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.job_assignments SET status='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('booking',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.job_assignments SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('booking','{}'::uuid[]);
DELETE FROM public.job_assignments WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('booking',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);

-- job_events: insert, meaningful update, housekeeping, delete.
INSERT INTO public.job_events(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('status',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.job_events SET status='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('status','{}'::uuid[]);
UPDATE public.job_events SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('status','{}'::uuid[]);
DELETE FROM public.job_events WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('status','{}'::uuid[]);

-- jobs: insert, meaningful update, housekeeping, delete.
INSERT INTO public.jobs(id,job_id,status) VALUES('00000000-0000-4000-8000-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('status','{}'::uuid[]);
UPDATE public.jobs SET status='complete' WHERE id='00000000-0000-4000-8000-000000000941';
SELECT pg_temp.expect_marks('status',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.jobs SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8000-000000000941';
SELECT pg_temp.expect_marks('status','{}'::uuid[]);
DELETE FROM public.jobs WHERE id='00000000-0000-4000-8000-000000000941';
SELECT pg_temp.expect_marks('status','{}'::uuid[]);

-- job_materials_facts: insert, meaningful update, housekeeping, delete.
INSERT INTO public.job_materials_facts(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('bill',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.job_materials_facts SET status='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('bill',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.job_materials_facts SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('bill','{}'::uuid[]);
DELETE FROM public.job_materials_facts WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('bill',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);

-- trade_invoice_lines: insert, meaningful update, housekeeping, delete.
INSERT INTO public.trade_invoice_lines(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('crew_line',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.trade_invoice_lines SET status='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('crew_line',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.trade_invoice_lines SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('crew_line','{}'::uuid[]);
DELETE FROM public.trade_invoice_lines WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('crew_line',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);

-- work_orders: insert, meaningful update, housekeeping, delete.
INSERT INTO public.work_orders(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('work_order',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.work_orders SET status='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('work_order',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.work_orders SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('work_order','{}'::uuid[]);
DELETE FROM public.work_orders WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('work_order',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);

-- purchase_orders: insert, meaningful update, housekeeping, delete.
INSERT INTO public.purchase_orders(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('order',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.purchase_orders SET status='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('order',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.purchase_orders SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('order','{}'::uuid[]);
DELETE FROM public.purchase_orders WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('order',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);

-- job_client_signoffs: insert, meaningful update, housekeeping, delete.
INSERT INTO public.job_client_signoffs(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','draft');
SELECT pg_temp.expect_marks('signoff',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.job_client_signoffs SET status='changed' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('signoff','{}'::uuid[]);
UPDATE public.job_client_signoffs SET updated_at='2026-11-17T00:00:00Z' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('signoff','{}'::uuid[]);
DELETE FROM public.job_client_signoffs WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('signoff','{}'::uuid[]);

INSERT INTO public.business_events(id,job_id) VALUES('00000000-0000-4000-8001-000000000941',NULL);
SELECT pg_temp.expect_marks('message','{}'::uuid[]);
UPDATE public.business_events SET job_id='00000000-0000-4000-8000-000000000941' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('message',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.business_events SET job_id='00000000-0000-4000-8000-000000000942' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('message',ARRAY['00000000-0000-4000-8000-000000000941'::uuid,'00000000-0000-4000-8000-000000000942'::uuid]);
UPDATE public.business_events SET job_id=NULL WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('message',ARRAY['00000000-0000-4000-8000-000000000942'::uuid]);

INSERT INTO public.xero_invoices(id,job_id,status) VALUES('00000000-0000-4000-8001-000000000941','00000000-0000-4000-8000-000000000941','DRAFT');
SELECT pg_temp.expect_marks('invoice',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.xero_invoices SET status='PAID' WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('payment',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);
UPDATE public.xero_invoices SET amount_paid=1 WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('payment',ARRAY['00000000-0000-4000-8000-000000000941'::uuid]);

-- A mark-only assertion cannot detect entry followed by the generic JSON no-op comparison.
-- Replace that comparison boundary with a tripwire: the WHEN must prevent entry entirely.
CREATE OR REPLACE FUNCTION public.job_mark_changed_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 RAISE EXCEPTION 'unchanged row entered trigger function';
END $$;
UPDATE public.business_events SET job_id=job_id,attribution_status=attribution_status WHERE id='00000000-0000-4000-8001-000000000941';
UPDATE public.xero_invoices SET status=status,job_id=job_id WHERE id='00000000-0000-4000-8001-000000000941';
SELECT pg_temp.expect_marks('invoice','{}'::uuid[]);

SELECT public.job_change_mark_triggers_remove();
SELECT public.job_change_mark_triggers_remove();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND t.tgname LIKE 'job_mark_changed_%' AND NOT t.tgisinternal) THEN
  RAISE EXCEPTION 'trigger guards: remove left an event or update trigger installed';
 END IF;
 RAISE NOTICE 'Trigger guards passed: 14 sources, unchanged-row tripwire, install/remove idempotence';
END $$;
ROLLBACK;
