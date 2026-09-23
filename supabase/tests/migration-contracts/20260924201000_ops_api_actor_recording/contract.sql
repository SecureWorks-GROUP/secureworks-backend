-- F-ACT contract (INTEGRATION X31): server-key ops-api calls counted by actor
-- state, the actor_missing count in the core status, nothing refused, nothing
-- widened, and every other heartbeat key unchanged.
--
-- The doors X31 names, as the ops-api edge code classifies them
-- (supabase/functions/_shared/request_actor.ts, ops-api/actor_calls.ts):
--   MCP tool or sw-axi on the server key, no x-sw-actor yet (today, before
--     F-ACT-RT): api_key / missing, e.g. the B0 census door
--     context_unlinked_census that sw_context_unlinked calls;
--   the same door once F-ACT-RT sends x-sw-actor: api_key / present;
--   the make-safe automation on the routine key: routine / missing;
--   a malformed header: invalid_header, which counts as missing;
--   a signed-in Ops browser (JWT): never counted, it always has a user.

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
 IF has_function_privilege('anon','public.record_ops_api_actor_call(text,text,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.record_ops_api_actor_call(text,text,text)','EXECUTE')
  OR has_function_privilege('anon','public.context_actor_missing_status()','EXECUTE')
  OR has_function_privilege('authenticated','public.context_actor_missing_status()','EXECUTE')
  OR has_function_privilege('anon','public.context_core_status()','EXECUTE')
  OR has_function_privilege('authenticated','public.context_core_status()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.record_ops_api_actor_call(text,text,text)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_actor_missing_status()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_core_status()','EXECUTE')
 THEN RAISE EXCEPTION 'f-act function grants'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN (to_regprocedure('public.record_ops_api_actor_call(text,text,text)'),
   to_regprocedure('public.context_actor_missing_status()')) AND (NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']))
 THEN RAISE EXCEPTION 'f-act functions must be SECURITY DEFINER with a fixed search_path'; END IF;
 -- Counts only: no column can hold an actor or request content.
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.ops_api_actor_calls'::regclass AND attnum>0 AND NOT attisdropped
   AND attname NOT IN ('day','caller_class','actor_state','action','calls','first_at','last_at'))
 THEN RAISE EXCEPTION 'f-act counter carries a column beyond counts'; END IF;
END $$;

BEGIN;
-- 2. The doors, counted. Nothing is refused for a missing actor: the writer
-- has no refusal for it, and the status only counts.
DO $$
DECLARE s jsonb; d date:=(now() AT TIME ZONE 'Australia/Perth')::date; before jsonb;
BEGIN
 DELETE FROM public.ops_api_actor_calls;
 before:=public.context_actor_missing_status();
 IF before<>jsonb_build_object('state','available','today',0,'last_7_days',0,'invalid_header_last_7_days',0,'server_key_calls_today',0,
   'server_key_calls_last_7_days',0,'by_caller_last_7_days','{}'::jsonb,'by_action_last_7_days','{}'::jsonb)
 THEN RAISE EXCEPTION 'f-act empty counter reads %',before; END IF;
 -- MCP census door, three calls with no header (today, before F-ACT-RT).
 PERFORM public.record_ops_api_actor_call('api_key','missing','context_unlinked_census') FROM generate_series(1,3);
 -- Same door with the header F-ACT-RT sends.
 PERFORM public.record_ops_api_actor_call('api_key','present','context_unlinked_census') FROM generate_series(1,2);
 -- Make-safe automation on the routine key, no header.
 PERFORM public.record_ops_api_actor_call('routine','missing','makesafe_pipeline');
 -- A malformed header counts as missing, and apart.
 PERFORM public.record_ops_api_actor_call('api_key','invalid_header','job_detail');
 -- Action names outside the grammar are never stored as given.
 PERFORM public.record_ops_api_actor_call('agent_read','missing','Makesafe Board; drop table');
 PERFORM public.record_ops_api_actor_call('agent_read','missing','');
 s:=public.context_actor_missing_status();
 IF (s->>'today')::int<>7 OR (s->>'last_7_days')::int<>7 OR (s->>'invalid_header_last_7_days')::int<>1
  OR (s->>'server_key_calls_today')::int<>9 OR (s->>'server_key_calls_last_7_days')::int<>9
  OR s->'by_caller_last_7_days'<>'{"api_key":4,"routine":1,"agent_read":2}'::jsonb
  OR s->'by_action_last_7_days'<>'{"context_unlinked_census":3,"makesafe_pipeline":1,"job_detail":1,"other":1,"none":1}'::jsonb
 THEN RAISE EXCEPTION 'f-act door counts %',s; END IF;
 IF (SELECT calls FROM public.ops_api_actor_calls WHERE day=d AND caller_class='api_key' AND actor_state='missing' AND action='context_unlinked_census')<>3
 THEN RAISE EXCEPTION 'f-act repeat calls must add to one counter row'; END IF;
 IF EXISTS(SELECT 1 FROM public.ops_api_actor_calls WHERE action NOT IN ('context_unlinked_census','makesafe_pipeline','job_detail','other','none'))
 THEN RAISE EXCEPTION 'f-act stored an action outside the grammar'; END IF;
 -- The heartbeat carries the same count at top level.
 IF public.context_pipeline_status()->'actor_missing' IS DISTINCT FROM s THEN RAISE EXCEPTION 'f-act heartbeat actor_missing %',public.context_pipeline_status()->'actor_missing'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3. Writer refusals are about its own inputs only, never about the actor.
DO $$
BEGIN
 BEGIN PERFORM public.record_ops_api_actor_call('jwt','present','job_detail'); RAISE EXCEPTION 'f-act jwt counted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'actor_call_class_invalid' THEN RAISE; END IF; END;
 BEGIN PERFORM public.record_ops_api_actor_call(NULL,'present','job_detail'); RAISE EXCEPTION 'f-act null class counted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'actor_call_class_invalid' THEN RAISE; END IF; END;
 BEGIN PERFORM public.record_ops_api_actor_call('api_key','refused','job_detail'); RAISE EXCEPTION 'f-act bad state counted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'actor_call_state_invalid' THEN RAISE; END IF; END;
END $$;
ROLLBACK;

BEGIN;
-- 4. Window and retention: 7 Perth days counted, today included; a row
-- 35 days old or older is purged when a new counter row opens.
DO $$
DECLARE s jsonb; d date:=(now() AT TIME ZONE 'Australia/Perth')::date;
BEGIN
 DELETE FROM public.ops_api_actor_calls;
 INSERT INTO public.ops_api_actor_calls(day,caller_class,actor_state,action,calls) VALUES
  (d-6,'api_key','missing','in_window',5),(d-7,'api_key','missing','out_of_window',11),
  (d+1,'api_key','missing','future',13),(d-35,'api_key','missing','kept',1),(d-36,'api_key','missing','purged',1);
 s:=public.context_actor_missing_status();
 IF (s->>'today')::int<>0 OR (s->>'last_7_days')::int<>5 OR s->'by_action_last_7_days'<>'{"in_window":5}'::jsonb
 THEN RAISE EXCEPTION 'f-act window %',s; END IF;
 PERFORM public.record_ops_api_actor_call('api_key','present','job_detail');
 IF EXISTS(SELECT 1 FROM public.ops_api_actor_calls WHERE action='purged') OR NOT EXISTS(SELECT 1 FROM public.ops_api_actor_calls WHERE action='kept')
 THEN RAISE EXCEPTION 'f-act retention'; END IF;
 -- An existing counter row does not purge (only a new one does).
 INSERT INTO public.ops_api_actor_calls(day,caller_class,actor_state,action,calls) VALUES (d-40,'api_key','missing','old_again',1);
 PERFORM public.record_ops_api_actor_call('api_key','present','job_detail');
 IF NOT EXISTS(SELECT 1 FROM public.ops_api_actor_calls WHERE action='old_again') THEN RAISE EXCEPTION 'f-act purged on an update'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 5. Every other heartbeat key is F1's value on the same rows, and an
-- unreadable counter cannot take the heartbeat down.
DO $$
DECLARE core jsonb; f1 jsonb; composed jsonb;
BEGIN
 PERFORM public.record_ops_api_actor_call('api_key','missing','context_pipeline_status');
 core:=public.context_core_status();
 f1:=pg_temp.f1_core_status();
 IF (core-'actor_missing'-'as_of') IS DISTINCT FROM (f1-'as_of') THEN RAISE EXCEPTION 'f-act changed a core key: % vs %',core,f1; END IF;
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(core) k) IS DISTINCT FROM
    (SELECT array_agg(k ORDER BY k) FROM (SELECT jsonb_object_keys(f1) k UNION SELECT 'actor_missing') u)
 THEN RAISE EXCEPTION 'f-act core keys %',(SELECT array_agg(k) FROM jsonb_object_keys(core) k); END IF;
 composed:=public.context_pipeline_status();
 IF (composed->>'actor_missing') IS NULL OR (composed#>>'{actor_missing,today}')::int<1 THEN RAISE EXCEPTION 'f-act composer %',composed; END IF;
 ALTER TABLE public.ops_api_actor_calls RENAME TO ops_api_actor_calls_gone;
 IF public.context_actor_missing_status()<>'{"state":"unavailable","code":"42P01"}'::jsonb
 THEN RAISE EXCEPTION 'f-act unreadable counter %',public.context_actor_missing_status(); END IF;
 composed:=public.context_pipeline_status();
 IF composed->'actor_missing'<>'{"state":"unavailable","code":"42P01"}'::jsonb OR composed->'run_date' IS NULL OR NOT composed ? 'coverage'
 THEN RAISE EXCEPTION 'f-act heartbeat with an unreadable counter %',composed; END IF;
END $$;
ROLLBACK;
