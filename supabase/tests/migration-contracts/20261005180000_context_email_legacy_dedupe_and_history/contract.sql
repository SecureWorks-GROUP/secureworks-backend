-- Gap plan B-1 contract: the old-path lookup, the history re-list writer and
-- the self-stopping history tick. Every fixture write is rolled back. Ids,
-- addresses, job numbers and text are synthetic.

-- A row through the real insert trigger, written_as stripped (as a service
-- write reads), then moved back p_ago.
CREATE FUNCTION pg_temp.b1_ev(p_job uuid,p_source text,p_mode text,p_ago interval,p_body text DEFAULT 'B1 synthetic words')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,source,payload,metadata,occurred_at,event_at)
  VALUES(p_job,'direct_job_id','inbound','client.email_in',p_source,jsonb_build_object('body',p_body),
   jsonb_build_object('capture_mode',p_mode),now()-p_ago,now()-p_ago-interval '30 days')
  RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at=now()-p_ago,
  attributed_at=CASE WHEN attributed_at IS NULL THEN NULL ELSE now()-p_ago END,
  metadata=coalesce(metadata,'{}'::jsonb)-'written_as' WHERE id=new_id;
 RETURN new_id;
END $$;

CREATE FUNCTION pg_temp.b1_job(p_number text,p_meta jsonb DEFAULT '{}'::jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,p_meta);
 RETURN j;
END $$;

-- A done extraction run p_ago back, with luna_v2 receipts for every row on the job then.
CREATE FUNCTION pg_temp.b1_read(p_job uuid,p_ago interval) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE run uuid; d date:=((now()-p_ago) AT TIME ZONE 'Australia/Perth')::date;
BEGIN
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,run_seq,started_at,finished_at)
  VALUES(p_job,d,'extraction','done',coalesce((SELECT max(run_seq) FROM public.context_extraction_runs WHERE job_id=p_job AND run_date=d),0)+1,
   now()-p_ago,now()-p_ago) RETURNING id INTO run;
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,run_id)
  SELECT e.id,p_job,run FROM public.business_events e WHERE e.job_id=p_job ON CONFLICT DO NOTHING;
 RETURN run;
END $$;

-- What one call said about the B1- jobs: job_number -> action/mode.
CREATE FUNCTION pg_temp.b1_mine(r jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT coalesce(jsonb_object_agg(x->>'job_number',(x->>'action')||'/'||(x->>'mode')),'{}'::jsonb)
 FROM jsonb_array_elements(r->'jobs') x WHERE x->>'job_number' LIKE 'B1-%' $$;

CREATE FUNCTION pg_temp.b1_iso(t timestamptz) RETURNS text LANGUAGE sql AS $$
 SELECT to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- 1. Shape and access.
DO $$
DECLARE f regprocedure;
BEGIN
 IF (SELECT enabled FROM public.feature_flags WHERE flag_name='email_reader_history_v1') IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'b1 history flag must be created off'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_email_legacy_copy(text,timestamptz,text)','public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer)',
  'public.context_email_history_status()','public.trigger_context_email_history()','public.trigger_context_email_poll()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
  THEN RAISE EXCEPTION 'b1 % executable by anon or authenticated',f; END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f)
   OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=f AND proconfig IS NOT NULL AND EXISTS(SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%'))
  THEN RAISE EXCEPTION 'b1 % must be SECURITY DEFINER with a fixed search_path',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_email_legacy_copy(text,timestamptz,text)','public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer)',
  'public.context_email_history_status()']::regprocedure[] LOOP
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'b1 service_role cannot execute %',f; END IF;
 END LOOP;
 IF has_function_privilege('service_role','public.trigger_context_email_history()','EXECUTE')
  OR has_function_privilege('service_role','public.trigger_context_email_poll()','EXECUTE')
 THEN RAISE EXCEPTION 'b1 cron callers must not be callable by service_role'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_email_history_plan'::regclass)
  OR has_table_privilege('anon','public.context_email_history_plan','SELECT') OR has_table_privilege('authenticated','public.context_email_history_plan','SELECT')
  OR has_table_privilege('service_role','public.context_email_history_plan','INSERT') OR NOT has_table_privilege('service_role','public.context_email_history_plan','SELECT')
 THEN RAISE EXCEPTION 'b1 plan access'; END IF;
 IF (SELECT prosrc FROM pg_proc WHERE oid='public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer)'::regprocedure)
   NOT LIKE '%pg_advisory_xact_lock(20260924,22)%'
 THEN RAISE EXCEPTION 'b1 re-list does not take the catch-up lock'; END IF;
 -- No new cron job and the lane list is untouched (the tick rides outlook-mail-poll).
 -- ghl-history-schedule is B-2's own lane (20261005190000), registered after this one.
 IF EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() WHERE cron_jobname LIKE '%history%' AND cron_jobname<>'ghl-history-schedule')
 THEN RAISE EXCEPTION 'b1 added a cron lane'; END IF;
END $$;

BEGIN;
-- 2. The old path's copy: same sender and same received time, or within two
-- minutes with the same subject. Never the reader's own row, another sender,
-- another subject past the same second, or three minutes away.
DO $$
DECLARE t timestamptz:='2026-09-20T02:00:00Z'; a uuid; b uuid; c uuid; r uuid; got uuid;
BEGIN
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,payload,occurred_at)
  VALUES('client.email_in','monitor_inbox','unmatched_contact','unmatched',
   jsonb_build_object('from','Pat.Example@Example.com','subject','Re:  Patio  quote'),t) RETURNING id INTO a;
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,payload,occurred_at,event_at)
  VALUES('supplier.email_in','monitor-inbox','unmatched_supplier','x',
   jsonb_build_object('from','orders@steelsupply.example','subject','PO-55501 delivery'),t+interval '1 hour',t+interval '1 hour') RETURNING id INTO b;
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,payload,occurred_at,event_at)
  VALUES('client.email_in','monitor-inbox-group','unmatched_contact','x',
   jsonb_build_object('from','approvals@council.wa.gov.au','subject','(no subject)'),t+interval '2 hours',t+interval '2 hours') RETURNING id INTO c;
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,payload,occurred_at,event_at,provider_message_id)
  VALUES('client.email_in','outlook-mail-capture','email','email:b1-own@mail.example.com',
   jsonb_build_object('from','sam.sample@example.net','subject','Own row'),t+interval '3 hours',t+interval '3 hours','email:b1-own@mail.example.com') RETURNING id INTO r;

 got:=public.context_email_legacy_copy('pat.example@example.com',t,'anything');
 IF got IS DISTINCT FROM a THEN RAISE EXCEPTION 'b1 legacy: same sender and second missed (%)',got; END IF;
 got:=public.context_email_legacy_copy(' PAT.example@example.com ',t,NULL);
 IF got IS DISTINCT FROM a THEN RAISE EXCEPTION 'b1 legacy: sender case missed'; END IF;
 got:=public.context_email_legacy_copy('pat.example@example.com',t+interval '40 seconds','re: patio quote');
 IF got IS DISTINCT FROM a THEN RAISE EXCEPTION 'b1 legacy: another mailbox copy (same subject, 40 s) missed'; END IF;
 IF public.context_email_legacy_copy('pat.example@example.com',t+interval '40 seconds','Another email') IS NOT NULL
 THEN RAISE EXCEPTION 'b1 legacy: a different email 40 s later read as a copy'; END IF;
 IF public.context_email_legacy_copy('pat.example@example.com',t+interval '3 minutes','Re: Patio quote') IS NOT NULL
 THEN RAISE EXCEPTION 'b1 legacy: 3 minutes away read as a copy'; END IF;
 IF public.context_email_legacy_copy('other@example.com',t,'Re: Patio quote') IS NOT NULL
 THEN RAISE EXCEPTION 'b1 legacy: another sender read as a copy'; END IF;
 IF public.context_email_legacy_copy('orders@steelsupply.example',t+interval '1 hour','x') IS DISTINCT FROM b
 THEN RAISE EXCEPTION 'b1 legacy: monitor-inbox (recordEvidence) row missed'; END IF;
 IF public.context_email_legacy_copy('approvals@council.wa.gov.au',t+interval '2 hours','') IS DISTINCT FROM c
 THEN RAISE EXCEPTION 'b1 legacy: group post row missed'; END IF;
 IF public.context_email_legacy_copy('approvals@council.wa.gov.au',t+interval '2 hours 30 seconds','') IS NOT NULL
 THEN RAISE EXCEPTION 'b1 legacy: an empty subject matched across seconds'; END IF;
 IF public.context_email_legacy_copy('sam.sample@example.net',t+interval '3 hours','Own row') IS NOT NULL
 THEN RAISE EXCEPTION 'b1 legacy: the reader''s own row read as an old copy'; END IF;
 IF public.context_email_legacy_copy(NULL,t,'x') IS NOT NULL OR public.context_email_legacy_copy('pat.example@example.com',NULL,'x') IS NOT NULL
  OR public.context_email_legacy_copy('',t,'x') IS NOT NULL
 THEN RAISE EXCEPTION 'b1 legacy: an empty key matched'; END IF;
END $$;
ROLLBACK;

-- 3. Bad re-list arguments refuse before anything is read.
DO $$
BEGIN
 BEGIN PERFORM public.context_catchup_list_backfill(NULL,now()); RAISE EXCEPTION 'b1 re-list accepted no source';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_catchup_backfill_source_invalid%' THEN RAISE; END IF; END;
 BEGIN PERFORM public.context_catchup_list_backfill('outlook-mail-capture',NULL); RAISE EXCEPTION 'b1 re-list accepted no since';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_catchup_backfill_since_invalid%' THEN RAISE; END IF; END;
 BEGIN PERFORM public.context_catchup_list_backfill('outlook-mail-capture',now(),true,0); RAISE EXCEPTION 'b1 re-list accepted limit 0';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_catchup_backfill_limit_invalid%' THEN RAISE; END IF; END;
 BEGIN PERFORM public.context_catchup_list_backfill('outlook-mail-capture',now(),true,10,6); RAISE EXCEPTION 'b1 re-list accepted priority 6';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_catchup_backfill_priority_invalid%' THEN RAISE; END IF; END;
END $$;

BEGIN;
-- 4. The re-list: every job holding backfill rows of the named source since
-- the given time is listed for reading, with the backlog writer's modes and
-- actions; live rows, other sources, older loads and holding jobs are not.
DO $$
DECLARE since timestamptz:=now()-interval '1 hour';
 never uuid; seen uuid; done uuid; pending uuid; live_only uuid; other_src uuid; older uuid; holding uuid; read_all uuid;
 r jsonb; before text; want jsonb;
BEGIN
 never:=pg_temp.b1_job('B1-NEVER');
 PERFORM pg_temp.b1_ev(never,'outlook-mail-capture','backfill','10 minutes');

 seen:=pg_temp.b1_job('B1-SEEN');
 PERFORM pg_temp.b1_ev(seen,'outlook-mail-capture','live','3 days');
 PERFORM pg_temp.b1_read(seen,'2 days');
 PERFORM pg_temp.b1_ev(seen,'outlook-mail-capture','backfill','10 minutes');

 done:=pg_temp.b1_job('B1-DONE');
 PERFORM pg_temp.b1_ev(done,'outlook-mail-capture','live','3 days');
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope,done_at,done_run_id)
  VALUES(done,'B1-DONE',4,'unread','backlog',now()-interval '2 days',pg_temp.b1_read(done,'2 days'));
 PERFORM pg_temp.b1_ev(done,'outlook-mail-capture','backfill','10 minutes');

 pending:=pg_temp.b1_job('B1-PENDING');
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope) VALUES(pending,'B1-PENDING',5,'full','backlog');
 PERFORM pg_temp.b1_ev(pending,'outlook-mail-capture','backfill','10 minutes');

 read_all:=pg_temp.b1_job('B1-READ');
 PERFORM pg_temp.b1_ev(read_all,'outlook-mail-capture','backfill','20 minutes');
 PERFORM pg_temp.b1_read(read_all,'5 minutes');

 live_only:=pg_temp.b1_job('B1-LIVEONLY');
 PERFORM pg_temp.b1_ev(live_only,'outlook-mail-capture','live','10 minutes');
 other_src:=pg_temp.b1_job('B1-OTHERSRC');
 PERFORM pg_temp.b1_ev(other_src,'ghl-history-load','backfill','10 minutes');
 older:=pg_temp.b1_job('B1-OLDER');
 PERFORM pg_temp.b1_ev(older,'outlook-mail-capture','backfill','3 hours');
 holding:=pg_temp.b1_job('B1-HOLD','{"do_not_schedule":"true"}');
 PERFORM pg_temp.b1_ev(holding,'outlook-mail-capture','backfill','10 minutes');

 SELECT md5(string_agg(to_jsonb(c)::text,',' ORDER BY c.job_id)) INTO before FROM public.context_catchup_jobs c;
 r:=public.context_catchup_list_backfill('outlook-mail-capture',since);
 want:='{"B1-NEVER":"add/full","B1-SEEN":"add/unread","B1-DONE":"reopen/unread","B1-PENDING":"raise/full"}';
 IF pg_temp.b1_mine(r)<>want THEN RAISE EXCEPTION 'b1 re-list dry run %',r; END IF;
 IF (r->>'dry_run')::boolean IS NOT TRUE OR r->'written'<>'null'::jsonb
  OR (r->'excluded'->>'holding_job')::int<>1 OR (r->'excluded'->>'nothing_unread')::int<>1 OR (r->>'jobs_with_backfill')::int<>6
 THEN RAISE EXCEPTION 'b1 re-list summary %',r; END IF;
 IF (SELECT md5(string_agg(to_jsonb(c)::text,',' ORDER BY c.job_id)) FROM public.context_catchup_jobs c) IS DISTINCT FROM before
 THEN RAISE EXCEPTION 'b1 re-list dry run wrote'; END IF;

 r:=public.context_catchup_list_backfill('outlook-mail-capture',since,false);
 IF r->'written'<>'{"added":2,"reopened":1,"priority_raised":1}' THEN RAISE EXCEPTION 'b1 re-list write %',r->'written'; END IF;
 IF (SELECT array_agg(job_number||':'||priority||':'||mode||':'||scope||':'||(done_at IS NULL) ORDER BY job_number) FROM public.context_catchup_jobs
     WHERE job_number LIKE 'B1-%')
   IS DISTINCT FROM ARRAY['B1-DONE:2:unread:backlog:true','B1-NEVER:2:full:backlog:true','B1-PENDING:2:full:backlog:true','B1-SEEN:2:unread:backlog:true']
 THEN RAISE EXCEPTION 'b1 re-list rows %',(SELECT jsonb_agg(to_jsonb(c)) FROM public.context_catchup_jobs c WHERE job_number LIKE 'B1-%'); END IF;

 -- A second call changes nothing; the GHL history load uses the same writer with its own source.
 r:=public.context_catchup_list_backfill('outlook-mail-capture',since,false);
 IF r->'written'<>'{"added":0,"reopened":0,"priority_raised":0}' OR (r->'excluded'->>'already_listed')::int<>4
 THEN RAISE EXCEPTION 'b1 re-list second call %',r; END IF;
 r:=public.context_catchup_list_backfill('ghl-history-load',since,false);
 IF pg_temp.b1_mine(r)<>'{"B1-OTHERSRC":"add/full"}' THEN RAISE EXCEPTION 'b1 re-list ghl source %',r; END IF;
END $$;
ROLLBACK;

-- W7 (20261006030000) replaced the tick's 288-call limit with its progress
-- rules; its own contract proves the tick, so section 5 runs only while the
-- tick is still this migration's body.
SELECT coalesce(obj_description(to_regprocedure('public.trigger_context_email_history()'),'pg_proc'),'')
 LIKE 'Gap plan B-1 and W7 (20261006030000):%' AS b1_w7_live \gset
\if :b1_w7_live
\else
BEGIN;
-- 5. The history tick, on stand-ins for net.http_post and the service key.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.b1_posts(seq bigserial,url text,body jsonb,headers jsonb,timeout_ms integer);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO pg_temp.b1_posts(url,body,headers,timeout_ms) VALUES(url,body,headers,timeout_milliseconds) RETURNING seq
$$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.b1.fixture'::text $$;
DO $$
DECLARE o jsonb; p record; sources text[]; first_key text; second_key text; j uuid; s jsonb;
BEGIN
 SELECT array_agg(source_key ORDER BY source_key) INTO sources FROM public.monitored_mailboxes WHERE enabled AND status='active' AND kind IN ('user','group');
 first_key:=sources[1]; second_key:=sources[2];

 -- Idle while any reader flag or the history flag is off: no post, no plan row.
 o:=public.trigger_context_email_history();
 IF o->>'reason'<>'reader_flags_off' THEN RAISE EXCEPTION 'b1 tick flags off %',o; END IF;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2');
 o:=public.trigger_context_email_history();
 IF o->>'reason'<>'email_reader_history_v1_off' THEN RAISE EXCEPTION 'b1 tick history off %',o; END IF;
 IF (SELECT count(*) FROM pg_temp.b1_posts)<>0 OR EXISTS(SELECT 1 FROM public.context_email_history_plan)
 THEN RAISE EXCEPTION 'b1 tick acted while off'; END IF;

 -- On: every selected source is planned; one call, for the first source, with a fixed 59-day window.
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_reader_history_v1';
 o:=public.trigger_context_email_history();
 IF o->>'outcome'<>'posted' OR o->>'source'<>first_key THEN RAISE EXCEPTION 'b1 first tick %',o; END IF;
 IF (SELECT array_agg(source_key ORDER BY source_key) FROM public.context_email_history_plan) IS DISTINCT FROM sources
 THEN RAISE EXCEPTION 'b1 plan sources'; END IF;
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=first_key;
 IF p.state<>'loading' OR p.posts<>1 OR p.window_to<>date_trunc('minute',now()) OR p.window_from<>p.window_to-interval '59 days'
 THEN RAISE EXCEPTION 'b1 first plan row %',row_to_json(p); END IF;
 IF (SELECT count(*) FROM pg_temp.b1_posts)<>1
  OR (SELECT body FROM pg_temp.b1_posts)<>jsonb_build_object('mode','history','source',first_key,'from',pg_temp.b1_iso(p.window_from),
    'to',pg_temp.b1_iso(p.window_to),'actor','cron:outlook-mail-history')
  OR (SELECT url FROM pg_temp.b1_posts)<>'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture'
  OR (SELECT headers->>'Authorization' FROM pg_temp.b1_posts)<>'Bearer eyJ.b1.fixture'
 THEN RAISE EXCEPTION 'b1 first post %',(SELECT jsonb_agg(to_jsonb(x)) FROM pg_temp.b1_posts x); END IF;

 -- Its run still running: wait. A cut run (partial) resumes: same source, same window.
 INSERT INTO public.context_capture_runs(source,status) VALUES('outlook_history_'||first_key,'running');
 o:=public.trigger_context_email_history();
 IF o->>'outcome'<>'waiting' OR (SELECT count(*) FROM pg_temp.b1_posts)<>1 THEN RAISE EXCEPTION 'b1 waiting %',o; END IF;
 UPDATE public.context_capture_runs SET status='partial', finished_at=now(),
  cursor=jsonb_build_object('mode','history','backlog',true,'history_from',pg_temp.b1_iso(p.window_from),'history_to',pg_temp.b1_iso(p.window_to))
 WHERE source='outlook_history_'||first_key;
 o:=public.trigger_context_email_history();
 IF o->>'source'<>first_key OR (SELECT posts||last_run_status FROM public.context_email_history_plan WHERE source_key=first_key)<>'2partial'
  OR (SELECT body->>'from' FROM pg_temp.b1_posts ORDER BY seq DESC LIMIT 1)<>pg_temp.b1_iso(p.window_from)
 THEN RAISE EXCEPTION 'b1 resume %',o; END IF;

 -- A succeeded run of ANOTHER window does not finish it; one for its window does,
 -- lists the loaded job for reading, and the next source is called.
 INSERT INTO public.context_capture_runs(source,status,finished_at,cursor) VALUES('outlook_history_'||first_key,'succeeded',now(),
  jsonb_build_object('mode','history','backlog',false,'history_from','2026-08-01T00:00:00.000Z','history_to',pg_temp.b1_iso(p.window_to)));
 o:=public.trigger_context_email_history();
 IF (SELECT state FROM public.context_email_history_plan WHERE source_key=first_key)<>'loading' OR o->>'source'<>first_key
 THEN RAISE EXCEPTION 'b1 another window finished the source %',o; END IF;
 j:=pg_temp.b1_job('B1-LOADED');
 PERFORM pg_temp.b1_ev(j,'outlook-mail-capture','backfill','-1 second');
 INSERT INTO public.context_capture_runs(source,status,started_at,finished_at,cursor) VALUES('outlook_history_'||first_key,'succeeded',clock_timestamp()+interval '1 second',now(),
  jsonb_build_object('mode','history','backlog',false,'history_from',pg_temp.b1_iso(p.window_from),'history_to',pg_temp.b1_iso(p.window_to)));
 o:=public.trigger_context_email_history();
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=first_key;
 IF p.state<>'succeeded' OR p.succeeded_at IS NULL OR (p.listed->'written'->>'added')::int<1 OR o->>'source'<>second_key
 THEN RAISE EXCEPTION 'b1 succeeded % %',row_to_json(p),o; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_catchup_jobs WHERE job_id=j AND done_at IS NULL AND scope='backlog' AND priority=2)
 THEN RAISE EXCEPTION 'b1 loaded job not listed for reading'; END IF;

 -- A window about to pass the reader's 60-day limit moves forward.
 UPDATE public.context_email_history_plan SET window_from=now()-interval '60 days', window_to=now()-interval '1 day' WHERE source_key=second_key;
 o:=public.trigger_context_email_history();
 SELECT * INTO p FROM public.context_email_history_plan WHERE source_key=second_key;
 IF p.replans<>1 OR p.window_from<>date_trunc('minute',now())-interval '59 days' OR p.window_to>=now()-interval '23 hours'
 THEN RAISE EXCEPTION 'b1 replan %',row_to_json(p); END IF;

 -- 288 calls without finishing: gave_up; a source no longer selected: gave_up; next source called.
 UPDATE public.context_email_history_plan SET posts=288 WHERE source_key=second_key;
 o:=public.trigger_context_email_history();
 IF (SELECT state||':'||gave_up_reason FROM public.context_email_history_plan WHERE source_key=second_key)<>'gave_up:call_limit'
  OR o->>'source'<>sources[3]
 THEN RAISE EXCEPTION 'b1 call limit %',o; END IF;
 UPDATE public.monitored_mailboxes SET enabled=false WHERE source_key=sources[3];
 o:=public.trigger_context_email_history();
 IF (SELECT state||':'||gave_up_reason FROM public.context_email_history_plan WHERE source_key=sources[3])<>'gave_up:source_not_selected'
  OR o->>'source'<>sources[4]
 THEN RAISE EXCEPTION 'b1 not selected %',o; END IF;

 -- Every source finished: nothing is posted any more.
 UPDATE public.context_email_history_plan SET state='succeeded' WHERE state IN ('pending','loading');
 DELETE FROM pg_temp.b1_posts;
 o:=public.trigger_context_email_history();
 IF o->>'outcome'<>'finished' OR (SELECT count(*) FROM pg_temp.b1_posts)<>0 THEN RAISE EXCEPTION 'b1 finished %',o; END IF;
 s:=public.context_email_history_status();
 IF NOT (s->>'finished')::boolean OR (s->>'sources')::int<>cardinality(sources) OR (s->'by_state'->>'gave_up')::int<>2
 THEN RAISE EXCEPTION 'b1 status %',s; END IF;
END $$;
ROLLBACK;
\endif

BEGIN;
-- 6. The 5-minute poll caller: EM3's poll post first, then one history tick;
-- the tick is idle with the history flag off, and a history fault never stops
-- the poll.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.b1_posts(seq bigserial,url text,body jsonb,headers jsonb,timeout_ms integer);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO pg_temp.b1_posts(url,body,headers,timeout_ms) VALUES(url,body,headers,timeout_milliseconds) RETURNING seq
$$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.b1.fixture'::text $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2');
SELECT public.trigger_context_email_poll();
DO $$
BEGIN
 IF (SELECT array_agg(body->>'mode' ORDER BY seq) FROM pg_temp.b1_posts) IS DISTINCT FROM ARRAY['poll']
 THEN RAISE EXCEPTION 'b1 poll with history off %',(SELECT jsonb_agg(body) FROM pg_temp.b1_posts); END IF;
 DELETE FROM pg_temp.b1_posts;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_reader_history_v1';
END $$;
SELECT public.trigger_context_email_poll();
DO $$
BEGIN
 IF (SELECT array_agg(body->>'mode' ORDER BY seq) FROM pg_temp.b1_posts) IS DISTINCT FROM ARRAY['poll','history']
 THEN RAISE EXCEPTION 'b1 poll plus history %',(SELECT jsonb_agg(body) FROM pg_temp.b1_posts); END IF;
 DELETE FROM pg_temp.b1_posts;
 -- A history fault: the plan table is gone. The poll still posts.
 ALTER TABLE public.context_email_history_plan RENAME TO context_email_history_plan_gone;
END $$;
SELECT public.trigger_context_email_poll();
DO $$
BEGIN
 IF (SELECT array_agg(body->>'mode' ORDER BY seq) FROM pg_temp.b1_posts) IS DISTINCT FROM ARRAY['poll']
 THEN RAISE EXCEPTION 'b1 history fault stopped the poll %',(SELECT jsonb_agg(body) FROM pg_temp.b1_posts); END IF;
END $$;
ROLLBACK;
