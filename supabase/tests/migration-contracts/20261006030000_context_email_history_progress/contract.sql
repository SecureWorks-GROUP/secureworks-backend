-- W7 contract: the history tick judges each run once, sets a source that
-- stopped moving aside (stalled) instead of letting it hold the queue, tries it
-- again later, and has no call limit. Reproduces the fencing restart loop of
-- 5 Oct 2026 (every run partial, nothing moved) and proves it can no longer
-- hold the other mailboxes. Every fixture write is rolled back.

CREATE FUNCTION pg_temp.w7_iso(t timestamptz) RETURNS text LANGUAGE sql AS $$
 SELECT to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- A finished history run of a source's current plan window.
CREATE FUNCTION pg_temp.w7_run(p_key text,p_status text,p_counts jsonb,p_code text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p record; id uuid;
BEGIN
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=p_key;
 INSERT INTO public.context_capture_runs(source,status,started_at,finished_at,counts,error_code,cursor)
 VALUES('outlook_history_'||p_key,p_status,clock_timestamp(),clock_timestamp(),p_counts,p_code,
  jsonb_build_object('mode','history','backlog',p_status<>'succeeded','history_from',pg_temp.w7_iso(p.window_from),'history_to',pg_temp.w7_iso(p.window_to)))
 RETURNING context_capture_runs.id INTO id;
 RETURN id;
END $$;

-- 1. Shape and access. (The bodies are pinned, and the re-apply proved, in
-- sections 5 and 6, after the behaviour, so a broken body is caught by what
-- it does first.)
DO $$
DECLARE f regprocedure;
BEGIN
 IF (SELECT count(*) FROM pg_attribute WHERE attrelid='public.context_email_history_plan'::regclass AND NOT attisdropped
   AND attname IN ('posts_since_progress','last_run_id','last_progress_at','stalled_at','stall_reason','stalls'))<>6
 THEN RAISE EXCEPTION 'w7 plan columns missing'; END IF;
 IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='context_email_history_plan_state_check'
   AND conrelid='public.context_email_history_plan'::regclass)) NOT LIKE '%stalled%'
 THEN RAISE EXCEPTION 'w7 state check does not admit stalled'; END IF;
 FOREACH f IN ARRAY ARRAY['public.trigger_context_email_history()','public.context_email_history_status()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
  THEN RAISE EXCEPTION 'w7 % executable by anon or authenticated',f; END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f)
   OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND EXISTS(SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%'))
  THEN RAISE EXCEPTION 'w7 % must be SECURITY DEFINER with a fixed search_path',f; END IF;
 END LOOP;
 IF has_function_privilege('service_role','public.trigger_context_email_history()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_email_history_status()','EXECUTE')
 THEN RAISE EXCEPTION 'w7 grants'; END IF;
 IF has_table_privilege('anon','public.context_email_history_plan','SELECT') OR has_table_privilege('authenticated','public.context_email_history_plan','SELECT')
  OR has_table_privilege('service_role','public.context_email_history_plan','UPDATE')
 THEN RAISE EXCEPTION 'w7 plan access widened'; END IF;
END $$;


BEGIN;
-- 3. The tick, on stand-ins for net.http_post and the service key.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.w7_posts(seq bigserial,url text,body jsonb,headers jsonb,timeout_ms integer);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO pg_temp.w7_posts(url,body,headers,timeout_ms) VALUES(url,body,headers,timeout_milliseconds) RETURNING seq
$$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.w7.fixture'::text $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2','email_reader_history_v1');
DO $$
DECLARE o jsonb; p record; s jsonb; src text[]; a text; b text; c text; r3 uuid; i integer;
BEGIN
 SELECT array_agg(source_key ORDER BY source_key COLLATE "C") INTO src FROM public.monitored_mailboxes
 WHERE enabled AND status='active' AND kind IN ('user','group');
 a:=src[1]; b:=src[2]; c:=src[3];

 -- First call: the first source, one call since progress.
 o:=public.trigger_context_email_history();
 IF o->>'outcome'<>'posted' OR o->>'source'<>a THEN RAISE EXCEPTION 'w7 first tick %',o; END IF;
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=a;
 IF p.state<>'loading' OR p.posts<>1 THEN RAISE EXCEPTION 'w7 first plan row %',row_to_json(p); END IF;

 -- The fencing restart loop (5 Oct 2026): every run 'partial', nothing saved,
 -- no cursor. B-1 kept posting the same source for 288 calls while every
 -- other mailbox waited. Now: three calls without a move and it is set aside.
 PERFORM pg_temp.w7_run(a,'partial','{"seen":316,"inserted":0,"duplicates":79}');
 o:=public.trigger_context_email_history();
 IF o->>'source'<>a THEN RAISE EXCEPTION 'w7 loop call 2 %',o; END IF;
 PERFORM pg_temp.w7_run(a,'partial','{"seen":452,"inserted":0,"progressed":0}');
 o:=public.trigger_context_email_history();
 IF o->>'source'<>a THEN RAISE EXCEPTION 'w7 loop call 3 %',o; END IF;
 r3:=pg_temp.w7_run(a,'partial','{"seen":384,"inserted":0,"progressed":0}');
 o:=public.trigger_context_email_history();
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=a;
 IF p.state<>'stalled' OR p.stall_reason<>'no_progress' OR p.stalls<>1 OR p.stalled_at IS NULL OR p.last_run_id IS DISTINCT FROM r3
  OR p.posts<>3 OR p.posts_since_progress<>3 OR p.last_progress_at IS NOT NULL
 THEN RAISE EXCEPTION 'w7 loop not set aside %',row_to_json(p); END IF;
 -- ...and the next mailbox is called in the same tick.
 IF o->>'outcome'<>'posted' OR o->>'source'<>b THEN RAISE EXCEPTION 'w7 next source not called %',o; END IF;
 -- The status says so: not finished, the stalled source named with its reason.
 s:=public.context_email_history_status();
 IF (s->>'finished')::boolean OR (s->'by_state'->>'stalled')::int<>1
  OR s->'attention'<>jsonb_build_array(jsonb_build_object('source_key',a,'state','stalled','reason','no_progress','since',p.stalled_at,
    'last_progress_at',NULL,'posts',3,'stalls',1))
 THEN RAISE EXCEPTION 'w7 status attention %',s->'attention'; END IF;

 -- A run that moved (counts.progressed) resets the count; a run is judged once.
 PERFORM pg_temp.w7_run(b,'partial','{"inserted":0,"progressed":42}');
 o:=public.trigger_context_email_history();
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=b;
 IF o->>'source'<>b OR p.posts_since_progress<>1 OR p.last_progress_at IS NULL OR p.posts<>2
 THEN RAISE EXCEPTION 'w7 progress did not reset %',row_to_json(p); END IF;
 o:=public.trigger_context_email_history();  -- no new run: the same run is not judged again
 IF (SELECT posts_since_progress FROM public.context_email_history_plan WHERE source_key=b)<>2
 THEN RAISE EXCEPTION 'w7 a run was judged twice'; END IF;
 -- A run of the reader before W7 (no progressed count) moved when it saved rows.
 PERFORM pg_temp.w7_run(b,'partial','{"inserted":3}');
 o:=public.trigger_context_email_history();
 IF (SELECT posts_since_progress FROM public.context_email_history_plan WHERE source_key=b)<>1
 THEN RAISE EXCEPTION 'w7 an older run that saved rows read as no progress'; END IF;

 -- No call limit: a source still moving keeps loading past B-1's 288.
 UPDATE public.context_email_history_plan SET posts=500 WHERE source_key=b;
 PERFORM pg_temp.w7_run(b,'partial','{"progressed":7}');
 o:=public.trigger_context_email_history();
 IF o->>'source'<>b OR (SELECT state||':'||posts FROM public.context_email_history_plan WHERE source_key=b)<>'loading:501'
 THEN RAISE EXCEPTION 'w7 a moving source was given up %',o; END IF;

 -- A failed run that moved nothing stalls under its error code.
 FOR i IN 1..3 LOOP
  PERFORM pg_temp.w7_run(b,'failed','{"progressed":0}','graph_503');
  o:=public.trigger_context_email_history();
 END LOOP;
 IF (SELECT state||':'||stall_reason FROM public.context_email_history_plan WHERE source_key=b)<>'stalled:graph_503' OR o->>'source'<>c
 THEN RAISE EXCEPTION 'w7 failed runs %',(SELECT row_to_json(x) FROM public.context_email_history_plan x WHERE source_key=b); END IF;

 -- Calls the reader never answered (no run at all) stall as no_run.
 o:=public.trigger_context_email_history();
 o:=public.trigger_context_email_history();
 o:=public.trigger_context_email_history();
 IF (SELECT state||':'||stall_reason||':'||posts FROM public.context_email_history_plan WHERE source_key=c)<>'stalled:no_run:3'
 THEN RAISE EXCEPTION 'w7 no_run %',(SELECT row_to_json(x) FROM public.context_email_history_plan x WHERE source_key=c); END IF;

 -- While its run is running the source waits, as in B-1.
 INSERT INTO public.context_capture_runs(source,status) VALUES('outlook_history_'||src[4],'running');
 o:=public.trigger_context_email_history();
 IF o->>'outcome'<>'waiting' OR o->>'source'<>src[4] THEN RAISE EXCEPTION 'w7 waiting %',o; END IF;
 DELETE FROM public.context_capture_runs WHERE source='outlook_history_'||src[4];

 -- Every other source finished: a stalled source rests 6 hours, then is tried
 -- again with fresh calls; it never silently stops.
 UPDATE public.context_email_history_plan SET state='succeeded' WHERE state IN ('pending','loading');
 DELETE FROM pg_temp.w7_posts;
 o:=public.trigger_context_email_history();
 IF o->>'outcome'<>'finished' OR (o->>'stalled')::int<>3 OR (SELECT count(*) FROM pg_temp.w7_posts)<>0
 THEN RAISE EXCEPTION 'w7 a resting source was called %',o; END IF;
 IF (public.context_email_history_status()->>'finished')::boolean THEN RAISE EXCEPTION 'w7 finished while sources are stalled'; END IF;
 UPDATE public.context_email_history_plan SET stalled_at=now()-interval '7 hours' WHERE source_key IN (a,c);
 o:=public.trigger_context_email_history();
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=a;
 IF o->>'source'<>a OR NOT (o->>'retry')::boolean OR p.state<>'loading' OR p.posts_since_progress<>1 OR p.stalls<>1 OR p.posts<>4
 THEN RAISE EXCEPTION 'w7 retry %, %',o,row_to_json(p); END IF;
 -- Pending and loading sources go before a stalled retry.
 UPDATE public.context_email_history_plan SET state='pending', posts=0, posts_since_progress=0, window_from=NULL, window_to=NULL WHERE source_key=src[5];
 PERFORM pg_temp.w7_run(a,'partial','{"progressed":1}');
 o:=public.trigger_context_email_history();
 IF o->>'source'<>a THEN RAISE EXCEPTION 'w7 loading source skipped %',o; END IF;
 UPDATE public.context_email_history_plan SET state='succeeded' WHERE source_key=a;
 o:=public.trigger_context_email_history();
 IF o->>'source'<>src[5] THEN RAISE EXCEPTION 'w7 a stalled retry went before a pending source %',o; END IF;

 -- A succeeded run finishes the source and lists its jobs, as in B-1.
 PERFORM pg_temp.w7_run(src[5],'succeeded','{"progressed":0}');
 o:=public.trigger_context_email_history();
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=src[5];
 IF p.state<>'succeeded' OR p.succeeded_at IS NULL OR p.listed IS NULL OR p.posts_since_progress<>0
 THEN RAISE EXCEPTION 'w7 succeeded %',row_to_json(p); END IF;
 -- The resting retry (c) is the one left.
 IF o->>'source'<>c OR NOT (o->>'retry')::boolean THEN RAISE EXCEPTION 'w7 retry of c %',o; END IF;

 -- A source no longer selected is given up, stalled or not.
 UPDATE public.context_email_history_plan SET state='stalled', stalled_at=now()-interval '7 hours' WHERE source_key=c;
 UPDATE public.monitored_mailboxes SET enabled=false WHERE source_key=c;
 o:=public.trigger_context_email_history();
 IF (SELECT state||':'||gave_up_reason FROM public.context_email_history_plan WHERE source_key=c)<>'gave_up:source_not_selected'
 THEN RAISE EXCEPTION 'w7 not selected %',o; END IF;
 s:=public.context_email_history_status();
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'attention') x WHERE x->>'source_key'=c AND x->>'reason'='source_not_selected')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'attention') x WHERE x->>'source_key'=b AND x->>'reason'='graph_503')
  OR jsonb_array_length(s->'plan')<>cardinality(src) OR NOT (s->'plan'->0 ? 'posts_since_progress')
 THEN RAISE EXCEPTION 'w7 status %',s; END IF;
END $$;

-- 3b. A window whose end has passed the reader's 60-day limit. With no call
-- limit, a source can stay loading or stalled (retried every 6 hours) for 59
-- days; moving its start to 59 days back would then reach its fixed end and
-- break the plan's window check, failing every tick for every source. It is
-- given up as window_expired instead, and the next source is called.
DO $$
DECLARE o jsonb; s jsonb; src text[]; nowm timestamptz:=date_trunc('minute',now()); p record;
BEGIN
 SELECT array_agg(source_key ORDER BY source_key COLLATE "C") INTO src FROM public.monitored_mailboxes
 WHERE enabled AND status='active' AND kind IN ('user','group');
 UPDATE public.context_email_history_plan SET state='succeeded' WHERE state<>'succeeded';
 -- src[6]: loading, its window ending exactly 59 days back (the first minute
 -- the moved start meets the end).
 UPDATE public.context_email_history_plan SET state='loading', posts=40, posts_since_progress=1,
  window_from=nowm-interval '118 days', window_to=nowm-interval '59 days' WHERE source_key=src[6];
 -- src[7]: a new mailbox, pending, behind it.
 UPDATE public.context_email_history_plan SET state='pending', posts=0, posts_since_progress=0, window_from=NULL, window_to=NULL WHERE source_key=src[7];
 -- src[2]: stalled and rested, its window ended 70 days ago.
 UPDATE public.context_email_history_plan SET state='stalled', stalled_at=now()-interval '7 hours', stall_reason='group_not_found',
  window_from=nowm-interval '129 days', window_to=nowm-interval '70 days' WHERE source_key=src[2];
 -- src[8]: stalled and rested, its window ended 58 days ago: still in reach,
 -- so it is retried on a moved start with its end kept.
 UPDATE public.context_email_history_plan SET state='stalled', stalled_at=now()-interval '7 hours', stall_reason='no_progress', replans=0,
  window_from=nowm-interval '117 days', window_to=nowm-interval '58 days' WHERE source_key=src[8];
 DELETE FROM pg_temp.w7_posts;

 o:=public.trigger_context_email_history();
 IF (SELECT state||':'||gave_up_reason FROM public.context_email_history_plan WHERE source_key=src[6]) IS DISTINCT FROM 'gave_up:window_expired'
 THEN RAISE EXCEPTION 'w7 expired loading window %',(SELECT row_to_json(x) FROM public.context_email_history_plan x WHERE source_key=src[6]); END IF;
 IF o->>'outcome'<>'posted' OR o->>'source'<>src[7] OR (SELECT count(*) FROM pg_temp.w7_posts)<>1
 THEN RAISE EXCEPTION 'w7 the next source was not called after an expired window %',o; END IF;

 UPDATE public.context_email_history_plan SET state='succeeded' WHERE source_key=src[7];
 DELETE FROM pg_temp.w7_posts;
 o:=public.trigger_context_email_history();
 IF (SELECT state||':'||gave_up_reason FROM public.context_email_history_plan WHERE source_key=src[2]) IS DISTINCT FROM 'gave_up:window_expired'
 THEN RAISE EXCEPTION 'w7 expired stalled window %',(SELECT row_to_json(x) FROM public.context_email_history_plan x WHERE source_key=src[2]); END IF;
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=src[8];
 IF o->>'outcome'<>'posted' OR o->>'source'<>src[8] OR NOT (o->>'retry')::boolean OR p.state<>'loading'
  OR p.window_from<>nowm-interval '59 days' OR p.window_to<>nowm-interval '58 days' OR p.replans<>1
  OR (SELECT body->>'to' FROM pg_temp.w7_posts)<>pg_temp.w7_iso(nowm-interval '58 days')
 THEN RAISE EXCEPTION 'w7 a window still in reach was not retried on a moved start %, %',o,row_to_json(p); END IF;

 s:=public.context_email_history_status();
 IF (SELECT count(*) FROM jsonb_array_elements(s->'attention') x WHERE x->>'reason'='window_expired' AND x->>'state'='gave_up'
   AND x->>'source_key' IN (src[2],src[6]))<>2
 THEN RAISE EXCEPTION 'w7 expired windows not in attention %',s->'attention'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 4. The 5-minute poll caller still runs one tick after its poll, and a tick
-- fault never stops the poll.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.w7_posts(seq bigserial,url text,body jsonb,headers jsonb,timeout_ms integer);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO pg_temp.w7_posts(url,body,headers,timeout_ms) VALUES(url,body,headers,timeout_milliseconds) RETURNING seq
$$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.w7.fixture'::text $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2','email_reader_history_v1');
SELECT public.trigger_context_email_poll();
DO $$
BEGIN
 IF (SELECT array_agg(body->>'mode' ORDER BY seq) FROM pg_temp.w7_posts) IS DISTINCT FROM ARRAY['poll','history']
 THEN RAISE EXCEPTION 'w7 poll plus history %',(SELECT jsonb_agg(body) FROM pg_temp.w7_posts); END IF;
END $$;
ROLLBACK;

-- 5. The bodies are the ones the guard accepts on a re-apply, and B-1's poll
-- caller is untouched.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_history()'::regprocedure)<>'e3bf7cccc57fbbd2f740565695321a66'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_email_history_status()'::regprocedure)<>'528c22d64509a47cf039859d09ae1447'
 THEN RAISE EXCEPTION 'w7 bodies differ from the md5s the guard accepts on a re-apply'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_poll()'::regprocedure)<>'1430e54e4443b839865d3b4874793e15'
 THEN RAISE EXCEPTION 'w7 must leave B-1''s poll caller alone'; END IF;
END $$;

-- 6. A re-apply changes nothing.
BEGIN;
CREATE TEMP TABLE w7_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p WHERE p.oid IN ('public.trigger_context_email_history()'::regprocedure,'public.context_email_history_status()'::regprocedure);
\ir ../../../migrations/20261006030000_context_email_history_progress.sql
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM w7_before b JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc)<>b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note)
 THEN RAISE EXCEPTION 'w7 re-apply changed a function'; END IF;
END $$;
ROLLBACK;
