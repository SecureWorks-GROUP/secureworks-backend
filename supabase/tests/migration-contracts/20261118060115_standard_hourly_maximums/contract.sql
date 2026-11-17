BEGIN;
SET LOCAL statement_timeout = '120s';
\ir ../../../migrations/20261118060115_standard_hourly_maximums.sql
DO $test$
DECLARE
  actor uuid := '00000000-0000-0000-0000-000000000517';
  org uuid := '00000000-0000-0000-0000-000000000518';
  answer jsonb;
BEGIN
  IF EXISTS (SELECT FROM public.standard_hourly_maximums)
     OR EXISTS (SELECT FROM public.standard_hourly_maximum_changes) THEN
    RAISE EXCEPTION 'ZZTEST: settings and history must ship empty';
  END IF;
  INSERT INTO public.users(id, org_id, name, role) VALUES (actor, org, 'ZZTEST approver', 'trade');
  UPDATE public.trade_pay_settings SET pay_run_approver_user_ids = ARRAY[actor] WHERE id = 1;
  BEGIN
    PERFORM public.set_standard_hourly_maximum(org, 'ZZTEST', 10, 56.00, '00000000-0000-0000-0000-000000000519');
    RAISE EXCEPTION 'ZZTEST: non-approver accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'pay_setting_not_approver' THEN RAISE; END IF;
  END;
  answer := public.set_standard_hourly_maximum(org, 'ZZTEST', 10, 56.00, actor);
  IF (answer->>'max_hours')::numeric <> 10 OR (answer->>'rate_ex')::numeric <> 56.00
     OR (SELECT count(*) FROM public.standard_hourly_maximums WHERE org_id = org AND job_type = 'ZZTEST' AND set_by = actor) <> 1
     OR (SELECT count(*) FROM public.standard_hourly_maximum_changes WHERE org_id = org AND job_type = 'ZZTEST' AND from_hours IS NULL AND to_hours = 10 AND from_rate_ex IS NULL AND to_rate_ex = 56.00 AND changed_by = actor) <> 1 THEN
    RAISE EXCEPTION 'ZZTEST: initial row and audit do not agree';
  END IF;
  PERFORM public.set_standard_hourly_maximum(org, 'ZZTEST', 16, 56.00, actor);
  IF (SELECT max_hours FROM public.standard_hourly_maximums WHERE org_id = org AND job_type = 'ZZTEST') <> 16
     OR (SELECT count(*) FROM public.standard_hourly_maximum_changes) <> 2
     OR NOT EXISTS (SELECT FROM public.standard_hourly_maximum_changes WHERE from_hours = 10 AND to_hours = 16 AND from_rate_ex = 56.00 AND to_rate_ex = 56.00) THEN
    RAISE EXCEPTION 'ZZTEST: changed hours lost their previous value';
  END IF;
  BEGIN
    PERFORM public.set_standard_hourly_maximum(org, 'ZZTEST', NULL, 56.00, actor);
    RAISE EXCEPTION 'ZZTEST: one null figure accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'standard_maximum_needs_both' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.set_standard_hourly_maximum(org, 'ZZTEST', 16, NULL, actor);
    RAISE EXCEPTION 'ZZTEST: other null figure accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'standard_maximum_needs_both' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.set_standard_hourly_maximum(org, 'ZZTEST', 0, 56.00, actor);
    RAISE EXCEPTION 'ZZTEST: zero hours accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM public.standard_hourly_maximum_changes) <> 2
     OR (SELECT max_hours FROM public.standard_hourly_maximums WHERE org_id = org AND job_type = 'ZZTEST') <> 16 THEN
    RAISE EXCEPTION 'ZZTEST: refusal changed settings or history';
  END IF;
  answer := public.set_standard_hourly_maximum(org, 'ZZTEST', NULL, NULL, actor);
  IF answer <> '{"cleared":true}'::jsonb OR EXISTS (SELECT FROM public.standard_hourly_maximums)
     OR (SELECT count(*) FROM public.standard_hourly_maximum_changes) <> 3
     OR NOT EXISTS (SELECT FROM public.standard_hourly_maximum_changes WHERE from_hours = 16 AND from_rate_ex = 56.00 AND to_hours IS NULL AND to_rate_ex IS NULL) THEN
    RAISE EXCEPTION 'ZZTEST: clear did not preserve history';
  END IF;
  BEGIN
    UPDATE public.standard_hourly_maximum_changes SET job_type = 'ZZTEST changed';
    RAISE EXCEPTION 'ZZTEST: history update accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'standard_maximum_changes_append_only' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.standard_hourly_maximum_changes;
    RAISE EXCEPTION 'ZZTEST: history delete accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'standard_maximum_changes_append_only' THEN RAISE; END IF;
  END;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.standard_hourly_maximums'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.standard_hourly_maximum_changes'::regclass)
     OR NOT has_table_privilege('service_role', 'public.standard_hourly_maximums', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.standard_hourly_maximum_changes', 'SELECT')
     OR has_table_privilege('service_role', 'public.standard_hourly_maximums', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'public.standard_hourly_maximum_changes', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.standard_hourly_maximums', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.standard_hourly_maximum_changes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_function_privilege('authenticated', 'public.set_standard_hourly_maximum(uuid,text,numeric,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_standard_hourly_maximum(uuid,text,numeric,numeric,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.set_standard_hourly_maximum(uuid,text,numeric,numeric,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST: privileges widened';
  END IF;
END $test$;
-- The rollback and its readback stay inside this transaction, preserving
-- every later migration's database surface for the next registered case.
\ir ../../../rollbacks/20261118060115_standard_hourly_maximums_down.sql
DO $rollback_test$ BEGIN
  IF to_regclass('public.standard_hourly_maximums') IS NOT NULL
     OR to_regclass('public.standard_hourly_maximum_changes') IS NOT NULL
     OR to_regprocedure('public.set_standard_hourly_maximum(uuid,text,numeric,numeric,uuid)') IS NOT NULL
     OR EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'public.work_orders'::regclass AND attname = 'standard_max_hours' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'ZZTEST: rollback left its surface behind';
  END IF;
END $rollback_test$;
ROLLBACK;
\echo PASS standard hourly maximum contract
