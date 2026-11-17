BEGIN;
-- Earlier contracts can restore older bodies. This case restores precisely
-- the main pre-image it tests, within this rolled-back transaction.
\ir ../../../migrations/20261102200000_context_coverage_counts_ledger.sql
CREATE TEMP TABLE fact_retirement_rows(job_id uuid PRIMARY KEY);
CREATE FUNCTION pg_temp.fact_retirement_rows_read() RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE AS $fixture$ BEGIN
  IF current_setting('test.fact_retired', true) = 'on' THEN
    RAISE EXCEPTION 'retired fact store was read';
  END IF;
  IF current_setting('test.fact_store_fault', true) = 'on' THEN
    RAISE EXCEPTION 'fixture fact store unavailable' USING ERRCODE = '58000';
  END IF;
  RETURN QUERY SELECT job_id FROM pg_temp.fact_retirement_rows;
END $fixture$;
-- Stub only the fact-source rows, not the coverage function. Preserve the
-- existing view's complete row type and restore it at the transaction end.
DO $view$ BEGIN
  EXECUTE 'CREATE OR REPLACE VIEW public.current_job_context_facts AS
    SELECT (jsonb_populate_record(NULL::public.current_job_context_facts,
      jsonb_build_object(''job_id'', f.job_id))).*
    FROM pg_temp.fact_retirement_rows_read() f(job_id)';
END $view$;
INSERT INTO public.feature_flags(flag_name, enabled, description)
VALUES ('context_fact_read_v1', true, 'Contract fixture')
ON CONFLICT (flag_name) DO UPDATE SET enabled = true;
INSERT INTO public.jobs(id, org_id, status, type, job_number) VALUES
 ('04f60000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','accepted','fencing','ZZTEST-4061'),
 ('04f60000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','accepted','fencing','ZZTEST-4062');
INSERT INTO pg_temp.fact_retirement_rows VALUES ('04f60000-0000-4000-8000-000000000001');
INSERT INTO public.context_ledger_generations
 (id, job_id, kind, status, reader, model, evidence_until, checks, created_at, finished_at, promoted_at, updated_at)
VALUES ('04f60000-0000-4000-8000-000000000003','04f60000-0000-4000-8000-000000000002',
 'backfill','live','contract','contract',now(),'{"passed":true}',now(),now(),now(),now());
CREATE TEMP TABLE coverage_main AS SELECT public.context_coverage() AS answer;
\if :{?test_legacy_coverage}
-- Local negative control: the same behavior assertions must fail on main.
\else
\ir ../../../migrations/20261118013038_context_coverage_fact_retirement.sql
\ir ../../../migrations/20261118013038_context_coverage_fact_retirement.sql
\endif
DO $contract$
DECLARE on_answer jsonb; off_answer jsonb; main_answer jsonb;
  failures integer := 0; section text; BEGIN
  SELECT answer INTO main_answer FROM pg_temp.coverage_main;
  on_answer := public.context_coverage();
  IF on_answer IS DISTINCT FROM main_answer THEN
    RAISE EXCEPTION 'coverage ON must equal main exactly';
  END IF;
  DELETE FROM public.feature_flags WHERE flag_name = 'context_fact_read_v1';
  IF public.context_coverage() IS DISTINCT FROM main_answer THEN
    RAISE EXCEPTION 'missing retirement switch changed main';
  END IF;
  -- Unreadable switch preserves main, rather than pretending retirement.
  ALTER TABLE public.feature_flags RENAME TO fact_retirement_unreadable_flags;
  IF public.context_coverage() IS DISTINCT FROM main_answer THEN
    RAISE EXCEPTION 'unreadable retirement switch changed main';
  END IF;
  ALTER TABLE public.fact_retirement_unreadable_flags RENAME TO feature_flags;
  INSERT INTO public.feature_flags(flag_name, enabled, description)
  VALUES ('context_fact_read_v1', false, 'Contract fixture');
  PERFORM set_config('test.fact_retired', 'on', true);
  off_answer := public.context_coverage();
  IF off_answer->>'facts_retired' IS DISTINCT FROM 'true'
    OR off_answer #>> '{jobs,sources,older_store}' IS DISTINCT FROM '0'
    OR off_answer #> '{jobs,sources,ledger_live}' IS DISTINCT FROM on_answer #> '{jobs,sources,ledger_live}' THEN
    RAISE EXCEPTION 'retired facts counted or live ledger coverage lost';
  END IF;
  FOREACH section IN ARRAY ARRAY['jobs', 'invoices'] LOOP
    IF off_answer #> ARRAY[section,'total'] IS DISTINCT FROM on_answer #> ARRAY[section,'total'] THEN
      RAISE EXCEPTION 'retirement changed the % population', section;
    END IF;
  END LOOP;
  IF (off_answer #>> '{jobs,with_current_fact}')::integer <> (on_answer #>> '{jobs,with_current_fact}')::integer - 1 THEN
    RAISE EXCEPTION 'old fact-only job still counted';
  END IF;
  -- Office changes are read on the next call; faults are still errors on
  -- repeated attempts, never false empty facts or a successful coverage read.
  PERFORM set_config('test.fact_retired', 'off', true);
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'context_fact_read_v1';
  DELETE FROM pg_temp.fact_retirement_rows;
  IF public.context_coverage() #> '{jobs,with_current_fact}' IS DISTINCT FROM off_answer #> '{jobs,with_current_fact}' THEN
    RAISE EXCEPTION 'office fact change was not observed';
  END IF;
  PERFORM set_config('test.fact_store_fault', 'on', true);
  FOR attempt IN 1..2 LOOP
    BEGIN
      PERFORM public.context_coverage();
    EXCEPTION WHEN SQLSTATE '58000' THEN failures := failures + 1;
    END;
  END LOOP;
  IF failures <> 2 THEN RAISE EXCEPTION 'fact source error or retry was hidden'; END IF;
  PERFORM set_config('test.fact_store_fault', 'off', true);
  IF public.context_coverage() #> '{jobs,with_current_fact}' IS DISTINCT FROM off_answer #> '{jobs,with_current_fact}' THEN
    RAISE EXCEPTION 'recovered read changed coverage';
  END IF;
  IF has_function_privilege('anon','public.context_fact_reads_on()','EXECUTE')
    OR has_function_privilege('authenticated','public.context_fact_reads_on()','EXECUTE')
    OR NOT has_function_privilege('service_role','public.context_fact_reads_on()','EXECUTE') THEN
    RAISE EXCEPTION 'retirement switch helper grants';
  END IF;
END $contract$;
\ir ../../../rollbacks/20261118013038_context_coverage_fact_retirement_down.sql
DO $rollback$
DECLARE restored text; BEGIN
 SELECT md5(prosrc) INTO restored FROM pg_proc WHERE oid = 'public.context_coverage()'::regprocedure;
 IF restored IS DISTINCT FROM 'dbee3427213fbaea92215aceb6187c00' THEN
   RAISE EXCEPTION 'rollback did not restore main coverage';
 END IF;
END $rollback$;
SELECT 'PASS: coverage retirement skips old facts, retains ledger, preserves ON/missing/unreadable, faults, retries and rollback' AS result;
ROLLBACK;
