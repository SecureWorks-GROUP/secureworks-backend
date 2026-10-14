-- Runs after supabase/rollbacks/20261013100000_context_call_cap_setting_down.sql on the stack
-- applied through this case: the seven readers are back word for word and read the caps from
-- the bare policy, the wrapper and the column are gone, the bounds are 1,000 again, and the
-- day's cap is 1,000 whatever the settings row says. Every fixture write is rolled back.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'call cap setting rollback contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rb_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;
CREATE FUNCTION pg_temp.rb_calls(p_n integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM public.context_model_call_reservations WHERE run_date = pg_temp.rb_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  SELECT pg_temp.rb_today(), g, 'bucket', now() FROM generate_series(1, p_n) g;
END $$;
CREATE FUNCTION pg_temp.rb_lanes() RETURNS void LANGUAGE sql AS $$
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1 $$;

DO $restored$
DECLARE x record; live text; c text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', '25a5b5f208af726d47e952f98cecef56'),
  ('public.context_ledger_budget()', '8f7b42529db2e1062283de005cef01a7'),
  ('public.context_jobs_cadence(uuid[])', 'c711479690d167f09d016f0413f11160'),
  ('public.context_document_vision_admission()', 'f1d33b0f0ee54516941ee313cb7fe756'),
  ('public.context_job_story_budget()', 'bd32ab0faece36527b05abdce0474f47'),
  ('public.context_cadence_status()', '85e60d754e65b812b28e798435e2a5a4'),
  ('public.context_core_status()', '2b6b2c54daeae381cdeff7802d72df81')) AS t(sig, want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  PERFORM pg_temp.rb_assert(live IS NOT DISTINCT FROM x.want, format('%s md5 %s is not the earlier body', x.sig, coalesce(live, '<missing>')));
  PERFORM pg_temp.rb_assert(NOT has_function_privilege('anon', x.sig, 'EXECUTE') AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE')
   AND has_function_privilege('service_role', x.sig, 'EXECUTE'), x.sig || ' access wrong');
 END LOOP;
 PERFORM pg_temp.rb_assert(to_regprocedure('public.context_cadence_policy_today()') IS NULL, 'the wrapper is still there');
 PERFORM pg_temp.rb_assert(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%context_cadence_policy_today%'),
  'a function still calls the wrapper');
 PERFORM pg_temp.rb_assert(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_ledger_settings'
   AND column_name = 'read_concurrency'), 'read_concurrency is still there');
 PERFORM pg_temp.rb_assert((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass
   AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ordinal%') = 'CHECK (((ordinal >= 1) AND (ordinal <= 1000)))', 'the ordinal check is not back to 1,000');
 PERFORM pg_temp.rb_assert((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.context_ledger_settings'::regclass
   AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%calls_per_day%') = 'CHECK (((calls_per_day >= 0) AND (calls_per_day <= 1000)))',
  'the calls_per_day check is not back to 1,000');
 c := obj_description('public.context_ledger_settings'::regclass, 'pg_class');
 PERFORM pg_temp.rb_assert(c LIKE '%0 to 1000; the live reserve still applies.%' AND c NOT LIKE '%context_cadence_policy_today%' AND c NOT LIKE '%read_concurrency%',
  'the settings comment is not the earlier one');
 PERFORM pg_temp.rb_assert((public.context_cadence_policy() ->> 'model_call_cap')::integer = 1000 AND (public.context_cadence_policy() ->> 'morning_cap')::integer = 750,
  'the policy moved');
END $restored$;

-- The day ends at call 1,000 again and the bounds refuse anything larger.
BEGIN;
DO $c$
DECLARE r jsonb;
BEGIN
 PERFORM pg_temp.rb_lanes();
 PERFORM pg_temp.rb_calls(999);
 r := public.reserve_context_model_call('bucket', NULL, NULL);
 PERFORM pg_temp.rb_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1000, 'call 1,000 after the rollback: ' || r::text);
 PERFORM pg_temp.rb_assert(public.reserve_context_model_call('bucket', NULL, NULL) = '{"outcome":"cap"}', 'call 1,001 after the rollback must answer cap');
 BEGIN
  UPDATE public.context_ledger_settings SET calls_per_day = 1001;
  RAISE EXCEPTION 'call cap setting rollback contract: calls_per_day of 1,001 was stored after the rollback';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.rb_today() - 1, 1001, 'bucket', now());
  RAISE EXCEPTION 'call cap setting rollback contract: a reservation numbered 1,001 was stored after the rollback';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $c$;
ROLLBACK;

-- A day that used a raise: the migration re-applies over its rollback, the setting goes to 1,500
-- and 1,200 calls are made. Rolled back again, the rows and the setting stay, both CHECKs come
-- back NOT VALID and still refuse a new row past 1,000, and the cap is 1,000 again. The migration
-- then re-applies over that.
BEGIN;
\ir ../../../migrations/20261013100000_context_call_cap_setting.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_lanes();
 PERFORM pg_temp.rb_assert(public.context_cadence_policy_today() = public.context_cadence_policy(), 'the migration re-applies over its rollback');
 UPDATE public.context_ledger_settings SET calls_per_day = 1500;
 PERFORM pg_temp.rb_calls(1200);
 PERFORM pg_temp.rb_assert((public.reserve_context_model_call('bucket', NULL, NULL) ->> 'ordinal')::integer = 1201, 'call 1,201 under the raise');
END $c$;
\ir ../../../rollbacks/20261013100000_context_call_cap_setting_down.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_assert((SELECT count(*) FROM public.context_model_call_reservations WHERE run_date = pg_temp.rb_today()) = 1201,
  'the rollback deleted reservations');
 PERFORM pg_temp.rb_assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND NOT convalidated
   AND pg_get_constraintdef(oid) = 'CHECK (((ordinal >= 1) AND (ordinal <= 1000))) NOT VALID'), 'the ordinal CHECK must come back NOT VALID over rows past 1,000');
 PERFORM pg_temp.rb_assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_ledger_settings'::regclass AND NOT convalidated
   AND pg_get_constraintdef(oid) = 'CHECK (((calls_per_day >= 0) AND (calls_per_day <= 1000))) NOT VALID')
  AND (SELECT calls_per_day FROM public.context_ledger_settings WHERE id) = 1500, 'the calls_per_day CHECK must come back NOT VALID over a 1,500 setting');
 PERFORM pg_temp.rb_assert(public.reserve_context_model_call('bucket', NULL, NULL) = '{"outcome":"cap"}', 'the cap must be 1,000 again past 1,201 calls');
 BEGIN
  INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.rb_today() + 1, 1001, 'bucket', now());
  RAISE EXCEPTION 'call cap setting rollback contract: a NOT VALID CHECK let a new 1,001 in';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $c$;
\ir ../../../migrations/20261013100000_context_call_cap_setting.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND convalidated
   AND pg_get_constraintdef(oid) = 'CHECK (((ordinal >= 1) AND (ordinal <= 3000)))')
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_ledger_settings'::regclass AND convalidated
   AND pg_get_constraintdef(oid) = 'CHECK (((calls_per_day >= 0) AND (calls_per_day <= 3000)))')
  AND (public.reserve_context_model_call('bucket', NULL, NULL) ->> 'ordinal')::integer = 1202, 'the migration re-applies over a NOT VALID rollback');
END $c$;
ROLLBACK;
