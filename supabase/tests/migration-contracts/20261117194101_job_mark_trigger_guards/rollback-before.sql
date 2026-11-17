-- Exercise rollback with both split update triggers actually installed.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['business_events','xero_invoices','context_ledger_items','context_ledger_generations','job_documents','email_events','job_assignments','job_events','jobs','job_materials_facts','trade_invoice_lines','work_orders','purchase_orders','job_client_signoffs'] LOOP
  IF to_regclass('public.'||t) IS NOT NULL THEN CONTINUE; END IF;
  EXECUTE format('CREATE TABLE public.%I(id uuid PRIMARY KEY,job_id uuid,status text,attribution_status text,
   person_locked boolean,what text,due_date date,completed_at timestamptz,sent_at timestamptz,
   updated_at timestamptz,created_at timestamptz,synced_at timestamptz,last_synced_at timestamptz,
   raw_json jsonb,amount_paid numeric)',t);
 END LOOP;
END $$;
SELECT public.job_change_mark_triggers_install();

-- Test-only pg_cron API; no real scheduler exists in the disposable database.
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text);
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $stub$
 WITH d AS (DELETE FROM cron.job WHERE jobid=$1 RETURNING 1) SELECT EXISTS (SELECT 1 FROM d)
$stub$;
INSERT INTO cron.job(jobname) VALUES ('job-pages-refresh'),('job-pages-nightly'),('unrelated-contract-timer');
