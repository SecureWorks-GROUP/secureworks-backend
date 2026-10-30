-- Synthetic evaluation labels only: no evaluation inputs or held-out sets.
-- Check observable capture health before implementation hashes so mutation
-- proofs fail for the promised behavior, not a changed source string.
BEGIN;
CREATE TEMP TABLE capture_assertions(label text);
CREATE OR REPLACE FUNCTION pg_temp.capture_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF ok IS NOT TRUE THEN RAISE EXCEPTION 'capture_evaluation: %',label; END IF;
 INSERT INTO capture_assertions VALUES(label);
END $$;
CREATE OR REPLACE FUNCTION pg_temp.capture_rows(s text,t text,last_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ids uuid[];
BEGIN
 WITH ins AS (
  INSERT INTO public.business_events(match_method,payload,occurred_at,source,event_type)
  SELECT 'none','{"body":"synthetic health fixture"}'::jsonb,g,s,t
  FROM generate_series(last_at-interval '14 days',last_at,interval '15 minutes') g
  WHERE public.context_in_business_hours(g) RETURNING id)
 SELECT array_agg(id) INTO ids FROM ins;
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE id=ANY(ids);
END $$;
UPDATE public.business_events SET context_captured_at=now()-interval '400 days'
 WHERE source IN ('daily-digest','capture_eval_only','capture_real_quiet','capture_null_type','capture_other_ai','capture_backfill','capture_mixed_rate');
SELECT pg_temp.capture_rows('capture_eval_only','ai.canary_result',now()-interval '10 days');
SELECT pg_temp.capture_rows('capture_real_quiet','email.received',now()-interval '10 days');
SELECT pg_temp.capture_rows('daily-digest','email.received',now()-interval '10 days');
SELECT pg_temp.capture_rows('capture_null_type',NULL,now()-interval '10 days');
SELECT pg_temp.capture_rows('capture_other_ai','ai.unclassified',now()-interval '10 days');
SELECT pg_temp.capture_rows('capture_backfill','email.received',now()-interval '10 days');
UPDATE public.business_events SET metadata=jsonb_build_object('capture_mode','backfill') WHERE source='capture_backfill';
-- A mixed source's fresh canary must not replace its last real business event.
INSERT INTO public.business_events(match_method,payload,occurred_at,context_captured_at,source,event_type)
 VALUES('none','{}',now(),now(),'daily-digest','ai.canary_result');
-- A high volume of old canaries must not make a one-message business source
-- look normally active. Its actual business row remains visible and quiet.
SELECT pg_temp.capture_rows('capture_mixed_rate','ai.canary_result',now()-interval '10 days');
INSERT INTO public.business_events(match_method,payload,occurred_at,source,event_type)
 VALUES('none','{}',now()-interval '10 days','capture_mixed_rate','email.received');
UPDATE public.business_events SET context_captured_at=occurred_at WHERE source='capture_mixed_rate';
DO $$
DECLARE s jsonb:=public.context_source_freshness(); r jsonb; sig text; f regprocedure;
BEGIN
 PERFORM pg_temp.capture_assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'sources') x WHERE x->>'source'='capture_eval_only'),
  'canary-only source is not business capture');
 PERFORM pg_temp.capture_assert(NOT s->'alarms' @> '[{"source":"capture_eval_only"}]', 'canary-only source does not raise capture alarm');
 PERFORM pg_temp.capture_assert(s->'alarms' @> '[{"source":"capture_real_quiet","key":"capture_quiet"}]', 'stopped business feed still alarms');
 PERFORM pg_temp.capture_assert(s->'alarms' @> '[{"source":"daily-digest","key":"capture_quiet"}]', 'mixed daily-digest business capture still alarms');
 SELECT value INTO r FROM jsonb_array_elements(s->'sources') WHERE value->>'source'='daily-digest';
 PERFORM pg_temp.capture_assert((r->>'last_captured_at')::timestamptz=(SELECT max(context_captured_at) FROM public.business_events WHERE source='daily-digest' AND event_type='email.received'),
  'recent canary cannot hide last business capture');
 PERFORM pg_temp.capture_assert((r->>'rows_in_business_hours')::bigint=(SELECT count(*) FROM public.business_events WHERE source='daily-digest' AND event_type='email.received'
  AND context_captured_at>(r->>'last_captured_at')::timestamptz-interval '14 days' AND public.context_in_business_hours(context_captured_at)),
  'rate measures business rows only');
 PERFORM pg_temp.capture_assert(s->'alarms' @> '[{"source":"capture_null_type","key":"capture_quiet"}]', 'null event type is retained');
 PERFORM pg_temp.capture_assert(s->'alarms' @> '[{"source":"capture_other_ai","key":"capture_quiet"}]', 'unknown AI type is retained');
 PERFORM pg_temp.capture_assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'sources') x WHERE x->>'source'='capture_backfill'), 'backfill exclusion unchanged');
 SELECT value INTO r FROM jsonb_array_elements(s->'sources') WHERE value->>'source'='capture_mixed_rate';
 PERFORM pg_temp.capture_assert(r IS NOT NULL AND r->'normally_active'='false'::jsonb AND r->'quiet'='false'::jsonb,
  'canary volume cannot create normally-active business rate');
 PERFORM pg_temp.capture_assert(NOT s->'alarms' @> '[{"source":"capture_mixed_rate"}]', 'low-volume business source remains below unchanged threshold');
 PERFORM pg_temp.capture_assert(s#>'{policy,ignored_capture_event_types}'='["ai.canary_result"]'::jsonb, 'exclusion is explicitly published');
 PERFORM pg_temp.capture_assert(s#>'{policy,ignored_capture_modes}'='["backfill","relink"]'::jsonb
  AND s#>>'{policy,quiet_business_minutes}'='120' AND s#>>'{policy,normally_active_min_rows_per_business_hour}'='2.5', 'existing thresholds and modes unchanged');
 PERFORM pg_temp.capture_assert(public.context_pipeline_status()->'alarms' @> '[{"block":"capture_sources","source":"daily-digest","key":"capture_quiet"}]', 'composer carries real mixed-source outage');
 PERFORM pg_temp.capture_assert(NOT public.context_pipeline_status()->'alarms' @> '[{"block":"capture_sources","source":"capture_eval_only"}]', 'composer does not mislabel evaluation outage');
 FOREACH sig IN ARRAY ARRAY['public.context_source_freshness()','public.context_source_freshness_policy()'] LOOP
  f:=sig::regprocedure;
  PERFORM pg_temp.capture_assert(NOT has_function_privilege('anon',f,'EXECUTE') AND NOT has_function_privilege('authenticated',f,'EXECUTE')
   AND NOT has_function_privilege('public',f,'EXECUTE') AND has_function_privilege('service_role',f,'EXECUTE'), sig||' existing restricted access');
 END LOOP;
 PERFORM pg_temp.capture_assert((SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid='public.context_source_freshness()'::regprocedure), 'freshness security configuration unchanged');
 PERFORM pg_temp.capture_assert((SELECT NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid='public.context_source_freshness_policy()'::regprocedure), 'policy security configuration unchanged');
END $$;
-- No writes to source events or unrelated function bodies on idempotent reapply.
CREATE TEMP TABLE capture_before AS SELECT md5(jsonb_agg(to_jsonb(e) ORDER BY id)::text) AS hash FROM public.business_events e;
CREATE TEMP TABLE capture_functions AS SELECT oid,md5(pg_get_functiondef(oid)) AS hash,proacl FROM pg_proc WHERE pronamespace='public'::regnamespace;
\ir ../../../migrations/20261030192929_context_capture_excludes_evaluation.sql
SELECT pg_temp.capture_assert((SELECT hash FROM capture_before)=(SELECT md5(jsonb_agg(to_jsonb(e) ORDER BY id)::text) FROM public.business_events e), 'reapply preserves all source rows');
SELECT pg_temp.capture_assert(NOT EXISTS(SELECT 1 FROM capture_functions b JOIN pg_proc p USING(oid) WHERE b.hash IS DISTINCT FROM md5(pg_get_functiondef(p.oid)) OR b.proacl IS DISTINCT FROM p.proacl), 'reapply preserves functions and ACLs');
SELECT count(*) AS capture_evaluation_assertions FROM capture_assertions;
ROLLBACK;
