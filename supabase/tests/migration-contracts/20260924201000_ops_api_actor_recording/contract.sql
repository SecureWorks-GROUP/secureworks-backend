-- F-ACT contract (INTEGRATION X31): server-key ops-api calls with no usable
-- actor counted per Perth day, the actor_missing count in the core status,
-- nothing refused, nothing widened, and every other heartbeat key unchanged.
--
-- The doors X31 names, as the ops-api edge code classifies them
-- (supabase/functions/_shared/request_actor.ts, ops-api/actor_calls.ts):
--   MCP tool or sw-axi on the server key, no x-sw-actor yet (today, before
--     F-ACT-RT), e.g. the B0 census door that sw_context_unlinked calls:
--     counted, one call each;
--   the make-safe automation on the routine key, no header: counted;
--   a malformed header: counted (no usable actor);
--   the same doors once F-ACT-RT sends x-sw-actor, and a signed-in Ops
--     browser (JWT): nothing is written.

-- F1's core body (production md5 3df30c5c...), byte for byte under another
-- name, so the new body can be compared with it on the same rows.
CREATE OR REPLACE FUNCTION pg_temp.f1_core_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d date:=(now() AT TIME ZONE 'Australia/Perth')::date; switches jsonb; queue jsonb; calls integer; call_state text:='available'; ready integer;
BEGIN
 SELECT to_jsonb(s) INTO switches FROM public.automation_switches s WHERE id=1;
 SELECT jsonb_object_agg(status,n) INTO queue FROM (SELECT coalesce(e.attribution_status,'unknown') status,count(*) n
 FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 GROUP BY e.attribution_status) q;
 BEGIN
  EXECUTE 'SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=$1' INTO calls USING d;
 EXCEPTION WHEN OTHERS THEN calls:=NULL;call_state:='unavailable'; END;
 ready:=public.context_ready_jobs_count(400);
 RETURN jsonb_build_object('as_of',now(),'run_date',d,'switches',switches,
  'lanes',jsonb_build_object('capture',public.automation_lane_enabled('capture'),'attribution',public.automation_lane_enabled('attribution'),'extraction',public.automation_lane_enabled('extraction')),
  'runs_used',(SELECT count(*) FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction'),'run_cap',400,
  'runs_by_status',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' GROUP BY status) s),
  'failed_by_error',(SELECT coalesce(jsonb_object_agg(coalesce(nullif(error,''),'(none)'),n),'{}'::jsonb) FROM (SELECT error,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' AND status='failed' GROUP BY error) s),
  'model_calls_used',calls,'model_call_cap',400,'model_call_budget_state',call_state,
  'evidence_by_attribution_status',coalesce(queue,'{}'::jsonb),'ready_jobs',ready,'ready_jobs_is_lower_bound',ready=400,
  'admin_bucket_size',(SELECT count(*) FROM public.business_events WHERE attribution_status='admin_bucket'),
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND occurred_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'oldest_pending_event_at',(SELECT min(coalesce(e.event_at, e.occurred_at)) FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated') AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')),
  'last_pass_finished_at',(SELECT max(finished_at) FROM public.context_pass_days WHERE status='done'),
  'today_pass',(SELECT to_jsonb(p) FROM public.context_pass_days p WHERE run_date=d),
  'coverage',public.context_coverage());
END $$;

-- 1. Shape, access and ownership.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')) IS DISTINCT FROM 'e26a2d4387c9f642f473aa16caf4ab98'
 THEN RAISE EXCEPTION 'f-act core body md5'; END IF;
 IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')),
    E'''coverage'',public.context_coverage(),\n  ''actor_missing'',public.context_actor_missing_status());',
    E'''coverage'',public.context_coverage());'))
    IS DISTINCT FROM '3df30c5ccf6db32c4782ba7859591b86'
 THEN RAISE EXCEPTION 'f-act core differs from F1''s body beyond the one actor_missing key'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_pipeline_status()')) IS DISTINCT FROM '9183a756c0d4b3881507656751c0d422'
 THEN RAISE EXCEPTION 'f-act touched the composer'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.ops_api_actor_calls'::regclass)
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.ops_api_actor_calls'::regclass)
 THEN RAISE EXCEPTION 'f-act counter must have RLS on and no policies'; END IF;
 IF has_table_privilege('anon','public.ops_api_actor_calls','SELECT') OR has_table_privilege('authenticated','public.ops_api_actor_calls','SELECT')
  OR has_table_privilege('anon','public.ops_api_actor_calls','INSERT') OR has_table_privilege('authenticated','public.ops_api_actor_calls','INSERT')
  OR has_table_privilege('service_role','public.ops_api_actor_calls','INSERT') OR has_table_privilege('service_role','public.ops_api_actor_calls','UPDATE')
  OR has_table_privilege('service_role','public.ops_api_actor_calls','DELETE') OR NOT has_table_privilege('service_role','public.ops_api_actor_calls','SELECT')
 THEN RAISE EXCEPTION 'f-act counter grants'; END IF;
 IF has_function_privilege('anon','public.record_ops_api_actor_missing()','EXECUTE')
  OR has_function_privilege('authenticated','public.record_ops_api_actor_missing()','EXECUTE')
  OR has_function_privilege('anon','public.context_actor_missing_status()','EXECUTE')
  OR has_function_privilege('authenticated','public.context_actor_missing_status()','EXECUTE')
  OR has_function_privilege('anon','public.context_core_status()','EXECUTE')
  OR has_function_privilege('authenticated','public.context_core_status()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.record_ops_api_actor_missing()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_actor_missing_status()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_core_status()','EXECUTE')
 THEN RAISE EXCEPTION 'f-act function grants'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN (to_regprocedure('public.record_ops_api_actor_missing()'),
   to_regprocedure('public.context_actor_missing_status()')) AND (NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']))
 THEN RAISE EXCEPTION 'f-act functions must be SECURITY DEFINER with a fixed search_path'; END IF;
 -- The missing count only: no column can hold an actor, action, caller class or request content,
 -- and the writer takes no argument, so a caller cannot choose what is stored.
 IF (SELECT string_agg(attname,',' ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.ops_api_actor_calls'::regclass AND attnum>0 AND NOT attisdropped)
    IS DISTINCT FROM 'day,missing,first_at,last_at'
 THEN RAISE EXCEPTION 'f-act counter carries a column beyond the daily missing count'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE proname IN ('record_ops_api_actor_missing','record_ops_api_actor_call') AND pronamespace='public'::regnamespace AND pronargs>0)
 THEN RAISE EXCEPTION 'f-act writer takes arguments'; END IF;
END $$;

BEGIN;
-- 2. The doors, counted. Nothing is refused for a missing actor: the writer
-- has no refusal at all, and the status only counts.
DO $$
DECLARE s jsonb; d date:=(now() AT TIME ZONE 'Australia/Perth')::date; before jsonb;
BEGIN
 DELETE FROM public.ops_api_actor_calls;
 before:=public.context_actor_missing_status();
 IF before<>'{"state":"available","today":0,"last_7_days":0}'::jsonb THEN RAISE EXCEPTION 'f-act empty counter reads %',before; END IF;
 -- MCP census door, three calls with no header (today, before F-ACT-RT).
 PERFORM public.record_ops_api_actor_missing() FROM generate_series(1,3);
 -- Make-safe automation on the routine key, no header.
 PERFORM public.record_ops_api_actor_missing();
 -- A malformed header.
 PERFORM public.record_ops_api_actor_missing();
 s:=public.context_actor_missing_status();
 IF s<>'{"state":"available","today":5,"last_7_days":5}'::jsonb THEN RAISE EXCEPTION 'f-act door counts %',s; END IF;
 IF (SELECT count(*) FROM public.ops_api_actor_calls)<>1 OR (SELECT missing FROM public.ops_api_actor_calls WHERE day=d)<>5
 THEN RAISE EXCEPTION 'f-act calls must add to one row per day'; END IF;
 -- The heartbeat carries the same count at top level.
 IF public.context_pipeline_status()->'actor_missing' IS DISTINCT FROM s THEN RAISE EXCEPTION 'f-act heartbeat actor_missing %',public.context_pipeline_status()->'actor_missing'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3. Window and retention: 7 Perth days counted, today included; a row
-- more than 35 days old is purged when a new day row opens.
DO $$
DECLARE s jsonb; d date:=(now() AT TIME ZONE 'Australia/Perth')::date;
BEGIN
 DELETE FROM public.ops_api_actor_calls;
 INSERT INTO public.ops_api_actor_calls(day,missing) VALUES (d-6,5),(d-7,11),(d+1,13),(d-35,1),(d-36,1);
 s:=public.context_actor_missing_status();
 IF s<>'{"state":"available","today":0,"last_7_days":5}'::jsonb THEN RAISE EXCEPTION 'f-act window %',s; END IF;
 PERFORM public.record_ops_api_actor_missing();
 IF EXISTS(SELECT 1 FROM public.ops_api_actor_calls WHERE day=d-36) OR NOT EXISTS(SELECT 1 FROM public.ops_api_actor_calls WHERE day=d-35)
 THEN RAISE EXCEPTION 'f-act retention'; END IF;
 -- An existing day row does not purge (only a new one does).
 INSERT INTO public.ops_api_actor_calls(day,missing) VALUES (d-40,1);
 PERFORM public.record_ops_api_actor_missing();
 IF NOT EXISTS(SELECT 1 FROM public.ops_api_actor_calls WHERE day=d-40) THEN RAISE EXCEPTION 'f-act purged on an update'; END IF;
 IF (public.context_actor_missing_status()->>'today')::int<>2 THEN RAISE EXCEPTION 'f-act today after two calls'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 4. Every other heartbeat key is F1's value on the same rows, and an
-- unreadable counter cannot take the heartbeat down.
DO $$
DECLARE core jsonb; f1 jsonb; composed jsonb;
BEGIN
 PERFORM public.record_ops_api_actor_missing();
 core:=public.context_core_status();
 f1:=pg_temp.f1_core_status();
 IF (core-'actor_missing'-'as_of') IS DISTINCT FROM (f1-'as_of') THEN RAISE EXCEPTION 'f-act changed a core key: % vs %',core,f1; END IF;
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(core) k) IS DISTINCT FROM
    (SELECT array_agg(k ORDER BY k) FROM (SELECT jsonb_object_keys(f1) k UNION SELECT 'actor_missing') u)
 THEN RAISE EXCEPTION 'f-act core keys %',(SELECT array_agg(k) FROM jsonb_object_keys(core) k); END IF;
 composed:=public.context_pipeline_status();
 IF (composed#>>'{actor_missing,today}')::int<1 THEN RAISE EXCEPTION 'f-act composer %',composed; END IF;
 ALTER TABLE public.ops_api_actor_calls RENAME TO ops_api_actor_calls_gone;
 IF public.context_actor_missing_status()<>'{"state":"unavailable","code":"42P01"}'::jsonb
 THEN RAISE EXCEPTION 'f-act unreadable counter %',public.context_actor_missing_status(); END IF;
 composed:=public.context_pipeline_status();
 IF composed->'actor_missing'<>'{"state":"unavailable","code":"42P01"}'::jsonb OR composed->'run_date' IS NULL OR NOT composed ? 'coverage'
 THEN RAISE EXCEPTION 'f-act heartbeat with an unreadable counter %',composed; END IF;
END $$;
ROLLBACK;
