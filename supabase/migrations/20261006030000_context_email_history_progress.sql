-- W7 (6 Oct 2026): the Outlook history load moves on, and a source that stops
-- moving is set aside in plain sight instead of holding every other mailbox.
-- Built on gap plan B-1 (20261005180000).
--
-- Why: from 5 Oct 01:32Z the fencing group mailbox's history run ended
-- 'partial' every 5 minutes with 0 rows saved and no cursor (window_to null),
-- and the next run started the 59-day window again (252 runs by 22:27Z, every
-- one a re-read of the same newest 400 conversations). The reader's fix is in
-- outlook-mail-capture/capture.ts (the group history walk: every run records
-- where it stopped and the next run starts there; counts.progressed says how
-- far it moved). The tick that drives the load had two faults of its own: it
-- counted a run that moved nothing as loading, so a stuck source held the
-- queue (eight mailboxes waited behind fencing), and its only stop was a fixed
-- 288 calls, after which the source was marked gave_up and never loaded, with
-- nothing to say so but a row nobody reads.
--
-- What it does:
--  1. context_email_history_plan gains: posts_since_progress (calls made since
--     the reader last moved this source's cursor), last_run_id (the run last
--     judged, so a run is judged once), last_progress_at, stalled_at,
--     stall_reason, stalls (how many times it stalled). State 'stalled' is
--     added. No existing row is changed: the new columns start at 0 or null.
--  2. trigger_context_email_history(), replaced:
--       * the newest finished run of a loading source's exact window is
--         judged once: it moved when it succeeded or counts.progressed > 0
--         (counts.inserted for a run of the reader before W7). A move resets
--         posts_since_progress and stamps last_progress_at.
--       * a loading source with 3 calls since its last move is 'stalled'
--         (reason: the last run's error code, or no_progress, or no_run when
--         the reader recorded nothing), with a WARNING in the database log.
--         The next source is called at once; a stalled source never holds
--         the queue.
--       * a stalled source is tried again 6 hours after it stalled, once no
--         pending or loading source is waiting to be called, with three
--         fresh calls. It never silently stops.
--       * the fixed 288-call limit is gone: a source that keeps moving keeps
--         loading until the reader finishes its window.
--     Everything else is B-1's: the four flags, the lock, the plan rows, the
--     window fixed at the first call and moved forward near the 60-day limit,
--     waiting while a run is running, succeeded on a succeeded run of the
--     exact window and then the re-list for reading, source_not_selected,
--     one call a tick, nothing once every source is finished.
--  3. context_email_history_status(), replaced: also stalled in by_state,
--     'finished' only when no source is pending, loading or stalled, an
--     'attention' list (every stalled or gave_up source with its reason and
--     the time it last moved), and the new columns per plan row.
--
-- No flag is turned on, no plan row is changed, no business_events row is
-- written, no mail is read by this migration, and no grant, policy or view is
-- added for anon or authenticated. Both re-created functions keep a fixed
-- search_path and EXECUTE revoked from PUBLIC, anon and authenticated.
--
-- Replaces exactly two functions. Pre-images (md5 of prosrc):
--   trigger_context_email_history()   a71be49e6ccde7ffbb4a6fc96d27bfdd (B-1, read live 6 Oct)
--                                     or 5bf1f3cb7390cd299c08488315d2a97e (this migration's, a re-apply)
--   context_email_history_status()    bd6e46c2ba40da0bcf7f714fd67b63a8 (B-1, read live 6 Oct)
--                                     or 528c22d64509a47cf039859d09ae1447 (this migration's)
-- The guard refuses otherwise, or when the plan table is missing.
--
-- After deploy: the fencing row as it stands (loading with 250+ calls, or
-- gave_up call_limit once B-1's limit was reached) needs a reset to start a
-- fresh window: scripts/context-email-history-fencing-reset.sql (dry run,
-- ROLLBACK) after the read-only scripts/context-email-history-check.sql.
-- That is a live-data write and needs the owner's go.
--
-- Rollback: supabase/rollbacks/20261006030000_context_email_history_progress_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 IF to_regclass('public.context_email_history_plan') IS NULL THEN
  problems:=problems||'public.context_email_history_plan is missing (apply 20261005180000 first)'::text;
 END IF;
 FOR x IN SELECT * FROM (VALUES
  ('public.trigger_context_email_history()',ARRAY['a71be49e6ccde7ffbb4a6fc96d27bfdd','5bf1f3cb7390cd299c08488315d2a97e']),
  ('public.context_email_history_status()',ARRAY['bd6e46c2ba40da0bcf7f714fd67b63a8','528c22d64509a47cf039859d09ae1447'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regprocedure('public.context_email_reader_flags()') IS NULL
  OR to_regprocedure('public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer)') IS NULL THEN
  problems:=problems||'the email reader flags or the backfill re-list is missing'::text;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'email_history_progress_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The plan's progress columns and the stalled state.
ALTER TABLE public.context_email_history_plan
 ADD COLUMN IF NOT EXISTS posts_since_progress integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS last_run_id uuid,
 ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
 ADD COLUMN IF NOT EXISTS stalled_at timestamptz,
 ADD COLUMN IF NOT EXISTS stall_reason text,
 ADD COLUMN IF NOT EXISTS stalls integer NOT NULL DEFAULT 0;
ALTER TABLE public.context_email_history_plan DROP CONSTRAINT IF EXISTS context_email_history_plan_progress;
ALTER TABLE public.context_email_history_plan ADD CONSTRAINT context_email_history_plan_progress
 CHECK (posts_since_progress>=0 AND stalls>=0 AND (state<>'stalled' OR stalled_at IS NOT NULL));
ALTER TABLE public.context_email_history_plan DROP CONSTRAINT IF EXISTS context_email_history_plan_state_check;
ALTER TABLE public.context_email_history_plan ADD CONSTRAINT context_email_history_plan_state_check
 CHECK (state IN ('pending','loading','stalled','succeeded','gave_up'));
COMMENT ON TABLE public.context_email_history_plan IS
 'Gap plan B-1 and W7: the Outlook history load, one row per selected source: its fixed window, calls made, calls since the reader last moved its cursor, the reader''s last run for that window, and pending / loading / stalled / succeeded / gave_up. Written only by trigger_context_email_history(). No anon or authenticated access.';

-- 2. One tick of the history load (B-1's, plus the progress rules, marked W7).
CREATE OR REPLACE FUNCTION public.trigger_context_email_history() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_email_reader_flags(); h boolean; p record; r record; lst jsonb; since timestamptz;
 nowm timestamptz:=date_trunc('minute',now()); wf timestamptz; wt timestamptz; finished integer:=0;
 got boolean; moved boolean; run_code text; n integer;
 -- W7: calls without a move before a source is set aside, and how long it rests.
 stall_after constant integer:=3; stall_rest constant interval:='6 hours';
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

 -- What the reader recorded for each loading source's exact window. W7: each
 -- finished run is judged once, and a source that stopped moving is set aside.
 FOR p IN SELECT * FROM public.context_email_history_plan WHERE state='loading' ORDER BY source_key COLLATE "C" LOOP
  SELECT c.id, c.status, c.counts, c.error_code INTO r FROM public.context_capture_runs c
  WHERE c.source='outlook_history_'||p.source_key AND c.status<>'running'
   AND c.cursor->>'history_from'=to_char(p.window_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   AND c.cursor->>'history_to'=to_char(p.window_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ORDER BY c.started_at DESC LIMIT 1;
  got:=FOUND; run_code:=CASE WHEN got THEN r.error_code END;
  IF got AND r.id IS DISTINCT FROM p.last_run_id THEN
   -- W7: a run moved when it finished the window or moved the cursor.
   moved:=r.status='succeeded' OR coalesce(
    CASE WHEN jsonb_typeof(r.counts->'progressed')='number' THEN (r.counts->>'progressed')::numeric END,
    CASE WHEN jsonb_typeof(r.counts->'inserted')='number' THEN (r.counts->>'inserted')::numeric END,0)>0;
   UPDATE public.context_email_history_plan SET last_run_status=r.status, last_run_id=r.id, updated_at=now(),
    posts_since_progress=CASE WHEN moved THEN 0 ELSE posts_since_progress END,
    last_progress_at=CASE WHEN moved THEN now() ELSE last_progress_at END
   WHERE source_key=p.source_key;
   IF r.status='succeeded' THEN
    SELECT min(x.started_at) INTO since FROM public.context_email_history_plan x;
    lst:=public.context_catchup_list_backfill('outlook-mail-capture',coalesce(since,p.started_at),false,5000,2);
    UPDATE public.context_email_history_plan SET state='succeeded', succeeded_at=now(), updated_at=now(),
     listed=jsonb_build_object('at',now(),'candidates',lst->'candidates','written',lst->'written','more',lst->'more')
    WHERE source_key=p.source_key;
    CONTINUE;
   END IF;
  END IF;
  -- W7: three calls and the cursor never moved: set aside, loudly.
  UPDATE public.context_email_history_plan SET state='stalled', stalled_at=now(), stalls=stalls+1, updated_at=now(),
   stall_reason=CASE WHEN NOT got THEN 'no_run' ELSE coalesce(run_code,'no_progress') END
  WHERE source_key=p.source_key AND state='loading' AND posts_since_progress>=stall_after;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n>0 THEN
   RAISE WARNING 'email_history_stalled: source % made no progress in % calls',p.source_key,stall_after;
  END IF;
 END LOOP;

 -- One call for the first source not yet finished. W7: pending and loading
 -- sources first; a stalled source rests 6 hours, then waits its turn.
 FOR p IN SELECT * FROM public.context_email_history_plan
  WHERE state IN ('pending','loading') OR (state='stalled' AND stalled_at<=now()-stall_rest)
  ORDER BY (state='stalled'), source_key COLLATE "C" LOOP
  IF NOT EXISTS(SELECT 1 FROM public.monitored_mailboxes m WHERE m.source_key=p.source_key
    AND m.enabled AND m.status='active' AND m.kind IN ('user','group')) THEN
   UPDATE public.context_email_history_plan SET state='gave_up', gave_up_reason='source_not_selected', updated_at=now() WHERE source_key=p.source_key;
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
  -- W7: a stalled source called again starts with fresh calls.
  UPDATE public.context_email_history_plan SET state='loading', posts=posts+1, last_posted_at=now(), started_at=coalesce(started_at,now()),
   posts_since_progress=CASE WHEN p.state='stalled' THEN 1 ELSE posts_since_progress+1 END,
   replans=replans+CASE WHEN p.window_from IS NOT NULL AND wf<>p.window_from THEN 1 ELSE 0 END,
   window_from=wf, window_to=wt, updated_at=now()
  WHERE source_key=p.source_key;
  RETURN jsonb_build_object('outcome','posted','source',p.source_key,'from',wf,'to',wt,'retry',p.state='stalled');
 END LOOP;
 SELECT count(*) INTO finished FROM public.context_email_history_plan WHERE state IN ('succeeded','gave_up');
 RETURN jsonb_build_object('outcome','finished','sources',finished,
  'stalled',(SELECT count(*) FROM public.context_email_history_plan WHERE state='stalled'));
END $$;
COMMENT ON FUNCTION public.trigger_context_email_history() IS
 'Gap plan B-1 and W7 (20261006030000): one tick of the Outlook history load, run by trigger_context_email_poll() every 5 minutes while email_reader_v1, email_reader_schedule_v1, email_capture_v2 and email_reader_history_v1 are on. Judges each loading source''s newest finished run once (moved: succeeded or counts.progressed > 0); marks a source succeeded on a succeeded run for its window (then lists the loaded jobs for reading through context_catchup_list_backfill); sets a source stalled after 3 calls without a move (WARNING email_history_stalled) and tries it again 6 hours later; posts one {mode: history} call for the first unfinished source, pending and loading before stalled. No call limit.';

-- 3. The plan as one read.
CREATE OR REPLACE FUNCTION public.context_email_history_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
  'flag',coalesce((SELECT bool_or(ff.enabled) FROM public.feature_flags ff WHERE ff.flag_name='email_reader_history_v1'),false),
  'sources',(SELECT count(*) FROM public.context_email_history_plan),
  'by_state',coalesce((SELECT jsonb_object_agg(s.state,s.n) FROM (SELECT state, count(*) AS n FROM public.context_email_history_plan GROUP BY state) s),'{}'::jsonb),
  'finished',NOT EXISTS(SELECT 1 FROM public.context_email_history_plan WHERE state IN ('pending','loading','stalled'))
   AND EXISTS(SELECT 1 FROM public.context_email_history_plan),
  'attention',coalesce((SELECT jsonb_agg(jsonb_build_object('source_key',x.source_key,'state',x.state,
    'reason',CASE WHEN x.state='stalled' THEN x.stall_reason ELSE x.gave_up_reason END,
    'since',CASE WHEN x.state='stalled' THEN x.stalled_at ELSE x.updated_at END,'last_progress_at',x.last_progress_at,
    'posts',x.posts,'stalls',x.stalls) ORDER BY x.source_key COLLATE "C")
   FROM public.context_email_history_plan x WHERE x.state IN ('stalled','gave_up')),'[]'::jsonb),
  'plan',coalesce((SELECT jsonb_agg(jsonb_build_object('source_key',x.source_key,'state',x.state,'window_from',x.window_from,'window_to',x.window_to,
    'posts',x.posts,'replans',x.replans,'last_run_status',x.last_run_status,'last_posted_at',x.last_posted_at,'succeeded_at',x.succeeded_at,
    'gave_up_reason',x.gave_up_reason,'listed',x.listed,'posts_since_progress',x.posts_since_progress,'last_progress_at',x.last_progress_at,
    'stalled_at',x.stalled_at,'stall_reason',x.stall_reason,'stalls',x.stalls) ORDER BY x.source_key COLLATE "C") FROM public.context_email_history_plan x),'[]'::jsonb))
$$;
COMMENT ON FUNCTION public.context_email_history_status() IS
 'Gap plan B-1 and W7 (20261006030000): the Outlook history load as one read: flag, sources, count by state, finished (no source pending, loading or stalled), attention (every stalled or gave_up source with its reason, since when and when it last moved), and the plan rows (codes, times and counts only). Service role.';

-- 4. Grants. Service-side only, as B-1 set them.
REVOKE ALL ON FUNCTION public.trigger_context_email_history(),public.context_email_history_status() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.trigger_context_email_history() FROM service_role;
GRANT EXECUTE ON FUNCTION public.context_email_history_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_context_email_history() TO postgres;
