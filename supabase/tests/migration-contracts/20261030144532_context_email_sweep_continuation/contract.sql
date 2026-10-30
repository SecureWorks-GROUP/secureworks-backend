-- Synthetic local SQL behavior; every network/key function is replaced inside
-- rolled-back transactions. This fixture must never be run on production.
BEGIN;
CREATE TABLE pg_temp.sweep_assertions(label text);
CREATE FUNCTION pg_temp.sweep_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'sweep assertion: %',label; END IF;
 INSERT INTO pg_temp.sweep_assertions VALUES(label); END $$;
CREATE TABLE pg_temp.sweep_posts(seq bigserial,body jsonb);
CREATE SCHEMA IF NOT EXISTS net;
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO pg_temp.sweep_posts(body) VALUES(body) RETURNING seq $$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'synthetic-no-provider-key'::text $$;
CREATE OR REPLACE FUNCTION public.automation_lane_enabled(lane text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION pg_temp.sweep_run(qid uuid,st text,miss integer DEFAULT 0,code text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE q record; rid uuid; seq integer;
BEGIN
 SELECT * INTO q FROM public.context_email_sweep_windows WHERE id=qid;
 SELECT count(*) INTO seq FROM public.context_capture_runs WHERE source='outlook_sweep_'||q.source_key;
 INSERT INTO public.context_capture_runs(source,status,started_at,finished_at,window_from,counts,error_code,cursor)
 VALUES('outlook_sweep_'||q.source_key,st,now()-interval '1 minute'+seq*interval '1 microsecond',now()-interval '30 seconds',q.window_from,
 jsonb_build_object('progressed',CASE WHEN st='failed' THEN 0 ELSE 1 END,'sweep_misses',miss),code,
 jsonb_build_object('mode','sweep','backlog',st<>'succeeded','history_from',to_char(q.window_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'history_to',to_char(q.window_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
 RETURNING id INTO rid; RETURN rid;
END $$;

DO $$ DECLARE o jsonb; total integer; keys text[]; a text; b text; q uuid; r uuid; old uuid; n integer; s jsonb; x record;
BEGIN
 PERFORM pg_temp.sweep_check(NOT public.context_email_sweep_continuation_enabled(),'default off');
 PERFORM pg_temp.sweep_check(NOT has_table_privilege('authenticated','public.context_email_sweep_windows','SELECT'),'no staff queue grant');
 PERFORM pg_temp.sweep_check(NOT has_table_privilege('service_role','public.context_email_sweep_windows','UPDATE'),'no service queue mutation grant');
 PERFORM pg_temp.sweep_check(NOT has_function_privilege('service_role','public.context_email_sweep_tick()','EXECUTE'),'only scheduled owner dispatches');
 PERFORM pg_temp.sweep_check(NOT has_function_privilege('anon','public.context_email_sweep_status()','EXECUTE'),'queue status not public');
 SELECT array_agg(source_key ORDER BY source_key COLLATE "C") INTO keys FROM public.monitored_mailboxes WHERE enabled AND status='active' AND kind IN ('user','group');
 total:=cardinality(keys); a:=keys[1]; b:=keys[2];
 PERFORM pg_temp.sweep_check(total>=2,'multiple selected source fixture');
 UPDATE public.feature_flags SET enabled=true,updated_at=now()-interval '3 days' WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2');
 PERFORM public.trigger_context_email_sweep();
 PERFORM pg_temp.sweep_check((SELECT count(*) FROM pg_temp.sweep_posts)=total,'off preserves legacy nightly calls');
 PERFORM pg_temp.sweep_check(NOT EXISTS(SELECT 1 FROM public.context_email_sweep_windows),'off creates no queue');
 DELETE FROM public.feature_flags WHERE flag_name='email_sweep_continuation_v1';
 PERFORM pg_temp.sweep_check(NOT public.context_email_sweep_continuation_enabled(),'missing switch off');
 INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('email_sweep_continuation_v1',true,'synthetic');
 TRUNCATE pg_temp.sweep_posts;
 PERFORM public.trigger_context_email_sweep();
 PERFORM pg_temp.sweep_check((SELECT count(*) FROM public.context_email_sweep_windows)=total,'one exact window per selected source');
 PERFORM pg_temp.sweep_check(NOT EXISTS(SELECT 1 FROM pg_temp.sweep_posts),'nightly enqueues without HTTP fan-out');
 PERFORM public.trigger_context_email_sweep();
 PERFORM pg_temp.sweep_check((SELECT count(*) FROM public.context_email_sweep_windows)=total,'nightly retry idempotent');
 UPDATE public.context_email_sweep_windows SET created_at=now()-interval '2 hours';
 FOR n IN 1..total LOOP
  UPDATE public.context_email_sweep_windows SET last_posted_at=now()-interval '6 minutes' WHERE last_posted_at IS NOT NULL;
  o:=public.context_email_sweep_tick();
  PERFORM pg_temp.sweep_check(o->>'outcome'='posted','one queued source posted');
  PERFORM pg_temp.sweep_check((SELECT count(*) FROM pg_temp.sweep_posts)=n,'one request per tick');
  s:=public.context_email_sweep_tick();
  PERFORM pg_temp.sweep_check(s->>'outcome'='busy','immediate duplicate tick refused');
 END LOOP;
 PERFORM pg_temp.sweep_check((SELECT count(DISTINCT body->>'source') FROM pg_temp.sweep_posts)=total,'all sources get a turn');
 PERFORM pg_temp.sweep_check(NOT EXISTS(SELECT 1 FROM public.context_email_sweep_windows WHERE state='succeeded'),'posted requests never complete windows');
 PERFORM pg_temp.sweep_check((SELECT bool_and(body ? 'from' AND body ? 'to') FROM pg_temp.sweep_posts),'all bounded requests carry exact window');
 SELECT id INTO q FROM public.context_email_sweep_windows WHERE source_key=a;
 -- A success for another window cannot close this one.
 r:=pg_temp.sweep_run(q,'succeeded');
 UPDATE public.context_capture_runs SET cursor=jsonb_set(cursor,'{history_to}',to_jsonb('different-window'::text)) WHERE id=r;
 PERFORM public.context_email_sweep_tick();
 PERFORM pg_temp.sweep_check((SELECT state<>'succeeded' FROM public.context_email_sweep_windows WHERE id=q),'wrong-window success ignored');
 r:=pg_temp.sweep_run(q,'partial',2);
 PERFORM public.context_email_sweep_tick();
 PERFORM pg_temp.sweep_check((SELECT state='pending' AND last_run_id=r AND no_progress=0 FROM public.context_email_sweep_windows WHERE id=q),'partial progress retained not completed');
 r:=pg_temp.sweep_run(q,'succeeded',3);
 PERFORM public.context_email_sweep_tick();
 PERFORM pg_temp.sweep_check((SELECT state='succeeded' AND last_run_id=r AND completed_at IS NOT NULL FROM public.context_email_sweep_windows WHERE id=q),'exact success closes only its window');
 INSERT INTO public.context_capture_runs(source,status,started_at,finished_at,window_from) VALUES('outlook_'||a,'succeeded',now()-interval '3 days',now()-interval '3 days',now()-interval '3 days');
 PERFORM pg_temp.sweep_check(public.context_email_sweep_misses(a,now()-interval '26 hours',now())=5,'partial and final misses aggregate once');
 PERFORM public.context_email_sweep_tick();
 PERFORM pg_temp.sweep_check(public.context_email_sweep_misses(a,now()-interval '26 hours',now())=5,'rechecking receipts does not double count');
 s:=public.context_email_capture_status_at(now()+interval '2 hours');
 PERFORM pg_temp.sweep_check(s ? 'sweep_windows' AND NOT (s->'sweep_windows' ? 'windows'),'shared health exposes aggregate not private source identifiers');
 PERFORM pg_temp.sweep_check(EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') al WHERE al->>'key'='sweep_incomplete'),'unfinished windows remain unhealthy');
 -- Three dispatches without progress back off one source, not all sources.
 UPDATE public.context_email_sweep_windows SET no_progress=3,last_posted_at=now()-interval '6 minutes' WHERE source_key=b;
 UPDATE public.context_email_sweep_windows SET last_posted_at=now()-interval '6 minutes' WHERE source_key<>b;
 o:=public.context_email_sweep_tick();
 PERFORM pg_temp.sweep_check(coalesce(o->>'source','')<>b,'stalled source does not monopolize ticks');
 UPDATE public.monitored_mailboxes SET enabled=false WHERE source_key=b;
 s:=public.context_email_sweep_status();
 PERFORM pg_temp.sweep_check((s->>'disabled_pending')::int=1 AND NOT (s->>'finished')::boolean,'disabled unfinished source retained and visible');
 -- A stale running receipt is not successful and can be retried from its cursor.
 SELECT id INTO q FROM public.context_email_sweep_windows WHERE source_key=keys[3];
 IF q IS NOT NULL THEN
  r:=pg_temp.sweep_run(q,'failed',0,'abandoned');
  PERFORM public.context_email_sweep_tick();
  PERFORM pg_temp.sweep_check((SELECT state='failed' AND last_error='abandoned' FROM public.context_email_sweep_windows WHERE id=q),'abandoned remains failed until actual retry');
  s:=public.context_email_sweep_status();
  PERFORM pg_temp.sweep_check((s->>'receipt_gaps')::int=1,'abandoned metrics gap visible');
  PERFORM pg_temp.sweep_run(q,'succeeded');
  PERFORM public.context_email_sweep_tick();
  s:=public.context_email_sweep_status();
  PERFORM pg_temp.sweep_check((s->>'receipt_gaps')::int=1,'later capture success does not invent missing earlier counts');
 END IF;
 -- Seed a retained window 7 days ago, then enqueue today: every intervening
 -- interval remains represented; later nights cannot overwrite unfinished work.
 TRUNCATE public.context_email_sweep_windows;
 UPDATE public.monitored_mailboxes SET enabled=(source_key=a);
 INSERT INTO public.context_email_sweep_windows(source_key,window_from,window_to,created_at)
 VALUES(a,date_trunc('minute',now())-interval '9 days',date_trunc('minute',now())-interval '7 days',now()-interval '9 days') RETURNING id INTO old;
 PERFORM public.trigger_context_email_sweep();
 PERFORM pg_temp.sweep_check((SELECT count(*) FROM public.context_email_sweep_windows)=5,'missed nights retain intervening bounded windows');
 PERFORM pg_temp.sweep_check(EXISTS(SELECT 1 FROM public.context_email_sweep_windows WHERE id=old AND state='pending'),'old unfinished window preserved');
 PERFORM pg_temp.sweep_check(NOT EXISTS(SELECT 1 FROM (SELECT window_from,lag(window_to) OVER(ORDER BY window_from) prior FROM public.context_email_sweep_windows) x WHERE prior IS NOT NULL AND window_from>prior),'no gap between old and new requests');
 PERFORM pg_temp.sweep_check((SELECT bool_and(window_to-window_from<=interval '48 hours') FROM public.context_email_sweep_windows),'all recovery chunks remain within reader bounds');
 -- Beyond the reader's 60-day limit stays unknown, never silently clamped.
 INSERT INTO public.context_email_sweep_windows(source_key,window_from,window_to) VALUES(a,now()-interval '70 days',now()-interval '68 days');
 s:=public.context_email_sweep_status();
 PERFORM pg_temp.sweep_check((s->>'expired_pending')::int=1 AND NOT (s->>'finished')::boolean,'expired source window stays visible and incomplete');
 -- A current success must not hide that missing historical interval.
 UPDATE public.context_email_sweep_windows SET state='succeeded',completed_at=now() WHERE window_from>=now()-interval '60 days';
 s:=public.context_email_capture_status_at(now());
 PERFORM pg_temp.sweep_check(EXISTS(SELECT 1 FROM jsonb_array_elements(s->'alarms') al WHERE al->>'key'='sweep_incomplete'),'current success cannot hide earlier unfinished window');
END $$;
SELECT jsonb_build_object('assertions',count(*),'result','PASS','scope','synthetic local SQL; no external HTTP') FROM pg_temp.sweep_assertions;
ROLLBACK;

-- Existing poll caller: poll/history retain cadence; sweep errors are isolated.
BEGIN;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.sweep_caller_calls(kind text);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN INSERT INTO pg_temp.sweep_caller_calls VALUES(body->>'mode'); RETURN 1; END $$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'synthetic-no-provider-key'::text $$;
CREATE OR REPLACE FUNCTION public.automation_lane_enabled(lane text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.trigger_context_email_history() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN INSERT INTO pg_temp.sweep_caller_calls VALUES('history'); RETURN '{}'::jsonb; END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2','email_sweep_continuation_v1');
SELECT public.trigger_context_email_sweep();
SELECT public.trigger_context_email_poll();
DO $$ BEGIN
 IF (SELECT array_agg(kind ORDER BY kind) FROM pg_temp.sweep_caller_calls) IS DISTINCT FROM ARRAY['history','poll','sweep'] THEN RAISE EXCEPTION 'sweep caller lost poll/history or duplicated sweep'; END IF;
END $$;
UPDATE public.context_email_sweep_windows SET last_posted_at=now()-interval '6 minutes' WHERE last_posted_at IS NOT NULL;
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE plpgsql AS $$
BEGIN IF body->>'mode'='sweep' THEN RAISE EXCEPTION 'synthetic_enqueue_error'; END IF;
 INSERT INTO pg_temp.sweep_caller_calls VALUES(body->>'mode'); RETURN 1; END $$;
SELECT public.trigger_context_email_poll();
DO $$ BEGIN
 IF (SELECT count(*) FROM pg_temp.sweep_caller_calls WHERE kind='poll')<>2 OR (SELECT count(*) FROM pg_temp.sweep_caller_calls WHERE kind='history')<>2
 OR (SELECT count(*) FROM pg_temp.sweep_caller_calls WHERE kind='sweep')<>1 THEN RAISE EXCEPTION 'sweep caller failure changed other lanes'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_email_sweep_windows WHERE state='succeeded') THEN RAISE EXCEPTION 'enqueue failure completed work'; END IF;
END $$;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='email_sweep_continuation_v1';
SELECT public.trigger_context_email_poll();
DO $$ BEGIN
 IF (SELECT count(*) FROM pg_temp.sweep_caller_calls WHERE kind='poll')<>3 OR (SELECT count(*) FROM pg_temp.sweep_caller_calls WHERE kind='history')<>3
 OR (SELECT count(*) FROM pg_temp.sweep_caller_calls WHERE kind='sweep')<>1 THEN RAISE EXCEPTION 'off switch changed old callers'; END IF;
END $$;
SELECT 'caller integration: 4 assertions PASS, synthetic local only' AS result;
ROLLBACK;

-- Re-apply preserves operator activation and unfinished work; no request is sent.
BEGIN;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_sweep_continuation_v1';
INSERT INTO public.context_email_sweep_windows(source_key,window_from,window_to) VALUES('reapply_fixture',now()-interval '48 hours',now());
\ir ../../../migrations/20261030144532_context_email_sweep_continuation.sql
DO $$ BEGIN
 IF NOT public.context_email_sweep_continuation_enabled() THEN RAISE EXCEPTION 'sweep reapply reset activation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_email_sweep_windows WHERE source_key='reapply_fixture' AND state='pending') THEN RAISE EXCEPTION 'sweep reapply lost work'; END IF;
END $$;
ROLLBACK;
