-- Contract for 20261105120000_debt_ws_receivables.sql. Every fixture write is inside a
-- transaction that rolls back.

-- 1. The terms columns, their defaults and the seed: MLB (canonical contact) 10 days,
--    Ambrose Construct Group 14 days, every other company 10.
DO $$
DECLARE
  r record;
BEGIN
  SELECT company_terms, company_terms_default INTO r FROM public.debt_ws_settings WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: the settings row is missing';
  END IF;
  IF r.company_terms_default IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'contract: the default company terms are % days, expected 10', r.company_terms_default;
  END IF;
  IF (r.company_terms ->> '96abb9b3-89d5-4021-8880-ce9e8c4f1a91') IS DISTINCT FROM '10'
     OR (r.company_terms ->> 'eb7bc4e3-d7c1-41a6-99e1-723452c6e497') IS DISTINCT FROM '14' THEN
    RAISE EXCEPTION 'contract: the seed is %, expected MLB 10 and Ambrose 14', r.company_terms;
  END IF;
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'debt_ws_settings'
         AND column_name = 'company_terms') IS NULL
     OR (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'debt_ws_settings'
         AND column_name = 'company_terms_default') <> 'NO' THEN
    RAISE EXCEPTION 'contract: the terms columns lost their default or NOT NULL';
  END IF;
END $$;

-- 2. The checks refuse terms that are not whole days from 0 to 120, a key that is not
--    lower case, a non-object, and a default out of range.
DO $$
DECLARE
  bad jsonb;
  refused boolean;
BEGIN
  FOREACH bad IN ARRAY ARRAY[
    '{"eb7bc4e3-d7c1-41a6-99e1-723452c6e497": 14.5}'::jsonb,
    '{"eb7bc4e3-d7c1-41a6-99e1-723452c6e497": -1}'::jsonb,
    '{"eb7bc4e3-d7c1-41a6-99e1-723452c6e497": 121}'::jsonb,
    '{"eb7bc4e3-d7c1-41a6-99e1-723452c6e497": "14"}'::jsonb,
    '{"EB7BC4E3-D7C1-41A6-99E1-723452C6E497": 14}'::jsonb,
    '{"": 14}'::jsonb,
    '[14]'::jsonb
  ] LOOP
    refused := false;
    BEGIN
      UPDATE public.debt_ws_settings SET company_terms = bad WHERE id = 1;
    EXCEPTION WHEN check_violation THEN
      refused := true;
    END;
    IF NOT refused THEN
      RAISE EXCEPTION 'contract: company_terms accepted %', bad;
    END IF;
  END LOOP;
  refused := false;
  BEGIN
    UPDATE public.debt_ws_settings SET company_terms_default = 121 WHERE id = 1;
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'contract: company_terms_default accepted 121';
  END IF;
END $$;

-- 3. The write path: security definer with a fixed search_path, for the service role only.
DO $$
DECLARE
  f record;
BEGIN
  SELECT p.prosecdef, p.proconfig INTO f
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.debt_ws_set_company_terms(text, integer, text)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract: debt_ws_set_company_terms is missing';
  END IF;
  IF NOT f.prosecdef OR NOT ('search_path=public, pg_temp' = ANY (f.proconfig)) THEN
    RAISE EXCEPTION 'contract: the terms write path must be security definer with a fixed search_path (%)', f.proconfig;
  END IF;
  IF has_function_privilege('anon', 'public.debt_ws_set_company_terms(text, integer, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.debt_ws_set_company_terms(text, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the company terms write path is executable by anon or authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.debt_ws_set_company_terms(text, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the service role cannot change company terms';
  END IF;
END $$;

-- 4. Setting, changing and clearing one company's terms: one key at a time, lower-cased,
--    the other companies untouched, updated_by recorded; bad input refused.
BEGIN;
DO $$
DECLARE
  r record;
  refused boolean;
BEGIN
  SELECT * INTO r FROM public.debt_ws_set_company_terms(
    ' C0000000-0000-4000-8000-0000000000B1 ', 21, 'owner-user');
  IF (r.company_terms ->> 'c0000000-0000-4000-8000-0000000000b1') IS DISTINCT FROM '21'
     OR (r.company_terms ->> 'eb7bc4e3-d7c1-41a6-99e1-723452c6e497') IS DISTINCT FROM '14'
     OR (r.company_terms ->> '96abb9b3-89d5-4021-8880-ce9e8c4f1a91') IS DISTINCT FROM '10'
     OR r.company_terms_default <> 10 THEN
    RAISE EXCEPTION 'contract: setting a company returned %', row_to_json(r);
  END IF;
  IF (SELECT updated_by FROM public.debt_ws_settings WHERE id = 1) IS DISTINCT FROM 'owner-user' THEN
    RAISE EXCEPTION 'contract: the change did not record who made it';
  END IF;

  PERFORM public.debt_ws_set_company_terms('eb7bc4e3-d7c1-41a6-99e1-723452c6e497', 30, 'owner-user');
  IF (SELECT company_terms ->> 'eb7bc4e3-d7c1-41a6-99e1-723452c6e497' FROM public.debt_ws_settings WHERE id = 1)
       IS DISTINCT FROM '30' THEN
    RAISE EXCEPTION 'contract: changing Ambrose did not take';
  END IF;

  SELECT * INTO r FROM public.debt_ws_set_company_terms('c0000000-0000-4000-8000-0000000000b1', NULL, 'owner-user');
  IF r.company_terms ? 'c0000000-0000-4000-8000-0000000000b1'
     OR (r.company_terms ->> 'eb7bc4e3-d7c1-41a6-99e1-723452c6e497') IS DISTINCT FROM '30' THEN
    RAISE EXCEPTION 'contract: clearing a company returned %', row_to_json(r);
  END IF;

  refused := false;
  BEGIN
    PERFORM public.debt_ws_set_company_terms('c0000000-0000-4000-8000-0000000000b1', 121, 'owner-user');
  EXCEPTION WHEN invalid_parameter_value THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'contract: 121 days was accepted';
  END IF;
  refused := false;
  BEGIN
    PERFORM public.debt_ws_set_company_terms('  ', 10, 'owner-user');
  EXCEPTION WHEN invalid_parameter_value THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'contract: an empty company key was accepted';
  END IF;
END $$;
ROLLBACK;

-- 5. The words follow the new time, and report_auto_send is still off.
DO $$
BEGIN
  IF col_description('public.debt_ws_settings'::regclass,
       (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.debt_ws_settings'::regclass
          AND attname = 'report_auto_send')::integer) NOT LIKE '%Wednesday 2pm (14:00 Perth)%'
     OR obj_description('public.trigger_debt_ws_report_auto()'::regprocedure, 'pg_proc')
          NOT LIKE '%Wed 14:00 Perth%'
     OR obj_description('public.trigger_debt_ws_report_refresh()'::regprocedure, 'pg_proc')
          NOT LIKE '%Wed 13:55 Perth%' THEN
    RAISE EXCEPTION 'contract: the report comments still name 12:00';
  END IF;
  IF EXISTS (SELECT 1 FROM public.debt_ws_settings WHERE id = 1 AND report_auto_send) THEN
    RAISE EXCEPTION 'contract: report_auto_send was switched on';
  END IF;
END $$;

-- 6. Re-applying keeps a value changed on the tab and adds nothing twice.
BEGIN;
SELECT public.debt_ws_set_company_terms('eb7bc4e3-d7c1-41a6-99e1-723452c6e497', 21, 'owner-user');
\ir ../../../migrations/20261105120000_debt_ws_receivables.sql
DO $$
BEGIN
  IF (SELECT company_terms ->> 'eb7bc4e3-d7c1-41a6-99e1-723452c6e497' FROM public.debt_ws_settings WHERE id = 1)
       IS DISTINCT FROM '21' THEN
    RAISE EXCEPTION 'contract: re-applying undid a terms change';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.debt_ws_settings'::regclass
         AND conname IN ('debt_ws_settings_company_terms_valid',
                         'debt_ws_settings_company_terms_default_range')) <> 2 THEN
    RAISE EXCEPTION 'contract: re-applying changed the terms checks';
  END IF;
END $$;
ROLLBACK;

-- 7. The schedules, on a pg_cron stand-in holding the Wednesday 12:00 jobs: both move in
--    place to 14:00 and 13:55 Perth with their commands unchanged, re-applying changes
--    nothing, and the rollback puts 12:00 and 11:55 back.
BEGIN;
\ir cron_stand_in.sql
CREATE TEMP TABLE contract_noon_jobs AS SELECT jobid, jobname FROM cron.job;
\ir ../../../migrations/20261105120000_debt_ws_receivables.sql
\ir ../../../migrations/20261105120000_debt_ws_receivables.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job) <> 2 THEN
    RAISE EXCEPTION 'contract: re-apply scheduled twice %', (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
  IF (SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'debt-ws-report-auto')
       <> '0 6 * * 3 SELECT public.trigger_debt_ws_report_auto()'
     OR (SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'debt-ws-report-refresh')
       <> '55 5 * * 3 SELECT public.trigger_debt_ws_report_refresh()' THEN
    RAISE EXCEPTION 'contract: the report is not on Wednesday 14:00 with the 13:55 refresh %',
      (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
  IF EXISTS (SELECT 1 FROM contract_noon_jobs n
              WHERE n.jobid IS DISTINCT FROM
                    (SELECT j.jobid FROM cron.job j WHERE j.jobname = n.jobname)) THEN
    RAISE EXCEPTION 'contract: a report job was replaced, not moved in place';
  END IF;
END $$;
\ir ../../../rollbacks/20261105120000_debt_ws_receivables_down.sql
DO $$
BEGIN
  IF (SELECT schedule FROM cron.job WHERE jobname = 'debt-ws-report-auto') IS DISTINCT FROM '0 4 * * 3'
     OR (SELECT schedule FROM cron.job WHERE jobname = 'debt-ws-report-refresh') IS DISTINCT FROM '55 3 * * 3' THEN
    RAISE EXCEPTION 'contract: the rollback did not restore 12:00 %', (SELECT jsonb_agg(row_to_json(j)) FROM cron.job j);
  END IF;
END $$;
ROLLBACK;

-- 8. Missing jobs are scheduled fresh at the new times.
BEGIN;
\ir cron_stand_in.sql
DELETE FROM cron.job;
\ir ../../../migrations/20261105120000_debt_ws_receivables.sql
DO $$
BEGIN
  IF (SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'debt-ws-report-auto')
       IS DISTINCT FROM '0 6 * * 3 SELECT public.trigger_debt_ws_report_auto()'
     OR (SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'debt-ws-report-refresh')
       IS DISTINCT FROM '55 5 * * 3 SELECT public.trigger_debt_ws_report_refresh()' THEN
    RAISE EXCEPTION 'contract: missing report jobs were not scheduled at 14:00 and 13:55';
  END IF;
END $$;
ROLLBACK;
