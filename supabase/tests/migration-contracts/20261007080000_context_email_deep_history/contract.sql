-- History depth PR B contract (20261007080000): the deep email load reads each
-- mailbox backwards to the start of the oldest monitored live job and never
-- further, credits a job only for slices posted while it was a member, catches
-- up late joiners once a Perth day, keeps W7's progress rules, waits for the
-- 60-day load and for its own running run, and answers the scorecard's two
-- reads. The lead rule is the owner's (7 Oct 2026) until context_lead_monitored
-- exists, then that function's. Every fixture is synthetic and rolled back;
-- user triggers are off for them; every time is relative to the transaction's
-- now(), so nothing depends on the wall clock. "Time passes" is written as
-- moving the recorded times back (pg_temp.dh_pass).

CREATE FUNCTION pg_temp.dh_iso(t timestamptz) RETURNS text LANGUAGE sql AS $$
 SELECT to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- A finished deep run of a source's open slice, as the reader records one.
CREATE FUNCTION pg_temp.dh_run(k text, st text, c jsonb, code text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p public.context_email_deep_plan; id uuid;
BEGIN
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key=k;
 IF p.slice_from IS NULL THEN RAISE EXCEPTION 'dh_run: % has no open slice',k; END IF;
 INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,counts,error_code,cursor)
 VALUES('outlook_deep_history_'||k,st,clock_timestamp(),clock_timestamp(),clock_timestamp(),c,code,
  jsonb_build_object('mode','deep','backlog',st<>'succeeded','history_from',pg_temp.dh_iso(p.slice_from),
   'history_to',pg_temp.dh_iso(p.slice_to),'history_tier','deep'))
 RETURNING context_capture_runs.id INTO id;
 RETURN id;
END $$;

-- Time passes: every time the load recorded moves back by d.
CREATE FUNCTION pg_temp.dh_pass(d interval) RETURNS void LANGUAGE sql AS $$
 UPDATE public.context_email_deep_members SET entered_at=entered_at-d, left_at=left_at-d, updated_at=updated_at-d;
 UPDATE public.context_email_deep_plan SET slice_posted_at=slice_posted_at-d, last_posted_at=last_posted_at-d,
  stalled_at=stalled_at-d, last_progress_at=last_progress_at-d, succeeded_at=succeeded_at-d;
 UPDATE public.context_capture_runs SET started_at=started_at-d, updated_at=updated_at-d, finished_at=finished_at-d
 WHERE source LIKE 'outlook_deep_history_%';
$$;

-- 1. Shape and access.
DO $$
DECLARE f regprocedure; t regclass; p record;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_email_deep_policy()','public.context_email_deep_enabled()','public.context_email_deep_job_refs(jsonb)',
  'public.context_email_deep_live_floor(text)','public.context_email_deep_scope_jobs(timestamptz)','public.context_email_deep_scope()',
  'public.trigger_context_email_deep_history()','public.context_email_deep_status()','public.context_email_history_reach_jobs(uuid[],timestamptz)',
  'public.context_email_history_reach(timestamptz)']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 'deep contract: % executable by anon, authenticated or PUBLIC',f; END IF;
  IF obj_description(f,'pg_proc') NOT LIKE 'History depth (20261007080000)%' THEN RAISE EXCEPTION 'deep contract: % comment does not name the migration',f; END IF;
  IF f<>'public.context_email_deep_job_refs(jsonb)'::regprocedure AND (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL
  THEN RAISE EXCEPTION 'deep contract: % has no fixed search_path',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_email_deep_enabled()','public.context_email_deep_scope_jobs(timestamptz)','public.context_email_deep_scope()',
  'public.trigger_context_email_deep_history()','public.context_email_deep_status()','public.context_email_history_reach_jobs(uuid[],timestamptz)',
  'public.context_email_history_reach(timestamptz)']::regprocedure[] LOOP
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=f) THEN RAISE EXCEPTION 'deep contract: % must be SECURITY DEFINER',f; END IF;
 END LOOP;
 -- The per-row helper stays inlinable: plain SQL, immutable, no SET, not a definer.
 SELECT pr.prosecdef, pr.proconfig, pr.provolatile, l.lanname INTO p FROM pg_proc pr JOIN pg_language l ON l.oid=pr.prolang
 WHERE pr.oid='public.context_email_deep_job_refs(jsonb)'::regprocedure;
 IF p.prosecdef OR p.proconfig IS NOT NULL OR p.provolatile<>'i' OR p.lanname<>'sql' THEN
  RAISE EXCEPTION 'deep contract: context_email_deep_job_refs must stay an inlinable immutable SQL function';
 END IF;
 IF has_function_privilege('service_role','public.trigger_context_email_deep_history()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_email_history_reach(timestamptz)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_email_history_reach_jobs(uuid[],timestamptz)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_email_deep_scope()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_email_deep_enabled()','EXECUTE')
 THEN RAISE EXCEPTION 'deep contract: grants'; END IF;
 FOREACH t IN ARRAY ARRAY['public.context_email_deep_members','public.context_email_deep_plan','public.context_email_deep_reach']::regclass[] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=t) THEN RAISE EXCEPTION 'deep contract: % RLS off',t; END IF;
  IF has_table_privilege('anon',t,'SELECT') OR has_table_privilege('authenticated',t,'SELECT') OR has_table_privilege('anon',t,'INSERT')
   OR has_table_privilege('authenticated',t,'UPDATE') OR NOT has_table_privilege('service_role',t,'SELECT')
   OR has_table_privilege('service_role',t,'INSERT') OR has_table_privilege('service_role',t,'UPDATE') OR has_table_privilege('service_role',t,'DELETE')
  THEN RAISE EXCEPTION 'deep contract: % access',t; END IF;
  IF obj_description(t,'pg_class') NOT LIKE 'History depth (20261007080000)%' THEN RAISE EXCEPTION 'deep contract: % comment',t; END IF;
 END LOOP;
 -- The flag exists, off.
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='email_reader_deep_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'deep contract: the flag must exist, off'; END IF;
 -- The capture lane owns the new job; every earlier lane row stays.
 IF NOT EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() WHERE cron_jobname='outlook-mail-deep-history' AND lane='capture')
  OR NOT (SELECT array_agg(cron_jobname||':'||lane ORDER BY cron_jobname COLLATE "C") FROM public.automation_switch_cron_lanes())
   @> ARRAY['contact-matching:attribution','context-document-text:capture','ghl-call-transcript-fetch:capture','ghl-history-schedule:capture',
    'ghl-message-reconcile:capture','monitor-inbox-poll:capture','monitor-inbox-sweep:capture','outlook-mail-poll:capture']
 THEN RAISE EXCEPTION 'deep contract: lane list %',(SELECT array_agg(to_jsonb(l)) FROM public.automation_switch_cron_lanes() l); END IF;
END $$;

-- 2a. A source's live floor: its first poll window, or a whole nightly sweep
-- that ran after the poll began and reaches further back; a sweep that ended
-- before the poll began leaves a gap and never counts.
BEGIN;
DO $$
DECLARE t0 timestamptz:=date_trunc('second',now());
BEGIN
 IF public.context_email_deep_live_floor('dhfloor') IS NOT NULL THEN RAISE EXCEPTION 'deep contract: a never-polled source has a floor'; END IF;
 INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,window_from,counts)
 VALUES ('outlook_dhfloor','succeeded',t0-interval '3 days',t0-interval '3 days',t0-interval '3 days',t0-interval '3 days'-interval '30 minutes'+interval '0.4 seconds','{}'),
        ('outlook_dhfloor','running',t0-interval '9 days',t0-interval '9 days',NULL,t0-interval '9 days','{}'),
        ('outlook_sweep_dhfloor','succeeded',t0-interval '4 days',t0-interval '4 days',t0-interval '4 days',t0-interval '6 days','{}');
 IF public.context_email_deep_live_floor('dhfloor')<>t0-interval '3 days'-interval '30 minutes'+interval '1 second'
 THEN RAISE EXCEPTION 'deep contract: floor from the first poll %',public.context_email_deep_live_floor('dhfloor'); END IF;
 INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,window_from,counts)
 VALUES ('outlook_sweep_dhfloor','succeeded',t0-interval '2 days',t0-interval '2 days',t0-interval '2 days',t0-interval '4 days','{}');
 IF public.context_email_deep_live_floor('dhfloor')<>t0-interval '4 days'
 THEN RAISE EXCEPTION 'deep contract: floor from an overlapping sweep %',public.context_email_deep_live_floor('dhfloor'); END IF;
END $$;
ROLLBACK;

-- 2. The numbers are the design's and the owner's.
DO $$
DECLARE p jsonb:=public.context_email_deep_policy(); g jsonb:=public.context_email_deep_enabled();
BEGIN
 IF p->>'version'<>'email-deep-v1' OR (p->>'lead_quiet_days')::int<>28 OR (p->>'lead_in_days')::int<>30 OR (p->>'user_slice_days')::int<>31
  OR (p->>'calls_per_tick')::int<>2 OR (p->>'stall_after_calls')::int<>3 OR (p->>'stall_rest_hours')::int<>6
  OR (p->>'hard_floor')::timestamptz<>'2025-01-01 00:00 Australia/Perth'::timestamptz
  OR p->'live_excluded_statuses'<>'["cancelled","draft","archived","complete","completed","lost"]'::jsonb
 THEN RAISE EXCEPTION 'deep contract: policy %',p; END IF;
 IF (g->>'enabled')::boolean OR g->>'state'<>'present' OR (g->>'hard_floor')::timestamptz<>(p->>'hard_floor')::timestamptz
  OR (g->>'user_window_max_days')::int<>32
 THEN RAISE EXCEPTION 'deep contract: gate %',g; END IF;
 IF public.context_email_deep_job_refs('{"builder_claim_ref":" mlb-26537 ","builder_po_number":"PO-56922","external_ref":"MLB-26537","builder_work_order_number":"wo1"}')
   <>ARRAY['MLB-26537','PO-56922'] OR public.context_email_deep_job_refs(NULL)<>'{}'::text[]
 THEN RAISE EXCEPTION 'deep contract: job refs %',public.context_email_deep_job_refs('{"builder_claim_ref":" mlb-26537 "}'); END IF;
END $$;

BEGIN;
SET LOCAL session_replication_role = replica;
-- Stand-ins for pg_net and the service key: every post is recorded.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.dh_posts(seq bigserial, tick integer, url text, body jsonb, headers jsonb, timeout_ms integer);
CREATE TABLE pg_temp.dh_tick_no(n integer);
INSERT INTO pg_temp.dh_tick_no VALUES (0);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO pg_temp.dh_posts(tick,url,body,headers,timeout_ms) SELECT n,url,body,headers,timeout_milliseconds FROM pg_temp.dh_tick_no RETURNING seq
$$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.deep.fixture'::text $$;
CREATE FUNCTION pg_temp.dh_tick() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 UPDATE pg_temp.dh_tick_no SET n=n+1;
 RETURN public.trigger_context_email_deep_history();
END $$;
CREATE FUNCTION pg_temp.dh_posted(p_tick integer) RETURNS text[] LANGUAGE sql AS $$
 SELECT coalesce(array_agg(body->>'source' ORDER BY seq),'{}') FROM pg_temp.dh_posts WHERE tick=p_tick
$$;

UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2');
-- Three selected sources: one group, two user mailboxes.
UPDATE public.monitored_mailboxes SET enabled=(source_key IN ('patios','nithin','shaun'));
-- Only this contract's jobs are live.
UPDATE public.jobs SET status='completed';
DELETE FROM public.context_capture_runs;
DELETE FROM public.context_email_history_plan;

CREATE TEMP TABLE dh_t AS SELECT date_trunc('second',now()) AS t0;
-- Each source's live floor: its first poll window, four days ago.
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,window_from,window_to,counts,cursor)
SELECT 'outlook_'||k,'succeeded',t0-interval '4 days',t0-interval '4 days',t0-interval '4 days',t0-interval '4 days'+interval '0.25 seconds',
 t0-interval '4 days'+interval '1 minute','{}','{"mode":"poll"}' FROM dh_t, unnest(ARRAY['patios','nithin','shaun']) k;

INSERT INTO public.jobs(id,org_id,job_number,status,type,client_email,metadata,created_at,quoted_at,accepted_at)
SELECT x.id::uuid,'00000000-0000-4000-8000-0000000000aa',x.jn,x.st,x.ty,x.em,x.md::jsonb,t0-x.age,
 CASE WHEN x.q IS NULL THEN NULL ELSE t0-x.q END, CASE WHEN x.acc IS NULL THEN NULL ELSE t0-x.acc END
FROM dh_t, (VALUES
 -- the oldest monitored job: its start sets the floor (230 days back)
 ('d7e00000-0000-4000-8000-000000000001','SWF-DH01','processing','fencing','pat.one@example.test','{}',interval '200 days',NULL::interval,NULL::interval),
 ('d7e00000-0000-4000-8000-000000000002','SWF-DH02','scheduled','fencing','Casey.Two@Example.TEST','{}',interval '40 days',NULL,NULL),
 -- a lead quoted 100 days ago, no word since: not monitored
 ('d7e00000-0000-4000-8000-000000000003','SWP-DH03','quoted','patio','dee.three@example.test','{}',interval '400 days',interval '100 days',NULL),
 -- a lead quoted 100 days ago whose customer wrote 10 days ago: monitored
 ('d7e00000-0000-4000-8000-000000000004','SWP-DH04','quoted','patio','eve.four@example.test','{}',interval '110 days',interval '100 days',NULL),
 -- quoted 10 days ago: monitored
 ('d7e00000-0000-4000-8000-000000000005','SWP-DH05','quoted','patio',NULL,'{}',interval '20 days',interval '10 days',NULL),
 -- a quote never sent starts no clock: monitored
 ('d7e00000-0000-4000-8000-000000000006','SWP-DH06','quoted','patio',NULL,'{}',interval '15 days',NULL,NULL),
 -- not live
 ('d7e00000-0000-4000-8000-000000000007','SWF-DH07','completed','fencing',NULL,'{}',interval '500 days',NULL,NULL),
 -- a make-safe job known by its builder's references
 ('d7e00000-0000-4000-8000-000000000008','SWMS-DH08','processing','makesafe',NULL,
  '{"builder_claim_ref":"MLB-26537","builder_po_number":"PO-56922","external_ref":"MLB-26537PO-56922"}',interval '60 days',NULL,NULL),
 -- created 5 days ago; a text placed on it 70 days ago is its first record
 ('d7e00000-0000-4000-8000-000000000009','SWF-DH09','processing','fencing','pat.one@example.test','{}',interval '5 days',NULL,NULL),
 -- created 50 days ago; a deep row placed on it never moves its start
 ('d7e00000-0000-4000-8000-00000000000a','SWF-DH10','processing','fencing',NULL,'{}',interval '50 days',NULL,NULL),
 -- created 20 days ago; its first invoice is dated 90 days back
 ('d7e00000-0000-4000-8000-00000000000b','SWF-DH11','accepted','fencing',NULL,'{}',interval '20 days',NULL,NULL),
 -- quoted 100 days ago but accepted since: no longer a lead
 ('d7e00000-0000-4000-8000-00000000000c','SWP-DH12','quoted','patio',NULL,'{}',interval '130 days',interval '100 days',interval '95 days')
) AS x(id,jn,st,ty,em,md,age,q,acc);

INSERT INTO public.business_events(id,job_id,event_type,source,channel,direction,metadata,payload,occurred_at,recorded_at,context_captured_at,event_at)
SELECT x.id::uuid,x.job::uuid,x.et,'fixture',x.ch,x.dir,x.md::jsonb,'{}',t0-x.age,t0-x.age,t0-x.age,t0-x.age
FROM dh_t, (VALUES
 ('d7ee0000-0000-4000-8000-000000000001','d7e00000-0000-4000-8000-000000000004','client.email_in','email','inbound','{"capture_mode":"live"}',interval '10 days'),
 ('d7ee0000-0000-4000-8000-000000000002','d7e00000-0000-4000-8000-000000000009','client.reply','sms','inbound','{"capture_mode":"backfill"}',interval '70 days'),
 ('d7ee0000-0000-4000-8000-000000000003','d7e00000-0000-4000-8000-00000000000a','client.email_in','email','inbound','{"capture_mode":"backfill","history_tier":"deep"}',interval '300 days'),
 -- a supplier's email is not the customer's: the quoted lead DH03 stays unmonitored
 ('d7ee0000-0000-4000-8000-000000000004','d7e00000-0000-4000-8000-000000000003','supplier.email_in','email','inbound','{"capture_mode":"live"}',interval '3 days')
) AS x(id,job,et,ch,dir,md,age);
INSERT INTO public.xero_invoices(id,org_id,xero_invoice_id,invoice_number,invoice_type,status,job_id,invoice_date)
SELECT 'd7ef0000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000aa','xero-dh-1','INV-DH1','ACCREC','DRAFT','d7e00000-0000-4000-8000-00000000000b',
 ((t0-interval '90 days') AT TIME ZONE 'Australia/Perth')::date FROM dh_t;

-- 3. The scope, on the owner's rule (no context_lead_monitored here).
DO $$
DECLARE t0 timestamptz:=(SELECT t0 FROM dh_t); r record; mon text[];
BEGIN
 IF to_regprocedure('public.context_lead_monitored(uuid,timestamp with time zone)') IS NOT NULL THEN
  -- The lead-rule slice is on this stack: hide it for the fallback proof.
  ALTER FUNCTION public.context_lead_monitored(uuid,timestamp with time zone) RENAME TO dh_hidden_lead_monitored;
 END IF;
 SELECT array_agg(s.job_number ORDER BY s.job_number COLLATE "C") FILTER (WHERE s.monitored) INTO mon FROM public.context_email_deep_scope_jobs(now()) s;
 IF mon<>ARRAY['SWF-DH01','SWF-DH02','SWF-DH09','SWF-DH10','SWF-DH11','SWMS-DH08','SWP-DH04','SWP-DH05','SWP-DH06','SWP-DH12'] THEN
  RAISE EXCEPTION 'deep contract: monitored %',mon;
 END IF;
 IF (SELECT count(*) FROM public.context_email_deep_scope_jobs(now()))<>11 OR EXISTS(SELECT 1 FROM public.context_email_deep_scope_jobs(now()) WHERE job_number='SWF-DH07')
  OR EXISTS(SELECT 1 FROM public.context_email_deep_scope_jobs(now()) WHERE lead_rule<>'deep_fallback')
 THEN RAISE EXCEPTION 'deep contract: live set or rule'; END IF;
 FOR r IN SELECT * FROM public.context_email_deep_scope_jobs(now()) LOOP
  IF r.lead_in_from<>r.job_started-interval '30 days' THEN RAISE EXCEPTION 'deep contract: lead-in of %',r.job_number; END IF;
  IF r.job_number='SWF-DH09' AND r.job_started<>t0-interval '70 days' THEN RAISE EXCEPTION 'deep contract: a placed text is the first record %',r.job_started; END IF;
  IF r.job_number='SWF-DH10' AND r.job_started<>t0-interval '50 days' THEN RAISE EXCEPTION 'deep contract: a deep row moved a start %',r.job_started; END IF;
  IF r.job_number='SWF-DH11' AND r.job_started<>(((t0-interval '90 days') AT TIME ZONE 'Australia/Perth')::date::timestamp AT TIME ZONE 'Australia/Perth')
  THEN RAISE EXCEPTION 'deep contract: the first invoice is the first record %',r.job_started; END IF;
  IF r.job_number='SWF-DH02' AND (r.client_email_key<>'casey.two@example.test' OR r.job_number_key<>'SWF-DH02') THEN RAISE EXCEPTION 'deep contract: keys %',to_jsonb(r); END IF;
  IF r.job_number='SWMS-DH08' AND r.builder_refs<>ARRAY['MLB-26537','MLB-26537PO-56922','PO-56922'] THEN RAISE EXCEPTION 'deep contract: builder refs %',r.builder_refs; END IF;
 END LOOP;
 IF to_regprocedure('public.dh_hidden_lead_monitored(uuid,timestamp with time zone)') IS NOT NULL THEN
  ALTER FUNCTION public.dh_hidden_lead_monitored(uuid,timestamp with time zone) RENAME TO context_lead_monitored;
 END IF;
END $$;

-- 3b. Once context_lead_monitored exists, the scope follows it (a stand-in here).
SAVEPOINT lead_rule;
DROP FUNCTION IF EXISTS public.context_lead_monitored(uuid,timestamp with time zone);
CREATE FUNCTION public.context_lead_monitored(p_job_id uuid,p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid,monitored boolean,lead boolean,quote_first_sent_at timestamptz,cutoff_at timestamptz,progressed_at timestamptz)
LANGUAGE sql STABLE AS $$
 SELECT p_job_id, p_job_id<>'d7e00000-0000-4000-8000-000000000001'::uuid, true, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz
$$;
DO $$
DECLARE mon text[];
BEGIN
 SELECT array_agg(s.job_number ORDER BY s.job_number COLLATE "C") FILTER (WHERE s.monitored) INTO mon FROM public.context_email_deep_scope_jobs(now()) s;
 IF mon<>ARRAY['SWF-DH02','SWF-DH09','SWF-DH10','SWF-DH11','SWMS-DH08','SWP-DH03','SWP-DH04','SWP-DH05','SWP-DH06','SWP-DH12']
  OR EXISTS(SELECT 1 FROM public.context_email_deep_scope_jobs(now()) WHERE lead_rule<>'context_lead_monitored')
  OR public.context_email_deep_status()->>'lead_rule'<>'context_lead_monitored'
 THEN RAISE EXCEPTION 'deep contract: the scope does not follow context_lead_monitored %',mon; END IF;
END $$;
ROLLBACK TO SAVEPOINT lead_rule;
-- 3c. A lead-rule function that does not answer as expected: the owner's rule
-- applies and lead_rule says so; nothing stops.
SAVEPOINT lead_rule_odd;
DROP FUNCTION IF EXISTS public.context_lead_monitored(uuid,timestamp with time zone);
CREATE FUNCTION public.context_lead_monitored(p_job_id uuid,p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid,is_monitored boolean) LANGUAGE sql STABLE AS $$ SELECT p_job_id, false $$;
DO $$
DECLARE mon text[];
BEGIN
 SELECT array_agg(s.job_number ORDER BY s.job_number COLLATE "C") FILTER (WHERE s.monitored) INTO mon FROM public.context_email_deep_scope_jobs(now()) s;
 IF mon<>ARRAY['SWF-DH01','SWF-DH02','SWF-DH09','SWF-DH10','SWF-DH11','SWMS-DH08','SWP-DH04','SWP-DH05','SWP-DH06','SWP-DH12']
  OR EXISTS(SELECT 1 FROM public.context_email_deep_scope_jobs(now()) WHERE lead_rule<>'deep_fallback_lead_rule_unreadable')
  OR public.context_email_deep_status()->>'lead_rule'<>'deep_fallback_lead_rule_unreadable'
 THEN RAISE EXCEPTION 'deep contract: an unreadable lead rule %',mon; END IF;
END $$;
ROLLBACK TO SAVEPOINT lead_rule_odd;
-- From here the owner's rule applies whatever this stack holds.
DO $$
BEGIN
 IF to_regprocedure('public.context_lead_monitored(uuid,timestamp with time zone)') IS NOT NULL THEN
  ALTER FUNCTION public.context_lead_monitored(uuid,timestamp with time zone) RENAME TO dh_hidden_lead_monitored;
 END IF;
END $$;

-- 4. Idle until the four flags and the capture lane; the reader's scope is
-- empty until the tick has members; the reach read is honest before any load.
DO $$
DECLARE o jsonb; s jsonb; j record;
BEGIN
 o:=pg_temp.dh_tick();
 IF o<>'{"outcome":"idle","reason":"email_reader_deep_v1_off"}'::jsonb THEN RAISE EXCEPTION 'deep contract: flag off %',o; END IF;
 IF (public.context_email_deep_scope()->>'jobs')::int<>0 THEN RAISE EXCEPTION 'deep contract: scope before members'; END IF;
 -- Before any load each monitored job reaches its mailboxes' live floor: loading, the load off.
 FOR j IN SELECT * FROM public.context_email_history_reach_jobs(NULL,now()) LOOP
  IF j.job_number='SWP-DH03' AND (j.status<>'not_monitored' OR j.reason<>'lead_not_monitored') THEN RAISE EXCEPTION 'deep contract: unmonitored lead %',to_jsonb(j); END IF;
  IF j.monitored AND (j.status<>'loading' OR j.reason<>'deep_load_off' OR j.reaches<>(SELECT t0 FROM dh_t)-interval '4 days'+interval '1 second'
   OR jsonb_array_length(j.sources)<>3 OR j.sources->0->>'source_key'<>'nithin' OR j.sources->0->>'state'<>'not_planned')
  THEN RAISE EXCEPTION 'deep contract: reach before the load %',to_jsonb(j); END IF;
 END LOOP;
 -- A selected mailbox never read leaves its jobs not started, never green.
 DELETE FROM public.context_capture_runs WHERE source='outlook_shaun';
 IF EXISTS(SELECT 1 FROM public.context_email_history_reach_jobs(NULL,now()) WHERE monitored AND (status<>'not_started' OR reason<>'mailbox_never_read' OR reaches IS NOT NULL))
 THEN RAISE EXCEPTION 'deep contract: a never-read mailbox'; END IF;
 INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,window_from,window_to,counts,cursor)
 SELECT 'outlook_shaun','succeeded',t0-interval '4 days',t0-interval '4 days',t0-interval '4 days',t0-interval '4 days'+interval '0.25 seconds',
  t0-interval '4 days'+interval '1 minute','{}','{"mode":"poll"}' FROM dh_t;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_reader_deep_v1';
 UPDATE public.automation_switches SET capture=false WHERE id=1;
 o:=pg_temp.dh_tick();
 IF o->>'reason'<>'capture_lane_off' THEN RAISE EXCEPTION 'deep contract: lane off %',o; END IF;
 UPDATE public.automation_switches SET capture=true WHERE id=1;
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='email_reader_schedule_v1';
 o:=pg_temp.dh_tick();
 IF o->>'reason'<>'reader_flags_off' THEN RAISE EXCEPTION 'deep contract: reader flags off %',o; END IF;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_reader_schedule_v1';
 IF (SELECT count(*) FROM pg_temp.dh_posts)<>0 OR EXISTS(SELECT 1 FROM public.context_email_deep_plan) OR EXISTS(SELECT 1 FROM public.context_email_deep_members)
 THEN RAISE EXCEPTION 'deep contract: an idle tick wrote or posted'; END IF;
END $$;

-- 5. The first tick: members, plan rows, the live floor fixed once (raised to
-- the second), the target (the oldest monitored job's start, 230 days back),
-- two calls, the group first, each a deep slice that ends at the live floor.
DO $$
DECLARE t0 timestamptz:=(SELECT t0 FROM dh_t); o jsonb; lf timestamptz; p record; b jsonb; s jsonb;
BEGIN
 lf:=t0-interval '4 days'+interval '1 second';
 o:=pg_temp.dh_tick();
 IF o->>'outcome'<>'posted' OR (o->>'posted')::int<>2 OR (o->>'members')::int<>10 OR (o->>'target_floor')::timestamptz<>t0-interval '230 days'
  OR o->>'lead_rule'<>'deep_fallback'
 THEN RAISE EXCEPTION 'deep contract: first tick %',o; END IF;
 -- Never further: no call reads below the oldest monitored job's start.
 IF EXISTS(SELECT 1 FROM pg_temp.dh_posts WHERE (body->>'from')::timestamptz<t0-interval '230 days') THEN
  RAISE EXCEPTION 'deep contract: deep slice below the oldest monitored job''s start: %',(SELECT jsonb_agg(body) FROM pg_temp.dh_posts);
 END IF;
 IF pg_temp.dh_posted(4)<>ARRAY['patios','nithin'] THEN RAISE EXCEPTION 'deep contract: first posts %',pg_temp.dh_posted(4); END IF;
 IF (SELECT count(*) FROM public.context_email_deep_members WHERE left_at IS NULL)<>10 THEN RAISE EXCEPTION 'deep contract: members'; END IF;
 FOR p IN SELECT * FROM public.context_email_deep_plan ORDER BY source_key COLLATE "C" LOOP
  IF p.live_floor<>lf OR p.target_floor<>t0-interval '230 days' THEN RAISE EXCEPTION 'deep contract: floors %',to_jsonb(p); END IF;
 END LOOP;
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key='patios';
 IF p.state<>'loading' OR p.slice_from<>t0-interval '230 days' OR p.slice_to<>lf OR p.slice_kind<>'deep' OR p.posts<>1 OR p.slice_posted_at IS NULL
 THEN RAISE EXCEPTION 'deep contract: the group reads one window %',to_jsonb(p); END IF;
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key='nithin';
 IF p.state<>'loading' OR p.slice_from<>lf-interval '31 days' OR p.slice_to<>lf OR p.slice_kind<>'deep' THEN RAISE EXCEPTION 'deep contract: a user slice %',to_jsonb(p); END IF;
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key='shaun';
 IF p.state<>'pending' OR p.slice_from<>lf-interval '31 days' OR p.posts<>0 OR p.slice_posted_at IS NOT NULL THEN RAISE EXCEPTION 'deep contract: the third waits its turn %',to_jsonb(p); END IF;
 SELECT body INTO b FROM pg_temp.dh_posts WHERE tick=4 AND body->>'source'='nithin';
 IF b<>jsonb_build_object('mode','deep','source','nithin','from',pg_temp.dh_iso(lf-interval '31 days'),'to',pg_temp.dh_iso(lf),'actor','cron:outlook-mail-deep-history')
  OR (SELECT headers->>'Authorization' FROM pg_temp.dh_posts WHERE tick=4 LIMIT 1)<>'Bearer eyJ.deep.fixture'
  OR (SELECT url FROM pg_temp.dh_posts WHERE tick=4 LIMIT 1)<>'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture'
 THEN RAISE EXCEPTION 'deep contract: call body %',b; END IF;
 -- The reader's scope: each key with the earliest lead-in of the members carrying it.
 s:=public.context_email_deep_scope();
 IF (s->>'jobs')::int<>10 OR s->'builder_refs'<>jsonb_build_object('MLB-26537',pg_temp.dh_iso(t0-interval '90 days'),
   'MLB-26537PO-56922',pg_temp.dh_iso(t0-interval '90 days'),'PO-56922',pg_temp.dh_iso(t0-interval '90 days'))
  OR s->'client_emails'->>'pat.one@example.test'<>pg_temp.dh_iso(t0-interval '230 days')
  OR s->'client_emails'->>'casey.two@example.test'<>pg_temp.dh_iso(t0-interval '70 days')
  OR s->'client_emails' ? 'dee.three@example.test'
  OR s->'job_numbers'->>'SWF-DH09'<>pg_temp.dh_iso(t0-interval '100 days') OR s->'job_numbers' ? 'SWP-DH03'
  OR (SELECT count(*) FROM jsonb_object_keys(s->'job_numbers'))<>10
 THEN RAISE EXCEPTION 'deep contract: reader scope %',s; END IF;
 -- While the slices run, the jobs are loading.
 IF EXISTS(SELECT 1 FROM public.context_email_history_reach_jobs(NULL,now()) WHERE monitored AND (status<>'loading' OR reason<>'loading'))
 THEN RAISE EXCEPTION 'deep contract: loading %',(SELECT jsonb_agg(to_jsonb(x)) FROM public.context_email_history_reach_jobs(NULL,now()) x WHERE x.monitored); END IF;
END $$;

-- 6. A slice credits only jobs that were members when it was first posted;
-- a later joiner is read from the top for itself.
DO $$
DECLARE t0 timestamptz:=(SELECT t0 FROM dh_t); lf timestamptz; o jsonb; p record;
BEGIN
 lf:=t0-interval '4 days'+interval '1 second';
 PERFORM pg_temp.dh_pass(interval '5 minutes');
 -- A job created now joins after nithin's first slice was posted.
 INSERT INTO public.jobs(id,org_id,job_number,status,type,created_at)
 SELECT 'd7e00000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000aa','SWF-DH21','processing','fencing',t0-interval '1 day';
 PERFORM pg_temp.dh_run('nithin','succeeded','{"progressed":40,"inserted":3}');
 -- The group's run is still going.
 INSERT INTO public.context_capture_runs(source,status) VALUES ('outlook_deep_history_patios','running');
 o:=pg_temp.dh_tick();
 IF EXISTS(SELECT 1 FROM public.context_email_deep_reach WHERE job_id='d7e00000-0000-4000-8000-0000000000d1') THEN
  RAISE EXCEPTION 'deep contract: a late joiner was credited for a slice posted before it joined';
 END IF;
 IF (SELECT count(*) FROM public.context_email_deep_reach WHERE source_key='nithin' AND reaches=lf-interval '31 days')<>10 THEN
  RAISE EXCEPTION 'deep contract: the members were not credited %',(SELECT jsonb_agg(to_jsonb(x)) FROM public.context_email_deep_reach x);
 END IF;
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key='nithin';
 -- The highest gap is now the late joiner's, at the live floor: read again for it.
 IF p.slices_done<>1 OR p.covered_from<>lf-interval '31 days' OR p.slice_to<>lf OR p.slice_from<>t0-interval '31 days' OR p.slice_kind<>'catchup'
 THEN RAISE EXCEPTION 'deep contract: after the first slice %',to_jsonb(p); END IF;
 -- The group waits for its running run; the two user mailboxes get the calls.
 IF pg_temp.dh_posted(5)<>ARRAY['nithin','shaun']
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o->'calls') c WHERE c->>'source'='patios' AND c->>'outcome'='waiting')
 THEN RAISE EXCEPTION 'deep contract: second tick posts %, %',pg_temp.dh_posted(5),o; END IF;
END $$;

-- 7. W7's rules: a run judged once; three calls without a move stall, loudly,
-- and the next source is called; a stalled source rests 6 hours, then gets
-- fresh calls; a running run is waited for.
DO $$
DECLARE o jsonb; p record; r3 uuid; i integer;
BEGIN
 -- nithin's catch-up slice: a partial run that moved resets the count.
 PERFORM pg_temp.dh_pass(interval '5 minutes');
 IF (SELECT state FROM public.context_email_deep_plan WHERE source_key='nithin')<>'loading' THEN
  PERFORM pg_temp.dh_tick(); PERFORM pg_temp.dh_pass(interval '5 minutes');
 END IF;
 PERFORM pg_temp.dh_run('nithin','partial','{"progressed":12}');
 o:=pg_temp.dh_tick();
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key='nithin';
 IF p.posts_since_progress<>1 OR p.last_progress_at IS NULL OR p.state<>'loading' THEN RAISE EXCEPTION 'deep contract: progress %',to_jsonb(p); END IF;
 -- Three partial runs that moved nothing: stalled with its reason.
 FOR i IN 1..3 LOOP
  PERFORM pg_temp.dh_pass(interval '5 minutes');
  r3:=pg_temp.dh_run('nithin','partial','{"progressed":0,"inserted":0}');
  o:=pg_temp.dh_tick();
 END LOOP;
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key='nithin';
 IF p.state<>'stalled' OR p.stall_reason<>'no_progress' OR p.stalls<>1 OR p.last_run_id IS DISTINCT FROM r3 OR p.stalled_at IS NULL
 THEN RAISE EXCEPTION 'deep contract: not stalled %',to_jsonb(p); END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.context_email_deep_status()->'attention') a
   WHERE a->>'source_key'='nithin' AND a->>'reason'='no_progress')
 THEN RAISE EXCEPTION 'deep contract: a stalled source is not in attention'; END IF;
 -- A job of a stalled mailbox says so.
 IF (SELECT reason FROM public.context_email_history_reach_jobs(ARRAY['d7e00000-0000-4000-8000-0000000000d1'::uuid],now()))<>'mailbox_stalled'
 THEN RAISE EXCEPTION 'deep contract: stalled reason %',(SELECT to_jsonb(x) FROM public.context_email_history_reach_jobs(ARRAY['d7e00000-0000-4000-8000-0000000000d1'::uuid],now()) x); END IF;
 -- Resting: not called. After 6 hours: called again, fresh count.
 DELETE FROM pg_temp.dh_posts;
 o:=pg_temp.dh_tick();
 IF EXISTS(SELECT 1 FROM pg_temp.dh_posts WHERE body->>'source'='nithin') THEN RAISE EXCEPTION 'deep contract: a resting source was called'; END IF;
 UPDATE public.context_email_deep_plan SET stalled_at=now()-interval '7 hours' WHERE source_key='nithin';
 -- ...but not while its own run is running.
 INSERT INTO public.context_capture_runs(source,status) VALUES ('outlook_deep_history_nithin','running');
 o:=pg_temp.dh_tick();
 IF EXISTS(SELECT 1 FROM pg_temp.dh_posts WHERE body->>'source'='nithin')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o->'calls') c WHERE c->>'source'='nithin' AND c->>'outcome'='waiting')
 THEN RAISE EXCEPTION 'deep contract: posted over a running run %',o; END IF;
 DELETE FROM public.context_capture_runs WHERE source='outlook_deep_history_nithin' AND status='running';
 -- Every other source finished its current call: the rested one is called.
 UPDATE public.context_email_deep_plan SET state='succeeded', slice_from=NULL, slice_to=NULL, slice_kind=NULL, slice_posted_at=NULL,
  walk_day=(now() AT TIME ZONE 'Australia/Perth')::date WHERE source_key<>'nithin';
 o:=pg_temp.dh_tick();
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key='nithin';
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o->'calls') c WHERE c->>'source'='nithin' AND (c->>'retry')::boolean)
  OR p.state<>'loading' OR p.posts_since_progress<>1
 THEN RAISE EXCEPTION 'deep contract: retry %, %',o,to_jsonb(p); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 8. The whole walk, every slice read: it ends at the oldest monitored job's
-- start and never reads below it; user slices are at most 31 days; at most two
-- calls a tick, to different sources, groups first; at the end every
-- monitored job reaches its start in every mailbox.
SET LOCAL session_replication_role = replica;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.dh_posts(seq bigserial, tick integer, url text, body jsonb, headers jsonb, timeout_ms integer);
CREATE TABLE pg_temp.dh_tick_no(n integer);
INSERT INTO pg_temp.dh_tick_no VALUES (0);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO pg_temp.dh_posts(tick,url,body,headers,timeout_ms) SELECT n,url,body,headers,timeout_milliseconds FROM pg_temp.dh_tick_no RETURNING seq
$$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.deep.fixture'::text $$;
CREATE FUNCTION pg_temp.dh_tick() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 UPDATE pg_temp.dh_tick_no SET n=n+1;
 RETURN public.trigger_context_email_deep_history();
END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2','email_reader_deep_v1');
UPDATE public.monitored_mailboxes SET enabled=(source_key IN ('patios','nithin','shaun'));
UPDATE public.jobs SET status='completed';
DELETE FROM public.context_capture_runs;
DELETE FROM public.context_email_history_plan;
DO $$
BEGIN
 IF to_regprocedure('public.context_lead_monitored(uuid,timestamp with time zone)') IS NOT NULL THEN
  ALTER FUNCTION public.context_lead_monitored(uuid,timestamp with time zone) RENAME TO dh_hidden_lead_monitored;
 END IF;
END $$;
CREATE TEMP TABLE dh_t AS SELECT date_trunc('second',now()) AS t0;
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,window_from,window_to,counts,cursor)
SELECT 'outlook_'||k,'succeeded',t0-interval '4 days',t0-interval '4 days',t0-interval '4 days',t0-interval '4 days',
 t0-interval '4 days'+interval '1 minute','{}','{"mode":"poll"}' FROM dh_t, unnest(ARRAY['patios','nithin','shaun']) k;
INSERT INTO public.jobs(id,org_id,job_number,status,type,client_email,metadata,created_at)
SELECT x.id::uuid,'00000000-0000-4000-8000-0000000000aa',x.jn,'processing','fencing',x.em,'{}',t0-x.age
FROM dh_t, (VALUES
 ('d7e00000-0000-4000-8000-000000000001','SWF-DH01','pat.one@example.test',interval '200 days'),
 ('d7e00000-0000-4000-8000-000000000002','SWF-DH02','casey.two@example.test',interval '40 days'),
 ('d7e00000-0000-4000-8000-000000000003','SWF-DH03',NULL,interval '100 days'),
 ('d7e00000-0000-4000-8000-000000000004','SWF-DH04',NULL,interval '3 days')
) AS x(id,jn,em,age);
DO $$
DECLARE t0 timestamptz:=(SELECT t0 FROM dh_t); lf timestamptz; floor_ timestamptz; o jsonb; i integer; p record; c record; n integer;
BEGIN
 lf:=t0-interval '4 days'; floor_:=t0-interval '230 days';
 FOR i IN 1..60 LOOP
  o:=pg_temp.dh_tick();
  n:=(SELECT k.n FROM pg_temp.dh_tick_no k);
  IF (SELECT count(*) FROM pg_temp.dh_posts WHERE tick=n)>2
   OR (SELECT count(DISTINCT body->>'source') FROM pg_temp.dh_posts WHERE tick=n)<>(SELECT count(*) FROM pg_temp.dh_posts WHERE tick=n)
  THEN RAISE EXCEPTION 'deep contract: tick % posted %',n,(SELECT jsonb_agg(body) FROM pg_temp.dh_posts WHERE tick=n); END IF;
  IF EXISTS(SELECT 1 FROM pg_temp.dh_posts a JOIN pg_temp.dh_posts b ON a.tick=b.tick AND a.seq<b.seq
    WHERE a.tick=n AND a.body->>'source'<>'patios' AND b.body->>'source'='patios')
  THEN RAISE EXCEPTION 'deep contract: a user mailbox was called before the group'; END IF;
  FOR c IN SELECT * FROM pg_temp.dh_posts WHERE tick=n LOOP
   IF (c.body->>'from')::timestamptz<floor_ THEN
    RAISE EXCEPTION 'deep contract: deep slice below the oldest monitored job''s start: %',c.body;
   END IF;
   IF c.body->>'source'<>'patios' AND (c.body->>'to')::timestamptz-(c.body->>'from')::timestamptz>interval '31 days'
   THEN RAISE EXCEPTION 'deep contract: a user slice over 31 days %',c.body; END IF;
   IF (c.body->>'to')::timestamptz>lf THEN RAISE EXCEPTION 'deep contract: a slice above the live floor %',c.body; END IF;
  END LOOP;
  EXIT WHEN NOT EXISTS(SELECT 1 FROM public.context_email_deep_plan WHERE state<>'succeeded');
  -- The reader finishes every slice it was called for.
  FOR p IN SELECT * FROM public.context_email_deep_plan WHERE state='loading' LOOP
   PERFORM pg_temp.dh_run(p.source_key,'succeeded','{"progressed":5}');
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.context_email_deep_plan WHERE state<>'succeeded') THEN
  RAISE EXCEPTION 'deep contract: deep slice not posted, the walk did not finish %',(SELECT jsonb_agg(to_jsonb(x)) FROM public.context_email_deep_plan x);
 END IF;
 FOR p IN SELECT * FROM public.context_email_deep_plan LOOP
  IF p.covered_from<>floor_ OR p.needing_jobs<>0 OR p.slices_done<>(CASE WHEN p.kind='group' THEN 1 ELSE 8 END) OR p.succeeded_at IS NULL
  THEN RAISE EXCEPTION 'deep contract: finished plan %',to_jsonb(p); END IF;
 END LOOP;
 -- Exactly the oldest job's start, in the last slice of each user mailbox.
 IF (SELECT min((body->>'from')::timestamptz) FROM pg_temp.dh_posts)<>floor_ THEN RAISE EXCEPTION 'deep contract: the walk did not reach the floor'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_email_deep_members m CROSS JOIN public.context_email_deep_plan pl
   LEFT JOIN public.context_email_deep_reach rr ON rr.source_key=pl.source_key AND rr.job_id=m.job_id
   WHERE coalesce(rr.reaches,pl.live_floor)>m.lead_in_from)
 THEN RAISE EXCEPTION 'deep contract: a job does not reach its start'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_email_history_reach_jobs(NULL,now()) WHERE status<>'reaches_start' OR reason IS NOT NULL OR reaches>lead_in_from)
 THEN RAISE EXCEPTION 'deep contract: reach after the walk %',(SELECT jsonb_agg(to_jsonb(x)) FROM public.context_email_history_reach_jobs(NULL,now()) x); END IF;
 o:=public.context_email_history_reach(now());
 IF (o->>'email_depth_pct')::numeric<>100 OR (o->>'mailboxes_finished')::int<>3 OR (o->>'mailboxes_selected')::int<>3
  OR (o->'jobs'->>'monitored')::int<>4 OR (o->'jobs'->>'reaches_start')::int<>4 OR (o->>'target_floor')::timestamptz<>floor_
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(o->'mailboxes') b WHERE NOT (b->>'finished')::boolean OR NOT (b->>'reaches_target')::boolean
   OR (b->>'reaches')::timestamptz<>floor_ OR (b->>'needing_jobs')::int<>0)
  OR (SELECT array_agg(b->>'source_key' ORDER BY o2) FROM jsonb_array_elements(o->'mailboxes') WITH ORDINALITY AS x(b,o2))<>ARRAY['nithin','patios','shaun']
 THEN RAISE EXCEPTION 'deep contract: mailbox reach %',o; END IF;
 IF NOT (public.context_email_deep_status()->>'finished')::boolean THEN RAISE EXCEPTION 'deep contract: status not finished'; END IF;
 -- A finished load posts nothing.
 DELETE FROM pg_temp.dh_posts;
 o:=pg_temp.dh_tick();
 IF o->>'outcome'<>'finished' OR EXISTS(SELECT 1 FROM pg_temp.dh_posts) THEN RAISE EXCEPTION 'deep contract: a finished load posted %',o; END IF;
END $$;

-- 9. A job that joins after the walk waits for the next Perth day's walk, then
-- is read from the top down to its own start, never further.
DO $$
DECLARE t0 timestamptz:=(SELECT t0 FROM dh_t); lf timestamptz; o jsonb; p record; i integer;
BEGIN
 lf:=t0-interval '4 days';
 INSERT INTO public.jobs(id,org_id,job_number,status,type,created_at)
 SELECT 'd7e00000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-0000000000aa','SWF-DH31','processing','fencing',t0-interval '10 days';
 DELETE FROM pg_temp.dh_posts;
 o:=pg_temp.dh_tick();
 IF EXISTS(SELECT 1 FROM pg_temp.dh_posts) OR EXISTS(SELECT 1 FROM public.context_email_deep_plan WHERE state<>'succeeded' OR needing_jobs<>1)
 THEN RAISE EXCEPTION 'deep contract: a second walk the same Perth day %',(SELECT jsonb_agg(to_jsonb(x)) FROM public.context_email_deep_plan x); END IF;
 IF (SELECT status||':'||reason FROM public.context_email_history_reach_jobs(ARRAY['d7e00000-0000-4000-8000-0000000000e1'::uuid],now()))<>'loading:next_daily_walk'
 THEN RAISE EXCEPTION 'deep contract: late joiner reason'; END IF;
 UPDATE public.context_email_deep_plan SET walk_day=walk_day-1;
 o:=pg_temp.dh_tick();
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key='patios';
 IF p.slice_kind<>'catchup' OR p.slice_from<>t0-interval '40 days' OR p.slice_to<>lf OR p.state<>'loading' THEN RAISE EXCEPTION 'deep contract: catch-up %',to_jsonb(p); END IF;
 SELECT * INTO p FROM public.context_email_deep_plan WHERE source_key='nithin';
 IF p.slice_kind<>'catchup' OR p.slice_from<>t0-interval '35 days' OR p.slice_to<>lf THEN RAISE EXCEPTION 'deep contract: user catch-up %',to_jsonb(p); END IF;
 FOR i IN 1..10 LOOP
  FOR p IN SELECT * FROM public.context_email_deep_plan WHERE state='loading' LOOP
   PERFORM pg_temp.dh_run(p.source_key,'succeeded','{"progressed":1}');
  END LOOP;
  o:=pg_temp.dh_tick();
  EXIT WHEN NOT EXISTS(SELECT 1 FROM public.context_email_deep_plan WHERE state<>'succeeded');
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.context_email_deep_plan WHERE state<>'succeeded' OR covered_from<>t0-interval '230 days')
  OR (SELECT status FROM public.context_email_history_reach_jobs(ARRAY['d7e00000-0000-4000-8000-0000000000e1'::uuid],now()))<>'reaches_start'
  OR (SELECT min((body->>'from')::timestamptz) FROM pg_temp.dh_posts)<>t0-interval '40 days'
 THEN RAISE EXCEPTION 'deep contract: late joiner not caught up %',(SELECT jsonb_agg(to_jsonb(x)) FROM public.context_email_deep_plan x); END IF;
END $$;

-- 10. A job whose keys change starts over; a job whose start moves earlier
-- keeps only what was read down to its old start; a job that leaves keeps its
-- rows but is credited for nothing; a source no longer selected is given up.
DO $$
DECLARE t0 timestamptz:=(SELECT t0 FROM dh_t); m record; o jsonb;
BEGIN
 UPDATE public.jobs SET client_email='casey.new@example.test' WHERE id='d7e00000-0000-4000-8000-000000000002';
 UPDATE public.context_email_deep_plan SET walk_day=walk_day-1;
 PERFORM pg_temp.dh_pass(interval '1 minute');
 o:=pg_temp.dh_tick();
 SELECT * INTO m FROM public.context_email_deep_members WHERE job_id='d7e00000-0000-4000-8000-000000000002';
 IF EXISTS(SELECT 1 FROM public.context_email_deep_reach WHERE job_id='d7e00000-0000-4000-8000-000000000002') OR m.entered_at<>now()
 THEN RAISE EXCEPTION 'deep contract: a key change kept its reach %',to_jsonb(m); END IF;
 -- A text 120 days back now placed on DH03 moves its start from 100 to 120 days.
 INSERT INTO public.business_events(id,job_id,event_type,source,channel,direction,metadata,payload,occurred_at,recorded_at,context_captured_at,event_at)
 SELECT 'd7ee0000-0000-4000-8000-0000000000f1','d7e00000-0000-4000-8000-000000000003','client.reply','fixture','sms','inbound','{"capture_mode":"backfill"}','{}',
  t0-interval '120 days',t0-interval '120 days',t0-interval '120 days',t0-interval '120 days';
 PERFORM pg_temp.dh_pass(interval '1 minute');
 o:=pg_temp.dh_tick();
 IF EXISTS(SELECT 1 FROM public.context_email_deep_reach WHERE job_id='d7e00000-0000-4000-8000-000000000003' AND reaches<>t0-interval '130 days')
  OR (SELECT lead_in_from FROM public.context_email_deep_members WHERE job_id='d7e00000-0000-4000-8000-000000000003')<>t0-interval '150 days'
 THEN RAISE EXCEPTION 'deep contract: an earlier start was not clamped %',(SELECT jsonb_agg(to_jsonb(x)) FROM public.context_email_deep_reach x WHERE x.job_id='d7e00000-0000-4000-8000-000000000003'); END IF;
 -- DH04 leaves (completed): its member row says so and no slice credits it.
 UPDATE public.jobs SET status='completed' WHERE id='d7e00000-0000-4000-8000-000000000004';
 o:=pg_temp.dh_tick();
 IF (SELECT left_at FROM public.context_email_deep_members WHERE job_id='d7e00000-0000-4000-8000-000000000004') IS NULL
  OR (public.context_email_deep_scope()->'job_numbers') ? 'SWF-DH04'
 THEN RAISE EXCEPTION 'deep contract: a job that left'; END IF;
 -- shaun is switched off: given up, out of the reach read.
 UPDATE public.monitored_mailboxes SET enabled=false WHERE source_key='shaun';
 o:=pg_temp.dh_tick();
 IF (SELECT state||':'||gave_up_reason FROM public.context_email_deep_plan WHERE source_key='shaun')<>'gave_up:source_not_selected'
  OR EXISTS(SELECT 1 FROM public.context_email_history_reach_jobs(NULL,now()) x, jsonb_array_elements(x.sources) s WHERE s->>'source_key'='shaun')
  OR (public.context_email_history_reach(now())->>'mailboxes_selected')::int<>2
 THEN RAISE EXCEPTION 'deep contract: a source no longer selected %',(SELECT to_jsonb(x) FROM public.context_email_deep_plan x WHERE x.source_key='shaun'); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 11. While the 60-day load of a mailbox is unfinished or running, the deep
-- load never calls that mailbox; it goes on with the others.
SET LOCAL session_replication_role = replica;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE pg_temp.dh_posts(seq bigserial, body jsonb);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,
 timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO pg_temp.dh_posts(body) VALUES(body) RETURNING seq $$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'eyJ.deep.fixture'::text $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2','email_reader_deep_v1');
UPDATE public.monitored_mailboxes SET enabled=(source_key IN ('patios','nithin'));
UPDATE public.jobs SET status='completed';
DELETE FROM public.context_capture_runs;
DELETE FROM public.context_email_history_plan;
INSERT INTO public.context_capture_runs(source,status,started_at,updated_at,finished_at,window_from,window_to,counts,cursor)
SELECT 'outlook_'||k,'succeeded',now()-interval '4 days',now()-interval '4 days',now()-interval '4 days',date_trunc('second',now())-interval '4 days',
 now()-interval '4 days','{}','{"mode":"poll"}' FROM unnest(ARRAY['patios','nithin']) k;
INSERT INTO public.jobs(id,org_id,job_number,status,type,created_at)
VALUES ('d7e00000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000aa','SWF-DH01','processing','fencing',now()-interval '200 days');
INSERT INTO public.context_email_history_plan(source_key,state) VALUES ('patios','loading');
DO $$
DECLARE o jsonb;
BEGIN
 o:=public.trigger_context_email_deep_history();
 IF (SELECT array_agg(body->>'source') FROM pg_temp.dh_posts)<>ARRAY['nithin']
  OR (SELECT state FROM public.context_email_deep_plan WHERE source_key='patios')<>'waiting_near'
 THEN RAISE EXCEPTION 'deep contract: read a mailbox the 60-day load is reading %',o; END IF;
 IF (SELECT reason FROM public.context_email_history_reach_jobs(NULL,now()) LIMIT 1)<>'waiting_near_load'
 THEN RAISE EXCEPTION 'deep contract: waiting reason %',(SELECT to_jsonb(x) FROM public.context_email_history_reach_jobs(NULL,now()) x); END IF;
 UPDATE public.context_email_history_plan SET state='succeeded' WHERE source_key='patios';
 INSERT INTO public.context_capture_runs(source,status) VALUES ('outlook_history_patios','running');
 DELETE FROM pg_temp.dh_posts;
 o:=public.trigger_context_email_deep_history();
 IF EXISTS(SELECT 1 FROM pg_temp.dh_posts WHERE body->>'source'='patios') THEN RAISE EXCEPTION 'deep contract: called over a running 60-day run'; END IF;
 DELETE FROM public.context_capture_runs WHERE source='outlook_history_patios';
 o:=public.trigger_context_email_deep_history();
 IF NOT EXISTS(SELECT 1 FROM pg_temp.dh_posts WHERE body->>'source'='patios')
  OR (SELECT state FROM public.context_email_deep_plan WHERE source_key='patios')<>'loading'
 THEN RAISE EXCEPTION 'deep contract: never resumed after the 60-day load %',o; END IF;
END $$;
ROLLBACK;

-- 12. The bodies are the ones the guard accepts on a re-apply.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.automation_switch_cron_lanes()'::regprocedure)<>'250d7e9ec2ebecc7e83192a39b7da488'
 THEN RAISE EXCEPTION 'deep contract: the lane list differs from the md5 the guard accepts on a re-apply'; END IF;
END $$;

-- 13. A re-apply changes nothing and keeps the owner's flag setting; on a
-- pg_cron stand-in the job is created gated, once, and the switch's wrap sees
-- it as already wrapped.
BEGIN;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='email_reader_deep_v1';
CREATE TEMP TABLE dh_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid,'pg_proc') AS note
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND (p.proname LIKE 'context_email_deep%' OR p.proname LIKE 'context_email_history_reach%'
  OR p.proname IN ('trigger_context_email_deep_history','automation_switch_cron_lanes'));
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY,schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true,jobname text);
CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) RETURNING jobid
$$;
\ir ../../../migrations/20261007080000_context_email_deep_history.sql
\ir ../../../migrations/20261007080000_context_email_deep_history.sql
DO $$
DECLARE w record;
BEGIN
 IF (SELECT count(*) FROM dh_before)<>11 OR EXISTS(SELECT 1 FROM dh_before b JOIN pg_proc p ON p.oid=b.sig::regprocedure
   WHERE md5(p.prosrc)<>b.md5 OR obj_description(p.oid,'pg_proc') IS DISTINCT FROM b.note)
 THEN RAISE EXCEPTION 'deep contract: a re-apply changed a function'; END IF;
 IF NOT (SELECT enabled FROM public.feature_flags WHERE flag_name='email_reader_deep_v1') THEN RAISE EXCEPTION 'deep contract: a re-apply turned the flag off'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='email_reader_deep_v1')<>1 THEN RAISE EXCEPTION 'deep contract: a re-apply duplicated the flag'; END IF;
 IF (SELECT count(*) FROM cron.job WHERE jobname='outlook-mail-deep-history')<>1 THEN RAISE EXCEPTION 'deep contract: re-apply scheduled twice'; END IF;
 IF (SELECT schedule||' '||command FROM cron.job WHERE jobname='outlook-mail-deep-history')
  <>'4-59/5 * * * * SELECT public.trigger_context_email_deep_history() WHERE public.automation_lane_enabled(''capture'')'
 THEN RAISE EXCEPTION 'deep contract: job %',(SELECT jsonb_agg(row_to_json(j)) FROM cron.job j); END IF;
 SELECT * INTO w FROM public.automation_switch_wrap_cron_jobs() x WHERE x.cron_jobname='outlook-mail-deep-history';
 IF w.outcome<>'already_wrapped' THEN RAISE EXCEPTION 'deep contract: wrap %',row_to_json(w); END IF;
END $$;
ROLLBACK;
