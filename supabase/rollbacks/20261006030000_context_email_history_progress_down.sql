-- Roll back W7 (20261006030000_context_email_history_progress).
--
-- Restores gap plan B-1's trigger_context_email_history() and
-- context_email_history_status() byte for byte (20261005180000, md5
-- a71be49e6ccde7ffbb4a6fc96d27bfdd and bd6e46c2ba40da0bcf7f714fd67b63a8),
-- B-1's state check and table comment, and drops the six progress columns.
-- A source in state 'stalled' (which B-1 does not know) is put back to
-- 'loading', so B-1's tick calls it again and its 288-call limit applies.
-- No other plan value, run row or evidence row is changed.
-- Deploy the previous outlook-mail-capture too if the reader is rolled back:
-- the W7 reader runs fine under B-1's tick, and B-1's tick under it, but the
-- old reader is the one that loops on a large group mailbox.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF to_regclass('public.context_email_history_plan') IS NULL THEN
  RAISE EXCEPTION 'email_history_progress_rollback_refused: context_email_history_plan is missing';
 END IF;
END $$;

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

UPDATE public.context_email_history_plan SET state='loading', updated_at=now() WHERE state='stalled';
ALTER TABLE public.context_email_history_plan DROP CONSTRAINT IF EXISTS context_email_history_plan_progress;
ALTER TABLE public.context_email_history_plan DROP CONSTRAINT IF EXISTS context_email_history_plan_state_check;
ALTER TABLE public.context_email_history_plan ADD CONSTRAINT context_email_history_plan_state_check
 CHECK (state IN ('pending','loading','succeeded','gave_up'));
ALTER TABLE public.context_email_history_plan
 DROP COLUMN IF EXISTS posts_since_progress,
 DROP COLUMN IF EXISTS last_run_id,
 DROP COLUMN IF EXISTS last_progress_at,
 DROP COLUMN IF EXISTS stalled_at,
 DROP COLUMN IF EXISTS stall_reason,
 DROP COLUMN IF EXISTS stalls;
COMMENT ON TABLE public.context_email_history_plan IS
 'Gap plan B-1: the Outlook history load, one row per selected source: its fixed window, calls made, the reader''s last run status for that window, and pending / loading / succeeded / gave_up. Written only by trigger_context_email_history(). No anon or authenticated access.';

REVOKE ALL ON FUNCTION public.trigger_context_email_history(),public.context_email_history_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_email_history_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_context_email_history() TO postgres;

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.trigger_context_email_history()')) IS DISTINCT FROM 'a71be49e6ccde7ffbb4a6fc96d27bfdd'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_email_history_status()')) IS DISTINCT FROM 'bd6e46c2ba40da0bcf7f714fd67b63a8'
 THEN RAISE EXCEPTION 'email_history_progress_rollback_check_failed: the history functions differ from B-1''s bodies'; END IF;
END $$;
