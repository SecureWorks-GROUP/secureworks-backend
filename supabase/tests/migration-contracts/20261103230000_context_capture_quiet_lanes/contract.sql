-- C1 capture lanes (20261103230000): Xero, quotes, bookings and documents are listed
-- from their own tables, every source says whether its alarm is armed, calls alarm by
-- a fixed limit, and lanes gives one line per owner lane. Fixtures are relative to
-- now(): fresh rows at now(), quiet rows 20 days back (at least 17 business days, past
-- every limit). No calendar date is read. Observable output is checked before hashes.
BEGIN;
-- Fixture rows skip foreign keys and triggers; everything is rolled back.
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE c1_assertions(label text);
CREATE FUNCTION pg_temp.c1_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF ok IS NOT TRUE THEN RAISE EXCEPTION 'capture_quiet_lanes: %',label; END IF;
 INSERT INTO c1_assertions VALUES(label);
END $$;
-- One row into a table whatever its other required columns are in this stack.
CREATE FUNCTION pg_temp.c1_put(t regclass,vals jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v jsonb:='{}'::jsonb; a record; cols text;
BEGIN
 FOR a IN SELECT attname,atttypid,format_type(atttypid,atttypmod) AS typ,attnotnull,atthasdef,attidentity,attgenerated
  FROM pg_attribute WHERE attrelid=t AND attnum>0 AND NOT attisdropped LOOP
  IF vals ? a.attname THEN v:=v||jsonb_build_object(a.attname,vals->a.attname);
  ELSIF a.attnotnull AND NOT a.atthasdef AND a.attidentity='' AND a.attgenerated='' THEN
   v:=v||jsonb_build_object(a.attname,CASE
    WHEN a.typ='uuid' THEN to_jsonb(gen_random_uuid())
    WHEN a.typ IN ('smallint','integer','bigint','real','double precision') OR a.typ LIKE 'numeric%' THEN to_jsonb(0)
    WHEN a.typ='boolean' THEN to_jsonb(false)
    WHEN a.typ IN ('jsonb','json') THEN '{}'::jsonb
    WHEN a.typ='date' THEN to_jsonb(current_date)
    WHEN a.typ LIKE 'timestamp%' THEN to_jsonb(now())
    WHEN a.typ LIKE '%[]' THEN '[]'::jsonb
    WHEN EXISTS(SELECT 1 FROM pg_enum e WHERE e.enumtypid=a.atttypid)
     THEN (SELECT to_jsonb(e.enumlabel::text) FROM pg_enum e WHERE e.enumtypid=a.atttypid ORDER BY e.enumsortorder LIMIT 1)
    ELSE to_jsonb('c1-fixture-'||gen_random_uuid()::text) END);
  END IF;
 END LOOP;
 SELECT string_agg(quote_ident(k),',') INTO cols FROM jsonb_object_keys(v) k;
 EXECUTE format('INSERT INTO %s (%s) SELECT %s FROM jsonb_populate_record(NULL::%s,$1)',t,cols,cols,t) USING v;
END $$;
-- Business-hour rows every 15 minutes for 14 days ending at last_at (4 an hour).
CREATE FUNCTION pg_temp.c1_rows(s text,last_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ids uuid[];
BEGIN
 WITH ins AS (
  INSERT INTO public.business_events(match_method,payload,occurred_at,source)
  SELECT 'none','{"body":"c1 synthetic"}'::jsonb,g,s FROM generate_series(last_at-interval '14 days',last_at,interval '15 minutes') g
  WHERE public.context_in_business_hours(g) OR g=last_at RETURNING id)
 SELECT array_agg(id) INTO ids FROM ins;
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE id=ANY(ids);
END $$;
CREATE FUNCTION pg_temp.c1_one(s text,at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i uuid;
BEGIN
 INSERT INTO public.business_events(match_method,payload,occurred_at,source) VALUES('none','{"body":"c1 synthetic"}',at,s) RETURNING id INTO i;
 UPDATE public.business_events SET context_captured_at=at WHERE id=i;
END $$;
CREATE FUNCTION pg_temp.c1_src(snap jsonb,s text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT value FROM jsonb_array_elements(snap->'sources') WHERE value->>'source'=s $$;
CREATE FUNCTION pg_temp.c1_lane(snap jsonb,l text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT value FROM jsonb_array_elements(snap->'lanes') WHERE value->>'lane'=l $$;

-- Start clean: every record table and the three message lanes out of the lookback.
UPDATE public.xero_invoices SET created_at=now()-interval '400 days';
UPDATE public.xero_settlement_evidence SET captured_at=now()-interval '400 days';
UPDATE public.job_documents SET created_at=now()-interval '400 days',sent_at=CASE WHEN sent_at IS NOT NULL THEN now()-interval '400 days' END;
UPDATE public.job_media SET created_at=now()-interval '400 days';
UPDATE public.job_assignments SET created_at=now()-interval '400 days';
UPDATE public.business_events SET context_captured_at=now()-interval '400 days'
 WHERE source IN ('ghl-message-reconcile','outlook-mail-capture','ghl-call-transcript','c1_busy_quiet','c1_sparse');
DELETE FROM public.feature_flags WHERE flag_name='ghl_call_transcript_fetch_v1';
SELECT pg_temp.c1_put('public.feature_flags','{"flag_name":"ghl_call_transcript_fetch_v1","enabled":true}'::jsonb||jsonb_build_object('updated_at',now()));

-- 1. Every lane arriving now: all seven live with their alarm armed, nothing raised.
SELECT pg_temp.c1_rows('ghl-message-reconcile',now());
SELECT pg_temp.c1_rows('outlook-mail-capture',now());
SELECT pg_temp.c1_one('ghl-call-transcript',now());  -- one call: under the rate rule, armed by its limit
SELECT pg_temp.c1_put('public.xero_invoices',jsonb_build_object('invoice_type','ACCPAY','created_at',now()));
SELECT pg_temp.c1_put('public.xero_invoices',jsonb_build_object('invoice_type','ACCREC','created_at',now()));
SELECT pg_temp.c1_put('public.xero_settlement_evidence',jsonb_build_object('record_type','payment','invoice_id','c1-fixture','captured_at',now()));
SELECT pg_temp.c1_put('public.job_documents',jsonb_build_object('type','quote','created_at',now(),'sent_at',now()));
SELECT pg_temp.c1_put('public.job_media',jsonb_build_object('created_at',now()));
SELECT pg_temp.c1_put('public.job_assignments',jsonb_build_object('created_at',now(),'is_ghost',false));
DO $$
DECLARE s jsonb:=public.context_source_freshness(); r jsonb; n text; lim jsonb;
BEGIN
 PERFORM pg_temp.c1_assert((SELECT array_agg(x->>'lane' ORDER BY o) FROM jsonb_array_elements(s->'lanes') WITH ORDINALITY t(x,o))
  =ARRAY['texts','calls','emails','xero','quotes','bookings','documents'],'seven lanes published in order');
 PERFORM pg_temp.c1_assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'lanes') x
  WHERE x->'live'<>'true'::jsonb OR x->'alarm_armed'<>'true'::jsonb OR x->'quiet_sources'<>'[]' OR x->'missing_sources'<>'[]' OR x->'unarmed_sources'<>'[]'),
  'all seven lanes live and armed when every source arrives now');
 PERFORM pg_temp.c1_assert(pg_temp.c1_lane(s,'xero')->'sources'='["xero/bills","xero/invoices","xero/payments"]'
  AND pg_temp.c1_lane(s,'documents')->'sources'='["documents/files","documents/photos"]','lane membership published');
 PERFORM pg_temp.c1_assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') a WHERE a ? 'lane'),'no lane alarm while all arrive');
 FOREACH n IN ARRAY ARRAY['xero/bills','xero/invoices','xero/payments','quotes/sent','bookings/crew','documents/files','documents/photos'] LOOP
  r:=pg_temp.c1_src(s,n);
  SELECT x INTO lim FROM jsonb_array_elements(s#>'{policy,quiet_limits}') x WHERE x->>'source'=n;
  PERFORM pg_temp.c1_assert(r IS NOT NULL AND (r->>'last_captured_at')::timestamptz=now() AND r->'quiet'='false'::jsonb
   AND r->'alarm_armed'='true'::jsonb AND r->'alarm_exempt'='null'::jsonb AND r->>'reads'=lim->>'reads'
   AND (r->>'quiet_after_business_minutes')::int=(lim->>'quiet_after_business_minutes')::int
   AND (r->>'expected_gap_business_minutes')::int=(lim->>'expected_gap_business_minutes')::int,n||' listed live from its own table');
 END LOOP;
 r:=pg_temp.c1_src(s,'ghl-call-transcript');
 PERFORM pg_temp.c1_assert(r->'normally_active'='false'::jsonb AND r->'alarm_armed'='true'::jsonb AND r->>'lane'='calls'
  AND (r->>'quiet_after_business_minutes')::int=990,'calls armed by its limit below the rate rule');
 r:=pg_temp.c1_src(s,'ghl-message-reconcile');
 PERFORM pg_temp.c1_assert(r->'normally_active'='true'::jsonb AND r->'alarm_armed'='true'::jsonb AND r->>'lane'='texts'
  AND NOT r ? 'quiet_after_business_minutes','texts armed by the unchanged rate rule');
END $$;

-- 2. Stops. Xero payments, bookings (only a ghost seat now), quotes (one made now, not
-- sent) and calls go quiet; photos have no row at all; a busy writer and a sparse one
-- keep the old rule.
UPDATE public.xero_settlement_evidence SET captured_at=now()-interval '20 days';
UPDATE public.job_assignments SET created_at=now()-interval '20 days';
SELECT pg_temp.c1_put('public.job_assignments',jsonb_build_object('created_at',now(),'is_ghost',true));
UPDATE public.job_documents SET sent_at=now()-interval '20 days',created_at=now()-interval '20 days' WHERE type='quote';
SELECT pg_temp.c1_put('public.job_documents',jsonb_build_object('type','quote','created_at',now()));
UPDATE public.job_media SET created_at=now()-interval '400 days';
UPDATE public.business_events SET context_captured_at=now()-interval '20 days' WHERE source='ghl-call-transcript' AND context_captured_at=now();
SELECT pg_temp.c1_rows('c1_busy_quiet',now()-interval '10 days');
SELECT pg_temp.c1_one('c1_sparse',now()-interval '10 days');
DO $$
DECLARE s jsonb:=public.context_source_freshness(); r jsonb; a jsonb; n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['xero/payments','bookings/crew','quotes/sent','ghl-call-transcript'] LOOP
  r:=pg_temp.c1_src(s,n);
  SELECT x INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'source'=n AND x->>'key'='capture_quiet';
  PERFORM pg_temp.c1_assert(r->'quiet'='true'::jsonb AND (r->>'quiet_business_minutes')::int>=(r->>'quiet_after_business_minutes')::int
   AND a IS NOT NULL AND a->>'severity'='warning' AND a->>'lane'=r->>'lane' AND (a->>'since')::timestamptz=(r->>'last_captured_at')::timestamptz
   AND (a->>'quiet_after_business_minutes')::int=(r->>'quiet_after_business_minutes')::int
   AND a->>'what_to_do'=(SELECT x->>'what_to_do' FROM jsonb_array_elements(s#>'{policy,quiet_limits}') x WHERE x->>'source'=n),
   n||' quiet past its limit raises capture_quiet with its lane and advice');
 END LOOP;
 PERFORM pg_temp.c1_assert((pg_temp.c1_src(s,'bookings/crew')->>'last_captured_at')::timestamptz=now()-interval '20 days','a ghost seat is not a booking');
 PERFORM pg_temp.c1_assert((pg_temp.c1_src(s,'quotes/sent')->>'last_captured_at')::timestamptz=now()-interval '20 days'
  AND (pg_temp.c1_src(s,'documents/files')->>'last_captured_at')::timestamptz=now(),'an unsent quote is a document, not a sent quote');
 r:=pg_temp.c1_src(s,'documents/photos');
 PERFORM pg_temp.c1_assert(r IS NOT NULL AND r->'last_captured_at'='null'::jsonb AND r->'quiet'='false'::jsonb
  AND NOT s->'alarms' @> '[{"source":"documents/photos"}]','a record source with no row is listed, not quiet, not alarmed');
 PERFORM pg_temp.c1_assert(pg_temp.c1_lane(s,'documents')->'live'='false'::jsonb AND pg_temp.c1_lane(s,'documents')->'missing_sources'='["documents/photos"]',
  'a lane with a silent source is not live and names it');
 PERFORM pg_temp.c1_assert(pg_temp.c1_lane(s,'xero')->'live'='false'::jsonb AND pg_temp.c1_lane(s,'xero')->'quiet_sources'='["xero/payments"]'
  AND pg_temp.c1_lane(s,'xero')->'alarm_armed'='true'::jsonb AND (pg_temp.c1_lane(s,'xero')->>'last_captured_at')::timestamptz=now(),
  'xero lane is not live while payments are quiet; newest arrival still shown');
 PERFORM pg_temp.c1_assert(pg_temp.c1_lane(s,'texts')->'live'='true'::jsonb AND pg_temp.c1_lane(s,'emails')->'live'='true'::jsonb,'other lanes unaffected');
 PERFORM pg_temp.c1_assert(s->'alarms' @> '[{"key":"capture_quiet","source":"c1_busy_quiet"}]' AND NOT pg_temp.c1_src(s,'c1_busy_quiet') ? 'lane',
  'a busy unlisted writer still alarms by the unchanged rate rule');
 r:=pg_temp.c1_src(s,'c1_sparse');
 PERFORM pg_temp.c1_assert(r->'quiet'='false'::jsonb AND r->'alarm_armed'='false'::jsonb AND NOT s->'alarms' @> '[{"source":"c1_sparse"}]',
  'a sparse writer with no limit is unarmed and silent, as before');
 PERFORM pg_temp.c1_assert(public.context_pipeline_status()->'alarms' @> '[{"block":"capture_sources","key":"capture_quiet","source":"xero/payments","lane":"xero"}]',
  'composer carries a record-source alarm');
END $$;

-- 3. Calls with the flag on and no call in the lookback: listed, not quiet, no alarm
-- (F1b's rule, kept). Then the fetch flag off: exempt, so the lane reads unarmed.
UPDATE public.business_events SET context_captured_at=now()-interval '400 days' WHERE source='ghl-call-transcript';
DO $$
DECLARE s jsonb:=public.context_source_freshness();
BEGIN
 PERFORM pg_temp.c1_assert(pg_temp.c1_src(s,'ghl-call-transcript')->'last_captured_at'='null'::jsonb
  AND pg_temp.c1_src(s,'ghl-call-transcript')->'quiet'='false'::jsonb AND NOT s->'alarms' @> '[{"source":"ghl-call-transcript"}]'
  AND pg_temp.c1_lane(s,'calls')->'missing_sources'='["ghl-call-transcript"]','calls before any row: not quiet, not alarmed, lane names it missing');
END $$;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='ghl_call_transcript_fetch_v1';
DO $$
DECLARE s jsonb:=public.context_source_freshness();
BEGIN
 PERFORM pg_temp.c1_assert(pg_temp.c1_src(s,'ghl-call-transcript')->>'alarm_exempt'='flag_off'
  AND pg_temp.c1_src(s,'ghl-call-transcript')->'alarm_armed'='false'::jsonb AND NOT s->'alarms' @> '[{"source":"ghl-call-transcript"}]'
  AND pg_temp.c1_lane(s,'calls')->'alarm_armed'='false'::jsonb AND pg_temp.c1_lane(s,'calls')->'unarmed_sources'='["ghl-call-transcript"]',
  'calls with the flag off are exempt and the lane says unarmed');
END $$;

-- 4. Published policy and unchanged thresholds, access and security settings.
DO $$
DECLARE p jsonb:=public.context_source_freshness_policy(); sig text; f regprocedure;
BEGIN
 PERFORM pg_temp.c1_assert((SELECT array_agg(x->>'source' ORDER BY o) FROM jsonb_array_elements(p->'quiet_limits') WITH ORDINALITY t(x,o))
  =ARRAY['ghl-call-transcript','xero/bills','xero/invoices','xero/payments','quotes/sent','bookings/crew','documents/files','documents/photos']
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'quiet_limits') x WHERE (x->>'quiet_after_business_minutes')::int % 330<>0
   OR (x->>'quiet_after_business_minutes')::int<(x->>'longest_gap_business_minutes')::int*1.25
   OR x->>'what_to_do' ~ '[\u2014\u2013]'),'limits published, each above 1.25 times its longest gap, plain wording');
 PERFORM pg_temp.c1_assert(p->'ignored_capture_modes'='["backfill","relink"]' AND p->'ignored_capture_event_types'='["ai.canary_result"]'
  AND p->>'quiet_business_minutes'='120' AND p->>'normally_active_min_rows_per_business_hour'='2.5' AND p->>'rate_window_days'='14' AND p->>'lookback_days'='60',
  'existing thresholds and exclusions unchanged');
 FOREACH sig IN ARRAY ARRAY['public.context_source_freshness()','public.context_source_freshness_policy()'] LOOP
  f:=sig::regprocedure;
  PERFORM pg_temp.c1_assert(NOT has_function_privilege('anon',f,'EXECUTE') AND NOT has_function_privilege('authenticated',f,'EXECUTE')
   AND NOT has_function_privilege('public',f,'EXECUTE') AND has_function_privilege('service_role',f,'EXECUTE'),sig||' access unchanged');
 END LOOP;
 PERFORM pg_temp.c1_assert((SELECT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid='public.context_source_freshness()'::regprocedure),'freshness security unchanged');
 PERFORM pg_temp.c1_assert((SELECT NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid='public.context_source_freshness_policy()'::regprocedure),'policy security unchanged');
 PERFORM pg_temp.c1_assert(md5(pg_get_functiondef('public.context_source_freshness_policy()'::regprocedure))='1edadacbac4d135f143551a739ca4939'
  AND md5(pg_get_functiondef('public.context_source_freshness()'::regprocedure))='6e7d1ca399b4d56c1bd0868b9ebf9f09','rehearsed definitions installed');
END $$;

-- 5. Re-apply changes nothing: no rows, no function body, no access.
CREATE TEMP TABLE c1_functions AS SELECT oid,md5(pg_get_functiondef(oid)) AS hash,proacl FROM pg_proc WHERE pronamespace='public'::regnamespace;
CREATE TEMP TABLE c1_rows_before AS SELECT md5(coalesce(jsonb_agg(to_jsonb(e) ORDER BY id)::text,'')) AS hash FROM public.business_events e;
\ir ../../../migrations/20261103230000_context_capture_quiet_lanes.sql
SELECT pg_temp.c1_assert(NOT EXISTS(SELECT 1 FROM c1_functions b JOIN pg_proc p USING(oid) WHERE b.hash IS DISTINCT FROM md5(pg_get_functiondef(p.oid)) OR b.proacl IS DISTINCT FROM p.proacl),'re-apply keeps every function and its access');
SELECT pg_temp.c1_assert((SELECT hash FROM c1_rows_before)=(SELECT md5(coalesce(jsonb_agg(to_jsonb(e) ORDER BY id)::text,'')) FROM public.business_events e),'re-apply writes no rows');
SELECT count(*) AS capture_quiet_lanes_assertions FROM c1_assertions;
ROLLBACK;
