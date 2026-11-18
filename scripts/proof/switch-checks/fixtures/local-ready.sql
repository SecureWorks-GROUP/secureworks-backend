-- LOCAL TEST FIXTURE ONLY. test-local.sh runs this against a disposable
-- localhost copy of the contract stack; never run it on any other database.
-- It writes: it installs the story book speed, the profit refresh triggers and
-- the stored story profit, refreshes one ZZTEST job, and seeds the draft
-- standard's rules and options for its organisation. Made-up values only.
\set ON_ERROR_STOP on
SET TimeZone = 'UTC';
SET statement_timeout = '60s';
SELECT public.install_context_story_book_speed();
\ir ../../../../supabase/tests/migration-contracts/20261118024514_context_story_book_speed/fixtures.sql
UPDATE public.jobs SET job_number = 'ZZTEST-PROOF-1' WHERE job_number = 'MB-1';

-- The profit refresh's 11 source triggers, from job_profit_refresh_install's
-- own statements (its pg_cron step is absent locally).
DO $c$ DECLARE m text[]; BEGIN
 FOR m IN SELECT regexp_matches(prosrc, '(CREATE TRIGGER job_profit_changed[^;]+ ON (public\.[a-z_]+)[^;]+;)', 'g')
          FROM pg_proc WHERE oid = 'public.job_profit_refresh_install()'::regprocedure LOOP
  EXECUTE 'DROP TRIGGER IF EXISTS job_profit_changed ON ' || m[2]; EXECUTE m[1];
 END LOOP;
END $c$;
INSERT INTO public.feature_flags(flag_name, enabled) VALUES ('job_profit_refresh_v1', true)
ON CONFLICT (flag_name) DO UPDATE SET enabled = true;
SELECT public.install_job_story_stored_profit();

-- A real change on the job before the refresh (stored check 11 reads it).
SELECT public.job_mark_changed(id, 'payment') FROM public.jobs WHERE job_number = 'ZZTEST-PROOF-1';
DELETE FROM public.job_profit_change_events WHERE job_id IS NOT NULL;
DELETE FROM public.job_profit_dirty WHERE job_id IS NOT NULL;
SELECT public.job_profit_refresh_many(ARRAY(SELECT id FROM public.jobs WHERE job_number = 'ZZTEST-PROOF-1'));

-- Draft standard for the ZZTEST organisation: a confirmed default rule per
-- source kind and every stock division option, freshly copied.
INSERT INTO public.xero_account_rules(org_id, source_kind, line_kind, account_code, confirmed_by, confirmed_at)
SELECT '00000000-0000-0000-0000-000000000001', k, 'default', '000', 'ZZTEST role', now()
FROM unnest(ARRAY['trade_invoice', 'expense_receipt', 'supplier_bill', 'supplier_credit']) k
ON CONFLICT DO NOTHING;
-- The migration seeds today's codes unconfirmed; the ready state has them confirmed.
UPDATE public.xero_account_rules SET confirmed_by = 'ZZTEST role', confirmed_at = now()
WHERE org_id = '00000000-0000-0000-0000-000000000001' AND confirmed_at IS NULL;
INSERT INTO public.xero_tracking_options(org_id, category_id, category_name, option_id, option_name, status, synced_at)
SELECT '00000000-0000-0000-0000-000000000001', 'ZZTEST-CAT', 'Business Unit', 'ZZTEST-OPT-' || n, name, 'ACTIVE', now()
FROM unnest(ARRAY['SW - PATIOS', 'SW - FENCING', 'SW - DECKING', 'SW - PRIVATE ROOFING', 'SW - MAKESAFE',
                  'SW - INSURANCE WORK', 'SW - RESTORATION', 'SW Group']) WITH ORDINALITY t(name, n)
ON CONFLICT DO NOTHING;

-- A stand-in for pg_cron's two catalog tables when the extension is absent,
-- holding the refresh's two jobs and one recent successful run.
DO $c$ BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  CREATE SCHEMA IF NOT EXISTS cron;
  CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean);
  CREATE TABLE cron.job_run_details (runid bigint PRIMARY KEY, jobid bigint, status text, end_time timestamptz);
  INSERT INTO cron.job VALUES (1, 'job-profit-refresh-marked', '* * * * *', 'select 1', true),
                              (2, 'job-profit-refresh-daily', '* * * * *', 'select 1', true);
  INSERT INTO cron.job_run_details VALUES (1, 1, 'succeeded', now()), (2, 2, 'succeeded', now());
 END IF;
END $c$;
