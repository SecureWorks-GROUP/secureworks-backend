-- Rollback contract for 20261006060000_context_call_budget_1000: the runner
-- applied the stack through this case, then the down file. Every body is the
-- pre-image byte for byte, the policy answers K1's numbers with live_since
-- untouched, the comments and CHECKs are as they were, and the old budget
-- refuses call 401 again. Then: a day that used the larger budget keeps its
-- rows (the ordinal CHECK comes back NOT VALID and still refuses a new 401),
-- and the migration re-applies over its own rollback.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'call budget rollback contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rb_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;

DO $c$
DECLARE pre public.call_budget_contract_preimage; x record; live text; pol jsonb := public.context_cadence_policy();
BEGIN
 SELECT * INTO pre FROM public.call_budget_contract_preimage;
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', '28545c710b6234b76ba25eb09093fa39'),
  ('public.context_ledger_budget()', '1584094b4240c206d05e12469e068c33'),
  ('public.context_document_vision_policy()', 'd56417f7977b5eb229417e2e03525a72'),
  ('public.context_document_vision_admission()', '4366041d73165b1562c1af304a7534b3'),
  ('public.context_core_status()', 'e26a2d4387c9f642f473aa16caf4ab98')) AS t(sig, md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = to_regprocedure(x.sig);
  PERFORM pg_temp.rb_assert(live = x.md5, format('%s not restored (md5 %s)', x.sig, live));
 END LOOP;
 -- The policy: K1's exact text again (live_since included), so its numbers too.
 PERFORM pg_temp.rb_assert((SELECT prosrc FROM pg_proc WHERE oid = 'public.context_cadence_policy()'::regprocedure) = pre.policy_src,
  'the policy text is not K1''s again');
 PERFORM pg_temp.rb_assert(pol = pre.policy AND (pol ->> 'model_call_cap')::integer = 400 AND (pol ->> 'morning_cap')::integer = 300
  AND (pol ->> 'attribution_calls_day')::integer = 60, 'the policy numbers: ' || pol::text);
 PERFORM pg_temp.rb_assert(public.context_document_vision_policy() = pre.vision_policy, 'the vision policy is not the pre-image');
 -- The comments, as production carried them before (md5s read read-only, 6 Oct 2026).
 PERFORM pg_temp.rb_assert(md5(obj_description('public.reserve_context_model_call(text,uuid,uuid)'::regprocedure, 'pg_proc')) = '1c3628e0b11dbfa3fe2ba7afc5240896'
  AND md5(obj_description('public.context_ledger_budget()'::regprocedure, 'pg_proc')) = '70b78e2b30b9ec49f2e723b5c87b3299'
  AND md5(obj_description('public.context_cadence_policy()'::regprocedure, 'pg_proc')) = 'e65169b30a2e861d50391aa9c5191db1'
  AND md5(obj_description('public.context_core_status()'::regprocedure, 'pg_proc')) = '51bf6c74c4640f4679e664013b3689c9'
  AND obj_description('public.context_document_vision_policy()'::regprocedure, 'pg_proc') IS NULL
  AND md5(obj_description('public.context_ledger_settings'::regclass, 'pg_class')) = '89de02f6f8de0bd1f1d1b3148d672f21'
  AND md5(col_description('public.context_ledger_settings'::regclass, (SELECT attnum FROM pg_attribute
   WHERE attrelid = 'public.context_ledger_settings'::regclass AND attname = 'live_reserve_calls'))) = 'ef8c8c171863181a8a6d243f04bfc7df'
  AND md5(col_description('public.context_ledger_settings'::regclass, (SELECT attnum FROM pg_attribute
   WHERE attrelid = 'public.context_ledger_settings'::regclass AND attname = 'live_reserve_calls_morning'))) = '785ce440dbc82e5c839eb673ef90a7f7',
  'a comment was not restored');
 -- The CHECKs are back to 400, validated (no row passed 400 here).
 PERFORM pg_temp.rb_assert((SELECT string_agg(pg_get_constraintdef(oid), ' | ' ORDER BY conname COLLATE "C") FROM pg_constraint
   WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ordinal%')
  = 'CHECK (((ordinal >= 1) AND (ordinal <= 400)))', 'the ordinal CHECK');
 PERFORM pg_temp.rb_assert((SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.context_ledger_settings'::regclass AND contype = 'c' AND convalidated
   AND pg_get_constraintdef(oid) IN ('CHECK (((calls_per_day >= 0) AND (calls_per_day <= 400)))',
    'CHECK (((live_reserve_calls >= 50) AND (live_reserve_calls <= 400)))',
    'CHECK (((live_reserve_calls_morning >= 50) AND (live_reserve_calls_morning <= 400)))')) = 3, 'the ledger settings CHECKs');
 -- Grants as before.
 FOR x IN SELECT unnest(ARRAY['public.reserve_context_model_call(text,uuid,uuid)', 'public.context_ledger_budget()',
   'public.context_document_vision_policy()', 'public.context_document_vision_admission()', 'public.context_core_status()',
   'public.context_cadence_policy()']) AS sig LOOP
  PERFORM pg_temp.rb_assert(NOT has_function_privilege('anon', x.sig, 'EXECUTE') AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE')
   AND has_function_privilege('service_role', x.sig, 'EXECUTE'), x.sig || ' grants');
 END LOOP;
END $c$;

-- The old budget refuses call 401 again, and the heartbeat says 400.
BEGIN;
DO $c$
DECLARE r jsonb;
BEGIN
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
 DELETE FROM public.context_model_call_reservations WHERE run_date = pg_temp.rb_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  SELECT pg_temp.rb_today(), g, 'bucket', now() FROM generate_series(1, 400) g;
 r := public.reserve_context_model_call('bucket', NULL, NULL);
 PERFORM pg_temp.rb_assert(r = '{"outcome":"cap"}', 'call 401 after the rollback: ' || r::text);
 PERFORM pg_temp.rb_assert((public.context_core_status() ->> 'model_call_cap')::integer = 400
  AND (public.context_core_status() ->> 'run_cap')::integer = 400, 'the heartbeat after the rollback');
 DELETE FROM public.context_model_call_reservations WHERE run_date = pg_temp.rb_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  SELECT pg_temp.rb_today(), g, 'attribution', now() FROM generate_series(1, 60) g;
 r := public.reserve_context_model_call('attribution', NULL, NULL);
 PERFORM pg_temp.rb_assert(r ->> 'outcome' = 'attribution_budget' AND (r ->> 'limit')::integer = 60, 'placement after the rollback: ' || r::text);
 BEGIN
  INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.rb_today() - 1, 401, 'bucket', now());
  RAISE EXCEPTION 'call budget rollback contract: a reservation numbered 401 was stored after the rollback';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $c$;
ROLLBACK;

-- A day that used the larger budget: its rows stay, the CHECK comes back NOT
-- VALID and still refuses a new 401; the migration then re-applies over it.
BEGIN;
\ir ../../../migrations/20261006060000_context_call_budget_1000.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_assert((public.context_cadence_policy() ->> 'model_call_cap')::integer = 1000, 'the migration re-applies over its rollback');
 DELETE FROM public.context_model_call_reservations WHERE run_date = pg_temp.rb_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
  SELECT pg_temp.rb_today(), g, 'bucket', now() FROM generate_series(1, 450) g;
 UPDATE public.context_ledger_settings SET calls_per_day = 600;
END $c$;
\ir ../../../rollbacks/20261006060000_context_call_budget_1000_down.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_assert((SELECT count(*) FROM public.context_model_call_reservations WHERE run_date = pg_temp.rb_today()) = 450,
  'the rollback deleted reservations');
 PERFORM pg_temp.rb_assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND NOT convalidated
   AND pg_get_constraintdef(oid) = 'CHECK (((ordinal >= 1) AND (ordinal <= 400))) NOT VALID'), 'the ordinal CHECK must come back NOT VALID over rows past 400');
 PERFORM pg_temp.rb_assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_ledger_settings'::regclass AND NOT convalidated
   AND pg_get_constraintdef(oid) = 'CHECK (((calls_per_day >= 0) AND (calls_per_day <= 400))) NOT VALID')
  AND (SELECT calls_per_day FROM public.context_ledger_settings WHERE id) = 600, 'the ledger ceiling CHECK must come back NOT VALID over a 600 setting');
 PERFORM pg_temp.rb_assert(public.reserve_context_model_call('bucket', NULL, NULL) = '{"outcome":"cap"}', 'the old cap past 450 calls');
 BEGIN
  INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at) VALUES (pg_temp.rb_today() + 1, 401, 'bucket', now());
  RAISE EXCEPTION 'call budget rollback contract: a NOT VALID CHECK let a new 401 in';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $c$;
\ir ../../../migrations/20261006060000_context_call_budget_1000.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND convalidated
   AND pg_get_constraintdef(oid) = 'CHECK (((ordinal >= 1) AND (ordinal <= 1000)))')
  AND (public.reserve_context_model_call('bucket', NULL, NULL) ->> 'ordinal')::integer = 451, 'the migration re-applies over a NOT VALID rollback');
END $c$;
ROLLBACK;
