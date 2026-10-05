-- Gap plan B-1 (5 Oct 2026): the email reader skips mail the old path already
-- saved, and the 60-day Outlook history load runs on its own until every
-- source has finished. Built on EM2/EM3 (20261002150000) and the catch-up
-- backlog (20261004100000).
--
-- Why: the old monitor-inbox path saved inbound inbox mail under its own keys
-- (graph:<id>, graph-group:<id>, sources monitor-inbox, monitor_inbox and
-- monitor-inbox-group); the reader keys email:<internet message id>. They never
-- collide, so switching the reader on (and above all a 60-day history load)
-- would save every such email a second time. Both paths take the received time
-- straight from Graph's receivedDateTime (monitor-inbox/index.ts occurred_at,
-- outlook_mail.ts event_at), and the old path keeps the sender as payload.from.
--
-- What it does:
--  1. Feature flag email_reader_history_v1, created OFF: the history load
--     runs only while it and the reader's three flags (email_reader_v1,
--     email_reader_schedule_v1, email_capture_v2) are on.
--  2. context_email_legacy_copy(from, received_at, subject): the id of the old
--     path's row for the same inbound email, or null. Same sender (lower case,
--     trimmed) and either the same received time, or within 2 minutes with the
--     same non-empty subject (another mailbox's copy of one email is delivered
--     a moment apart). Read only. The reader (outlook-mail-capture/capture.ts)
--     calls it before saving an inbound email and skips the email when it
--     answers (counts.skipped_legacy_copy).
--  3. context_catchup_list_backfill(source, since, dry_run, limit, priority):
--     lists for reading every job holding backfill rows of one capture source
--     written since a time (history rows never wake a read on their own).
--     The same list, lock, modes and actions as the backlog writer
--     context_catchup_request_backlog (20261004100000): never-read jobs read
--     in full, read jobs only their unread rows, a done row re-opened only
--     with unread rows, a pending row's priority raised and never lowered.
--     Dry run by default. Written for both history loads: Outlook calls it
--     with 'outlook-mail-capture' here; the GHL history load (gap plan B-2)
--     calls it with 'ghl-history-load'.
--  4. public.context_email_history_plan: one row per selected source (user or
--     group): its fixed 60-day window, the posts made, the reader's last run
--     status for that window, and pending / loading / succeeded / gave_up.
--  5. trigger_context_email_history(): one tick of the history load. Idle
--     unless the four flags are on. Adds any selected source missing from the
--     plan; marks a loading source succeeded once the reader recorded a
--     succeeded history run for its exact window, and then lists the loaded
--     jobs for reading (3); then posts ONE history call for the first source
--     (by source_key) still pending or loading, unless that source's history
--     run is still running. A cut run resumes on the next call: the window is
--     fixed per source at its first call (from = that minute less 59 days,
--     to = that minute), and the reader resumes a window it did not finish
--     (capture.ts). A window about to pass the reader's 60-day limit is moved
--     to start 59 days back from now. A source given 288 calls (a day of
--     ticks) without finishing is marked gave_up. Once every source is
--     succeeded or gave_up it posts nothing (a source added later is loaded
--     when it appears).
--  6. trigger_context_email_poll() (EM3's 5-minute cron caller) runs that tick
--     after its own poll post, in its own subtransaction, so a history fault
--     never stops the poll. No new cron job: the tick rides outlook-mail-poll,
--     which is already gated by the capture lane and listed in
--     automation_switch_cron_lanes(); that function is not replaced here.
--  7. context_email_history_status(): the plan as one read for the desk.
--
-- No flag is turned on, no business_events row is written, no mail is read by
-- this migration, and no grant, policy or view is added for anon or
-- authenticated. Every new or re-created function: fixed search_path, EXECUTE
-- revoked from PUBLIC, anon, authenticated.
--
-- Replaces exactly one existing function: trigger_context_email_poll()
-- (EM3, 20261002150000). Pre-image: md5(prosrc) 7681b900e3be69c8df1d935f85fbde0a
-- (the EM3 body) or 1430e54e4443b839865d3b4874793e15 (this migration's, a re-apply). The guard refuses
-- otherwise, and refuses when the EM3 reader helpers or the 20261004100000
-- list columns are missing, or when email_reader_history_v1 already exists on
-- the first apply.
--
-- Stop the history load at once: update public.feature_flags set
-- enabled=false where flag_name='email_reader_history_v1';
-- Re-run one source from scratch: update public.context_email_history_plan
-- set state='pending', posts=0, window_from=NULL, window_to=NULL,
-- succeeded_at=NULL where source_key='<key>';
--
-- Rollback: supabase/rollbacks/20261005180000_context_email_legacy_dedupe_and_history_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; first_apply boolean;
BEGIN
 first_apply:=to_regclass('public.context_email_history_plan') IS NULL;
 FOR x IN SELECT * FROM (VALUES
  ('public.trigger_context_email_poll()',ARRAY['7681b900e3be69c8df1d935f85fbde0a','1430e54e4443b839865d3b4874793e15'],false)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regprocedure('public.context_email_reader_flags()') IS NULL THEN
  problems:=problems||'context_email_reader_flags() missing (apply 20261002150000 first)'::text;
 END IF;
 IF to_regprocedure('public.context_unread_rows(uuid[])') IS NULL
  OR to_regprocedure('public.context_catchup_eligible_rows(uuid[])') IS NULL
  OR to_regprocedure('public.context_catchup_pending_rows(uuid[])') IS NULL THEN
  problems:=problems||'catch-up read functions missing'::text;
 END IF;
 IF to_regclass('public.context_catchup_jobs') IS NULL
  OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid='public.context_catchup_jobs'::regclass
   AND a.attname IN ('mode','scope') AND a.attnum>0 AND NOT a.attisdropped)<>2 THEN
  problems:=problems||'context_catchup_jobs lacks mode and scope (apply 20261004100000 first)'::text;
 END IF;
 IF to_regclass('public.context_capture_runs') IS NULL OR to_regclass('public.monitored_mailboxes') IS NULL THEN
  problems:=problems||'context_capture_runs or monitored_mailboxes missing'::text;
 END IF;
 IF to_regclass('public.feature_flags') IS NULL THEN
  problems:=problems||'feature_flags table missing'::text;
 ELSIF first_apply AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_history_v1') THEN
  problems:=problems||'feature flag email_reader_history_v1 already exists; this migration creates it off'::text;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'email_history_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The flag, off. A re-apply keeps the owner's setting.
INSERT INTO public.feature_flags(flag_name,enabled,description)
SELECT 'email_reader_history_v1',false,'Email reader history load (gap plan B-1): the 5-minute email tick loads the last 59 days of every selected Outlook source, one source per call, until each has finished, and lists the loaded jobs for reading. Also needs email_reader_v1, email_reader_schedule_v1 and email_capture_v2.'
WHERE NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_history_v1');

-- 2. The old path's copy of one inbound email.
CREATE OR REPLACE FUNCTION public.context_email_legacy_copy(p_from text,p_received_at timestamptz,p_subject text DEFAULT NULL)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH k AS (
  SELECT lower(btrim(p_from)) AS sender,
   nullif(lower(regexp_replace(btrim(coalesce(p_subject,'')),'\s+',' ','g')),'(no subject)') AS subject
 )
 SELECT e.id FROM public.business_events e, k
 WHERE k.sender<>'' AND p_received_at IS NOT NULL
  AND e.occurred_at BETWEEN p_received_at-interval '2 minutes' AND p_received_at+interval '2 minutes'
  AND e.source IN ('monitor-inbox','monitor_inbox','monitor-inbox-group')
  AND lower(btrim(e.payload->>'from'))=k.sender
  AND (e.occurred_at=p_received_at
   OR (nullif(k.subject,'') IS NOT NULL
    AND lower(regexp_replace(btrim(coalesce(e.payload->>'subject','')),'\s+',' ','g'))=k.subject))
 ORDER BY (e.occurred_at=p_received_at) DESC, abs(extract(epoch FROM e.occurred_at-p_received_at)), e.id
 LIMIT 1
$$;
COMMENT ON FUNCTION public.context_email_legacy_copy(text,timestamptz,text) IS
 'Gap plan B-1: the id of the old monitor-inbox path''s business_events row (sources monitor-inbox, monitor_inbox, monitor-inbox-group) for the same inbound email, or null: same sender (payload.from, lower case), and the same received time or within 2 minutes with the same non-empty subject. The email reader skips an inbound email this answers. Read only; service role.';

-- 3. List the jobs a history load filled for reading.
CREATE OR REPLACE FUNCTION public.context_catchup_list_backfill(p_source text,p_since timestamptz,p_dry_run boolean DEFAULT true,
 p_limit integer DEFAULT 500,p_priority integer DEFAULT 2)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dry boolean:=coalesce(p_dry_run,true); lim integer:=coalesce(p_limit,500); pri integer:=coalesce(p_priority,2);
 judged jsonb; picked jsonb; added integer:=0; reopened integer:=0; raised integer:=0;
BEGIN
 IF nullif(btrim(coalesce(p_source,'')),'') IS NULL THEN RAISE EXCEPTION 'context_catchup_backfill_source_invalid: name a capture source'; END IF;
 IF p_since IS NULL THEN RAISE EXCEPTION 'context_catchup_backfill_since_invalid: give the time the load started'; END IF;
 IF lim NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'context_catchup_backfill_limit_invalid: limit must be 1 to 5000'; END IF;
 IF pri NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'context_catchup_backfill_priority_invalid: priority must be 1 to 5'; END IF;
 -- The same lock as context_catchup_request and context_catchup_request_backlog.
 PERFORM pg_advisory_xact_lock(20260924,22);

 WITH src AS (
  SELECT DISTINCT e.job_id FROM public.business_events e
  WHERE e.source=p_source AND e.occurred_at>=p_since AND e.job_id IS NOT NULL
   AND e.metadata->>'capture_mode'='backfill'
 ), rd AS (
  SELECT r.job_id, max(r.finished_at) AS last_read FROM public.context_extraction_runs r
  WHERE r.job_id IN (SELECT s.job_id FROM src s) AND r.phase='extraction' AND r.status='done' GROUP BY r.job_id
 ), member AS (
  SELECT j.id, j.job_number, j.status, coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1') AS extractable, rd.last_read
  FROM src s JOIN public.jobs j ON j.id=s.job_id LEFT JOIN rd ON rd.job_id=j.id
 ), el AS (
  SELECT e.job_id, count(*) AS eligible_n, max(coalesce(e.event_at,e.occurred_at)) AS last_evidence_at,
   count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=e.job_id AND r.event_id=e.id)) AS full_n
  FROM public.context_catchup_eligible_rows(ARRAY(SELECT m.id FROM member m)) e GROUP BY e.job_id
 ), un AS (
  SELECT u.job_id, count(*) AS unread_n FROM public.context_unread_rows(ARRAY(SELECT m.id FROM member m)) u
  WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=u.job_id AND r.event_id=u.id)
  GROUP BY u.job_id
 ), pe AS (
  SELECT p.job_id, count(*) AS pending_n FROM public.context_catchup_pending_rows(ARRAY(SELECT m.id FROM member m)) p GROUP BY p.job_id
 ), base AS (
  SELECT m.*, coalesce(el.eligible_n,0) AS eligible_n, el.last_evidence_at, coalesce(el.full_n,0) AS full_n,
   coalesce(un.unread_n,0) AS unread_n, coalesce(pe.pending_n,0) AS listed_pending_n,
   c.job_id IS NOT NULL AS listed, c.done_at IS NOT NULL AS was_done, c.priority AS old_priority, c.mode AS old_mode
  FROM member m LEFT JOIN el ON el.job_id=m.id LEFT JOIN un ON un.job_id=m.id LEFT JOIN pe ON pe.job_id=m.id
  LEFT JOIN public.context_catchup_jobs c ON c.job_id=m.id
 ), moded AS (
  SELECT b.*,
   CASE WHEN b.listed AND NOT b.was_done THEN b.old_mode WHEN b.last_read IS NULL AND NOT b.listed THEN 'full' ELSE 'unread' END AS mode,
   CASE WHEN b.listed AND NOT b.was_done THEN b.listed_pending_n WHEN b.last_read IS NULL AND NOT b.listed THEN b.full_n ELSE b.unread_n END AS pending_n
  FROM base b
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'job_number',d.job_number,'mode',d.mode,
   'pending_n',d.pending_n,'last_evidence_at',d.last_evidence_at,'action',CASE
   WHEN NOT d.extractable THEN 'holding_job'
   WHEN d.eligible_n=0 THEN 'no_evidence'
   WHEN d.listed AND NOT d.was_done AND pri<d.old_priority THEN 'raise'
   WHEN d.listed AND NOT d.was_done THEN 'already_listed'
   WHEN d.pending_n=0 THEN 'nothing_unread'
   WHEN d.listed THEN 'reopen'
   ELSE 'add' END)),'[]'::jsonb)
 INTO judged FROM moded d;

 SELECT coalesce(jsonb_agg(jsonb_build_object('job_id',x.id,'job_number',x.job_number,'mode',x.mode,
   'action',x.action,'pending_rows',x.pending_n) ORDER BY x.ord),'[]'::jsonb)
 INTO picked
 FROM (SELECT j.*, row_number() OVER (ORDER BY j.last_evidence_at DESC NULLS LAST, j.job_number, j.id) AS ord
  FROM jsonb_to_recordset(judged) AS j(id uuid,job_number text,mode text,pending_n integer,last_evidence_at timestamptz,action text)
  WHERE j.action IN ('add','reopen','raise')) x
 WHERE x.ord<=lim;

 IF NOT dry THEN
  WITH s AS (SELECT (x->>'job_id')::uuid AS job_id, x->>'action' AS action, x->>'mode' AS mode FROM jsonb_array_elements(picked) x),
  ins AS (INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope)
   SELECT s.job_id, coalesce(j.job_number,''), pri, s.mode, 'backlog' FROM s JOIN public.jobs j ON j.id=s.job_id WHERE s.action='add'
   ON CONFLICT (job_id) DO NOTHING RETURNING job_id),
  reo AS (UPDATE public.context_catchup_jobs c SET done_at=NULL,done_run_id=NULL,requested_at=now(),mode='unread',scope='backlog',priority=pri
   FROM s WHERE c.job_id=s.job_id AND s.action='reopen' AND c.done_at IS NOT NULL RETURNING c.job_id),
  rai AS (UPDATE public.context_catchup_jobs c SET priority=pri
   FROM s WHERE c.job_id=s.job_id AND s.action='raise' AND c.done_at IS NULL AND c.priority>pri RETURNING c.job_id)
  SELECT (SELECT count(*) FROM ins),(SELECT count(*) FROM reo),(SELECT count(*) FROM rai) INTO added, reopened, raised;
 END IF;

 RETURN jsonb_build_object('dry_run',dry,'as_of',now(),'source',p_source,'since',p_since,'priority',pri,'limit',lim,
  'jobs_with_backfill',jsonb_array_length(judged),
  'candidates',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action' IN ('add','reopen','raise')),
  'excluded',jsonb_build_object(
   'holding_job',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='holding_job'),
   'no_evidence',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='no_evidence'),
   'nothing_unread',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='nothing_unread'),
   'already_listed',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action'='already_listed')),
  'listed_this_call',jsonb_array_length(picked),
  'more',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action' IN ('add','reopen','raise'))-jsonb_array_length(picked),
  'jobs',picked,
  'written',CASE WHEN dry THEN NULL ELSE jsonb_build_object('added',added,'reopened',reopened,'priority_raised',raised) END);
END $$;
COMMENT ON FUNCTION public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer) IS
 'Gap plan B-1: list for reading every job holding backfill rows (metadata.capture_mode backfill) of one capture source written at or after p_since, through the catch-up list (scope backlog, priority p_priority, default 2). Same lock, modes and actions as context_catchup_request_backlog (20261004100000). The one re-list for history loads: outlook-mail-capture (B-1) and ghl-history-load (B-2). Dry run by default. Service role only.';

-- 4. The history plan.
CREATE TABLE IF NOT EXISTS public.context_email_history_plan (
 source_key text PRIMARY KEY CHECK (source_key ~ '^[a-z][a-z0-9_]{1,40}$'),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','loading','succeeded','gave_up')),
 window_from timestamptz,
 window_to timestamptz,
 posts integer NOT NULL DEFAULT 0 CHECK (posts>=0),
 replans integer NOT NULL DEFAULT 0 CHECK (replans>=0),
 started_at timestamptz,
 last_posted_at timestamptz,
 last_run_status text,
 succeeded_at timestamptz,
 gave_up_reason text,
 listed jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_email_history_plan_window CHECK ((window_from IS NULL)=(window_to IS NULL) AND (window_from IS NULL OR window_from<window_to))
);
COMMENT ON TABLE public.context_email_history_plan IS
 'Gap plan B-1: the Outlook history load, one row per selected source: its fixed window, calls made, the reader''s last run status for that window, and pending / loading / succeeded / gave_up. Written only by trigger_context_email_history(). No anon or authenticated access.';
ALTER TABLE public.context_email_history_plan ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_email_history_plan FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.context_email_history_plan TO service_role;
DROP POLICY IF EXISTS service_role_read ON public.context_email_history_plan;
CREATE POLICY service_role_read ON public.context_email_history_plan FOR SELECT TO service_role USING (true);

-- 5. One tick of the history load.
CREATE OR REPLACE FUNCTION public.trigger_context_email_history() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_email_reader_flags(); h boolean; p record; st text; lst jsonb; since timestamptz;
 nowm timestamptz:=date_trunc('minute',now()); wf timestamptz; wt timestamptz; finished integer:=0; max_posts constant integer:=288;
BEGIN
 IF NOT ((f->>'reader')::boolean AND (f->>'schedule')::boolean AND (f->>'program')::boolean) THEN
  RETURN jsonb_build_object('outcome','idle','reason','reader_flags_off');
 END IF;
 SELECT coalesce(bool_or(ff.enabled),false) INTO h FROM public.feature_flags ff WHERE ff.flag_name='email_reader_history_v1';
 IF NOT h THEN RETURN jsonb_build_object('outcome','idle','reason','email_reader_history_v1_off'); END IF;
 IF NOT pg_try_advisory_xact_lock(20261005,15) THEN RETURN jsonb_build_object('outcome','busy'); END IF;

 -- Every selected source has a plan row.
 INSERT INTO public.context_email_history_plan(source_key)
 SELECT m.source_key FROM public.monitored_mailboxes m
 WHERE m.enabled AND m.status='active' AND m.kind IN ('user','group') AND m.source_key ~ '^[a-z][a-z0-9_]{1,40}$'
 ON CONFLICT (source_key) DO NOTHING;

 -- What the reader recorded for each loading source's exact window.
 FOR p IN SELECT * FROM public.context_email_history_plan WHERE state='loading' ORDER BY source_key LOOP
  SELECT c.status INTO st FROM public.context_capture_runs c
  WHERE c.source='outlook_history_'||p.source_key AND c.status<>'running'
   AND c.cursor->>'history_from'=to_char(p.window_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   AND c.cursor->>'history_to'=to_char(p.window_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ORDER BY c.started_at DESC LIMIT 1;
  IF st IS NULL THEN CONTINUE; END IF;
  UPDATE public.context_email_history_plan SET last_run_status=st, updated_at=now() WHERE source_key=p.source_key;
  IF st='succeeded' THEN
   SELECT min(x.started_at) INTO since FROM public.context_email_history_plan x;
   lst:=public.context_catchup_list_backfill('outlook-mail-capture',coalesce(since,p.started_at),false,5000,2);
   UPDATE public.context_email_history_plan SET state='succeeded', succeeded_at=now(), updated_at=now(),
    listed=jsonb_build_object('at',now(),'candidates',lst->'candidates','written',lst->'written','more',lst->'more')
   WHERE source_key=p.source_key;
  END IF;
 END LOOP;

 -- One call for the first source not yet finished.
 FOR p IN SELECT * FROM public.context_email_history_plan WHERE state IN ('pending','loading') ORDER BY source_key LOOP
  IF NOT EXISTS(SELECT 1 FROM public.monitored_mailboxes m WHERE m.source_key=p.source_key
    AND m.enabled AND m.status='active' AND m.kind IN ('user','group')) THEN
   UPDATE public.context_email_history_plan SET state='gave_up', gave_up_reason='source_not_selected', updated_at=now() WHERE source_key=p.source_key;
   CONTINUE;
  END IF;
  IF p.posts>=max_posts THEN
   UPDATE public.context_email_history_plan SET state='gave_up', gave_up_reason='call_limit', updated_at=now() WHERE source_key=p.source_key;
   CONTINUE;
  END IF;
  IF EXISTS(SELECT 1 FROM public.context_capture_runs c WHERE c.source='outlook_history_'||p.source_key
    AND c.status='running' AND c.updated_at>now()-interval '10 minutes') THEN
   RETURN jsonb_build_object('outcome','waiting','source',p.source_key);
  END IF;
  wf:=p.window_from; wt:=p.window_to;
  IF wf IS NULL OR wf<now()-interval '60 days'+interval '15 minutes' THEN
   wt:=coalesce(wt,nowm); wf:=nowm-interval '59 days';
  END IF;
  PERFORM net.http_post(
   url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture',
   body := jsonb_build_object('mode','history','source',p.source_key,
    'from',to_char(wf AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'to',to_char(wt AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'actor','cron:outlook-mail-history'),
   headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
   timeout_milliseconds := 5000
  );
  UPDATE public.context_email_history_plan SET state='loading', posts=posts+1, last_posted_at=now(), started_at=coalesce(started_at,now()),
   replans=replans+CASE WHEN p.window_from IS NOT NULL AND wf<>p.window_from THEN 1 ELSE 0 END,
   window_from=wf, window_to=wt, updated_at=now()
  WHERE source_key=p.source_key;
  RETURN jsonb_build_object('outcome','posted','source',p.source_key,'from',wf,'to',wt);
 END LOOP;
 SELECT count(*) INTO finished FROM public.context_email_history_plan WHERE state IN ('succeeded','gave_up');
 RETURN jsonb_build_object('outcome','finished','sources',finished);
END $$;
COMMENT ON FUNCTION public.trigger_context_email_history() IS
 'Gap plan B-1: one tick of the Outlook history load, run by trigger_context_email_poll() every 5 minutes while email_reader_v1, email_reader_schedule_v1, email_capture_v2 and email_reader_history_v1 are on. Marks a source succeeded when the reader recorded a succeeded history run for its window (then lists the loaded jobs for reading through context_catchup_list_backfill), and posts one {mode: history} call for the first unfinished source. Stops posting once every source is succeeded or gave_up.';

-- 6. EM3's poll caller, plus the history tick in its own subtransaction.
CREATE OR REPLACE FUNCTION public.trigger_context_email_poll() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_email_reader_flags();
BEGIN
 IF NOT ((f->>'reader')::boolean AND (f->>'schedule')::boolean AND (f->>'program')::boolean) THEN RETURN; END IF;
 PERFORM net.http_post(
  url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture',
  body := jsonb_build_object('mode','poll','actor','cron:outlook-mail-poll'),
  headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
  timeout_milliseconds := 5000
 );
 BEGIN
  PERFORM public.trigger_context_email_history();
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'email_history_tick_failed: %',SQLSTATE;
 END;
END $$;
COMMENT ON FUNCTION public.trigger_context_email_poll() IS
 'pg_cron outlook-mail-poll (every 5 minutes, capture lane): posts {mode: poll} to the outlook-mail-capture edge function with the service key while email_reader_v1, email_reader_schedule_v1 and email_capture_v2 are on (EM3), then runs one history tick, trigger_context_email_history(), which is idle unless email_reader_history_v1 is on (gap plan B-1). A history fault never stops the poll.';

-- 7. The plan as one read.
CREATE OR REPLACE FUNCTION public.context_email_history_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
  'flag',coalesce((SELECT bool_or(ff.enabled) FROM public.feature_flags ff WHERE ff.flag_name='email_reader_history_v1'),false),
  'sources',(SELECT count(*) FROM public.context_email_history_plan),
  'by_state',coalesce((SELECT jsonb_object_agg(s.state,s.n) FROM (SELECT state, count(*) AS n FROM public.context_email_history_plan GROUP BY state) s),'{}'::jsonb),
  'finished',NOT EXISTS(SELECT 1 FROM public.context_email_history_plan WHERE state IN ('pending','loading'))
   AND EXISTS(SELECT 1 FROM public.context_email_history_plan),
  'plan',coalesce((SELECT jsonb_agg(jsonb_build_object('source_key',x.source_key,'state',x.state,'window_from',x.window_from,'window_to',x.window_to,
    'posts',x.posts,'replans',x.replans,'last_run_status',x.last_run_status,'last_posted_at',x.last_posted_at,'succeeded_at',x.succeeded_at,
    'gave_up_reason',x.gave_up_reason,'listed',x.listed) ORDER BY x.source_key) FROM public.context_email_history_plan x),'[]'::jsonb))
$$;
COMMENT ON FUNCTION public.context_email_history_status() IS
 'Gap plan B-1: the Outlook history load as one read: flag, sources, count by state, finished, and the plan rows (codes, times and counts only). Service role.';

-- 8. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_email_legacy_copy(text,timestamptz,text),
 public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer),
 public.trigger_context_email_history(),public.trigger_context_email_poll(),public.context_email_history_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_email_legacy_copy(text,timestamptz,text),
 public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer),public.context_email_history_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_context_email_history(),public.trigger_context_email_poll() TO postgres;
