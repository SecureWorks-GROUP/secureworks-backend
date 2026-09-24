-- T2 (context build plan, Wave 3 / MS4; design transcripts.md §2 "Transcript:
-- one writer, the fetcher", §3, §8, §13a, §14; INTEGRATION X17, X22, X32): the
-- database half of the GHL call transcript fetcher. The edge function
-- ghl-call-transcript-fetch is the other half.
--
-- What it does:
--  1. context_transcript_capture_policy(): every threshold, in one place.
--  2. context_transcript_fetch_flag(): reads feature_flags
--     .ghl_call_transcript_fetch_v1. A missing or unreadable row reads as off
--     (fail closed). This migration creates no flag row: the fetcher stays off
--     until the milestone switch MS5-T, after the extended G-ANON check.
--  3. call_transcript_fetches: one record per GHL call the fetcher has tried
--     (attempts, next try, last code, outcome, the provider's final status and
--     duration, the last read for the agreement rule). RLS on with no policy,
--     nothing for PUBLIC, anon or authenticated; service_role may only read it.
--  4. record_call_transcript_fetch(jsonb): the table's one writer. The backoff
--     lives here, not in the caller: a not-ready or failed read waits 2 min,
--     5 min, 15 min, 1 h, 6 h, 24 h (six waits after the first six reads);
--     the read after the last wait that still fails is terminal
--     (not_returned for "no transcript yet", failed:<code> for a
--     provider or save error). A history-load read of a call older than 48 h
--     that finds no transcript is terminal at once (GHL will not produce one
--     later). A terminal outcome is never reopened. Terminal records older
--     than 30 days are purged by the writer.
--  5. context_call_transcript_eligible(): whether a call is worth asking for
--     a transcript, decided from the stored provider status and duration at
--     selection time (review M1): completed and at least 5 s, completed with
--     no duration recorded (GHL leaves meta.call.duration empty on some
--     answered calls that do carry a transcript: MeVPH47LXDbgcvPUAkjY, 21 Sep,
--     90 sentences), or a voicemail; a tool-initiated call with no status yet
--     is asked and the provider's own re-read decides.
--  6. context_transcript_due_calls(limit): the calls due a fetch now: call
--     rows keyed ghl: with event_at in the last 14 days (review M11), no
--     terminal outcome and next try due, oldest first. A call whose ghltx:
--     transcript row already exists is returned too, so a run that crashed
--     after saving records `saved` next run with no provider call.
--  7. context_transcript_backfill_contacts(after, limit): the GHL contacts of
--     the jobs that are live now, for the history load (the owner, 24 Sep:
--     "for call transcripts i need all the evidence of past jobs as well",
--     "i just need it for the jobs that are currently live"): jobs in the live
--     statuses of the policy, plus draft or quoted jobs with a quote sent in
--     the last 60 days, through jobs.ghl_contact_id, contact ids ascending.
--  8. context_transcript_capture_status() replaces the F1b stub (X22): last
--     run, due, saved, pending, not returned, failed by code, coverage by
--     line, oldest pending, aged_out_unfetched_24h, and the four alarms
--     transcript_fetch_stale, transcript_fetch_failing,
--     transcript_coverage_low and transcript_aged_out, raised only while the
--     capture lane and the fetch flag are on. Counts and codes only.
--  9. trigger_ghl_call_transcript_fetch(): posts to the edge function with the
--     service key from public.sw_service_key(), only while the fetch flag is on.
-- 10. pg_cron job ghl-call-transcript-fetch every 5 minutes, wrapped in
--     WHERE public.automation_lane_enabled('capture'), and listed in
--     automation_switch_cron_lanes() under capture.
--
-- No flag or switch is turned on, no business_events row is written, and no
-- grant, policy or view is added for anon or authenticated. Every new or
-- re-created function: SECURITY DEFINER where it reads or writes, fixed
-- search_path, EXECUTE revoked from PUBLIC, anon, authenticated.
--
-- Built on the LIVE production definitions, read 24 Sep 2026 (read-only):
--   context_transcript_capture_status()   md5(prosrc) 155104bfb08b8b3c2f98bdec089d4ee4 (the F1b stub)
--   automation_switch_cron_lanes()        md5(prosrc) 459035de5d3f7f7af49c36f09d9be29e
--     = the C1d body: monitor-inbox-poll and ghl-message-reconcile (capture),
--       contact-matching (attribution)
--   capture_business_event(jsonb)         md5(prosrc) 4819869e6dcc40d5cd19a7eba295392c (C1a, called by the edge function)
--   record_capture_run(jsonb)             md5(prosrc) db03c98a6da49f128595342f5a93f84c (F1b, called by the edge function)
--   context_business_minutes(timestamptz,timestamptz) md5(prosrc) 510dbec36291c25aa1887ade89e2ca4e (F1)
--   automation_lane_enabled(text)         md5(prosrc) 818a13be854748e2d272bdd648c88b59
--   sw_service_key()                      present
--   the eight new functions: absent; call_transcript_fetches: absent;
--   cron job ghl-call-transcript-fetch: absent; flag ghl_call_transcript_fetch_v1: no row
--   jobs_status_check lists every live status the policy names
-- The guard refuses unless each is still that pre-image or already this
-- migration's result (a re-apply).
--
-- Rollback: supabase/rollbacks/20260925031000_context_transcript_fetch_down.sql
-- (unschedules the job, restores the stub and the three-row lane list, drops
-- the new functions and the table). The edge function idles while the flag is
-- off; turn the flag off before rolling back.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cmd text; cols text; st text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_transcript_capture_status()',ARRAY['155104bfb08b8b3c2f98bdec089d4ee4','fce1a8f610ddf41a26cb097e9bae1171'],false),
  ('public.automation_switch_cron_lanes()',ARRAY['459035de5d3f7f7af49c36f09d9be29e','4f80b88d5c5ef6a49a6677f1a76d6350'],false),
  ('public.capture_business_event(jsonb)',ARRAY['4819869e6dcc40d5cd19a7eba295392c'],false),
  ('public.record_capture_run(jsonb)',ARRAY['db03c98a6da49f128595342f5a93f84c'],false),
  ('public.context_business_minutes(timestamptz,timestamptz)',ARRAY['510dbec36291c25aa1887ade89e2ca4e'],false),
  ('public.automation_lane_enabled(text)',ARRAY['818a13be854748e2d272bdd648c88b59'],false),
  ('public.context_transcript_capture_policy()',ARRAY['45cb788bf9b15bbe1815b629cc7ce050'],true),
  ('public.context_transcript_fetch_flag()',ARRAY['3cae5d15d6b1c00c4d94739fcf3b8744'],true),
  ('public.record_call_transcript_fetch(jsonb)',ARRAY['fb5cd8aa09d37e6e72b90928e1e36cd8'],true),
  ('public.context_call_transcript_eligible(text,text,jsonb)',ARRAY['cd3cb55ab8fa9359b744d3626f14ec6c'],true),
  ('public.context_transcript_due_calls(integer)',ARRAY['8dc5c214c9f28497259d13e2d3627440'],true),
  ('public.context_transcript_backfill_contacts(text,integer)',ARRAY['4ac8914b5a6a01b32f10807fe9903e51'],true),
  ('public.trigger_ghl_call_transcript_fetch()',ARRAY['0ec1769f5f45dff78a5de49f319286a6'],true)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF to_regprocedure('public.sw_service_key()') IS NULL THEN problems:=problems||'public.sw_service_key() missing'::text; END IF;
 IF to_regclass('public.call_transcript_fetches') IS NOT NULL THEN
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.call_transcript_fetches'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'call_message_id:text,call_event_id:uuid,mode:text,outcome:text,attempts:integer,next_at:timestamp with time zone,last_code:text,failure_code:text,provider_status:text,provider_duration_seconds:numeric,seen_sentences:integer,seen_digest:text,seen_at:timestamp with time zone,transcript_event_id:uuid,created_at:timestamp with time zone,updated_at:timestamp with time zone,finished_at:timestamp with time zone'
  THEN problems:=problems||format('call_transcript_fetches exists with columns %s',cols); END IF;
 END IF;
 SELECT pg_get_constraintdef(c.oid) INTO st FROM pg_constraint c WHERE c.conrelid=to_regclass('public.jobs') AND c.conname='jobs_status_check';
 IF st IS NOT NULL THEN
  FOR x IN SELECT unnest(ARRAY['accepted','partially_accepted','scheduled','in_progress','processing','approvals','order_materials',
    'schedule_install','awaiting_supplier','awaiting_deposit','final_payment','rectification','draft','quoted']) AS s LOOP
   IF position(''''||x.s||'''' IN st)=0 THEN problems:=problems||format('jobs_status_check has no status %s',x.s); END IF;
  END LOOP;
 END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT string_agg(command,'' | '') FROM cron.job WHERE jobname=''ghl-call-transcript-fetch''' INTO cmd;
  IF cmd IS NOT NULL AND cmd<>'SELECT public.trigger_ghl_call_transcript_fetch() WHERE public.automation_lane_enabled(''capture'')' THEN
   problems:=problems||'cron job ghl-call-transcript-fetch exists with another command'::text;
  END IF;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_transcript_fetch_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. Thresholds. Business hours are F1's: Mon to Sat, 07:00 to 18:00 Perth.
CREATE OR REPLACE FUNCTION public.context_transcript_capture_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'fetch_flag','ghl_call_transcript_fetch_v1',
  'run_source','ghl_call_transcript',
  'backfill_run_source','ghl_call_transcript_backfill',
  'event_source','ghl-call-transcript',
  'call_event_types',jsonb_build_array('client.call_logged','client.call_initiated'),
  -- Selection: calls from the last 14 days (review M11), oldest first, 40 a run.
  'window_days',14,
  'batch_limit',40,
  -- Eligibility: a completed call of at least this many seconds (or with no
  -- duration recorded), or a voicemail.
  'min_call_seconds',5,
  -- Backoff after a not-ready or failed read; the read after the last wait
  -- that fails again is terminal.
  'backoff_minutes',jsonb_build_array(2,5,15,60,360,1440),
  -- Agreement rule (review M10): a call younger than this at read time is saved
  -- only when two reads at least agreement_minutes apart return the same words.
  'agreement_young_minutes',120,
  'agreement_minutes',5,
  -- History load: a read of a call older than this that finds nothing is final.
  'backfill_final_after_hours',48,
  -- Terminal fetch records older than this are purged by the writer.
  'purge_days',30,
  -- Alarms.
  'stale_minutes',20,
  'failing_business_minutes',120,
  'failing_error_ratio',0.2,
  'failing_min_attempts',5,
  'coverage_min_ratio',0.6,
  'coverage_min_eligible',5,
  -- Coverage looks at calls that ended between 26 h and 2 h ago (time to fetch).
  'coverage_from_hours',26,
  'coverage_to_hours',2,
  -- History load: live jobs (the owner, 24 Sep 2026).
  'live_statuses',jsonb_build_array('accepted','partially_accepted','scheduled','in_progress','processing','approvals',
   'order_materials','schedule_install','awaiting_supplier','awaiting_deposit','final_payment','rectification'),
  'quoted_statuses',jsonb_build_array('draft','quoted'),
  'quote_sent_days',60)
$$;

-- 2. The fetch flag. Fails closed: no table, no row, or an error is off.
CREATE OR REPLACE FUNCTION public.context_transcript_fetch_flag() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE on_flag boolean; changed timestamptz;
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN RETURN jsonb_build_object('enabled',false,'updated_at',NULL,'state','missing'); END IF;
 EXECUTE 'SELECT f.enabled,f.updated_at FROM public.feature_flags f WHERE f.flag_name=$1 ORDER BY f.updated_at DESC NULLS LAST LIMIT 1'
  INTO on_flag,changed USING 'ghl_call_transcript_fetch_v1';
 RETURN jsonb_build_object('enabled',coalesce(on_flag,false),'updated_at',changed,'state',CASE WHEN on_flag IS NULL THEN 'missing' ELSE 'present' END);
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('enabled',false,'updated_at',NULL,'state','unreadable');
END $$;
COMMENT ON FUNCTION public.context_transcript_fetch_flag() IS
 'feature_flags.ghl_call_transcript_fetch_v1 as {enabled, updated_at, state}. Missing or unreadable reads as off. Owned by transcripts slice T2.';

-- 3. The fetch records.
CREATE TABLE IF NOT EXISTS public.call_transcript_fetches (
 call_message_id text PRIMARY KEY CHECK (call_message_id ~ '^[A-Za-z0-9_-]{6,64}$'),
 call_event_id uuid NOT NULL,
 mode text NOT NULL CHECK (mode IN ('live','backfill')),
 outcome text NOT NULL CHECK (outcome IN ('pending','saved','not_returned','failed','not_expected')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
 next_at timestamptz,
 last_code text CHECK (last_code IS NULL OR last_code ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
 failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
 provider_status text CHECK (provider_status IS NULL OR length(provider_status)<=40),
 provider_duration_seconds numeric CHECK (provider_duration_seconds IS NULL OR provider_duration_seconds>=0),
 seen_sentences integer CHECK (seen_sentences IS NULL OR seen_sentences>=0),
 seen_digest text CHECK (seen_digest IS NULL OR seen_digest ~ '^[0-9a-f]{64}$'),
 seen_at timestamptz,
 transcript_event_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CONSTRAINT call_transcript_fetches_terminal CHECK ((outcome='pending')=(finished_at IS NULL)),
 CONSTRAINT call_transcript_fetches_pending_next CHECK (outcome<>'pending' OR next_at IS NOT NULL),
 CONSTRAINT call_transcript_fetches_failed_code CHECK ((outcome='failed')=(failure_code IS NOT NULL)),
 CONSTRAINT call_transcript_fetches_saved_event CHECK (outcome<>'saved' OR transcript_event_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS call_transcript_fetches_pending ON public.call_transcript_fetches (next_at) WHERE outcome='pending';
CREATE INDEX IF NOT EXISTS call_transcript_fetches_finished ON public.call_transcript_fetches (finished_at) WHERE outcome<>'pending';
ALTER TABLE public.call_transcript_fetches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.call_transcript_fetches FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.call_transcript_fetches TO service_role;
COMMENT ON TABLE public.call_transcript_fetches IS
 'One record per GHL call the transcript fetcher has tried (transcripts slice T2). Written only by record_call_transcript_fetch(). Codes and counts only, never words. Terminal records are purged after 30 days.';

-- 4. The one writer of call_transcript_fetches.
CREATE OR REPLACE FUNCTION public.record_call_transcript_fetch(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_transcript_capture_policy();
 now_time timestamptz:=clock_timestamp();
 msg text; ev uuid; md text; res text; code text; tx uuid; call_at timestamptz; call_key text; tx_key text;
 r public.call_transcript_fetches; existed boolean; steps jsonb:=policy->'backoff_minutes'; max_attempts integer;
 n_attempts integer; final_now boolean:=false; purged integer;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('call_message_id','call_event_id','mode','result','code',
   'provider_status','provider_duration_seconds','sentences','digest','transcript_event_id'))
 THEN RAISE EXCEPTION 'transcript_fetch_invalid'; END IF;
 msg:=p->>'call_message_id'; md:=coalesce(p->>'mode','live'); res:=p->>'result'; code:=nullif(p->>'code','');
 IF msg IS NULL OR msg !~ '^[A-Za-z0-9_-]{6,64}$' THEN RAISE EXCEPTION 'transcript_fetch_call_invalid'; END IF;
 IF md NOT IN ('live','backfill') THEN RAISE EXCEPTION 'transcript_fetch_mode_invalid'; END IF;
 IF res IS NULL OR res NOT IN ('saved','not_ready','awaiting_agreement','error','not_expected') THEN RAISE EXCEPTION 'transcript_fetch_result_invalid'; END IF;
 IF code IS NOT NULL AND code !~ '^[a-z0-9][a-z0-9_.:-]{0,79}$' THEN RAISE EXCEPTION 'transcript_fetch_code_invalid'; END IF;
 IF res IN ('error','not_expected') AND code IS NULL THEN RAISE EXCEPTION 'transcript_fetch_code_required'; END IF;
 BEGIN
  ev:=(p->>'call_event_id')::uuid; tx:=(p->>'transcript_event_id')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'transcript_fetch_invalid';
 END;
 call_key:='ghl:'||msg; tx_key:='ghltx:'||msg;
 -- The call row must be the stored call this key names.
 SELECT e.event_at INTO call_at FROM public.business_events e
 WHERE e.id=ev AND e.provider_message_id=call_key AND e.event_type=ANY(ARRAY(SELECT jsonb_array_elements_text(policy->'call_event_types')));
 IF NOT FOUND THEN RAISE EXCEPTION 'transcript_fetch_call_not_found'; END IF;
 IF res='saved' AND NOT EXISTS (SELECT 1 FROM public.business_events e WHERE e.id=tx AND e.provider_message_id=tx_key) THEN
  RAISE EXCEPTION 'transcript_fetch_transcript_not_found';
 END IF;
 IF res='awaiting_agreement' AND (jsonb_typeof(p->'sentences')<>'number' OR coalesce(p->>'digest','') !~ '^[0-9a-f]{64}$') THEN
  RAISE EXCEPTION 'transcript_fetch_invalid';
 END IF;

 SELECT * INTO r FROM public.call_transcript_fetches f WHERE f.call_message_id=msg FOR UPDATE;
 existed:=FOUND;
 IF existed AND r.outcome<>'pending' THEN
  RETURN jsonb_build_object('outcome','unchanged','state',r.outcome,'attempts',r.attempts);
 END IF;
 IF NOT existed THEN
  r.call_message_id:=msg; r.call_event_id:=ev; r.mode:=md; r.outcome:='pending'; r.attempts:=0; r.created_at:=now_time;
 END IF;
 r.updated_at:=now_time; r.last_code:=coalesce(code,res);
 IF p ? 'provider_status' THEN r.provider_status:=left(nullif(p->>'provider_status',''),40); END IF;
 IF jsonb_typeof(p->'provider_duration_seconds')='number' AND (p->>'provider_duration_seconds')::numeric>=0 THEN
  r.provider_duration_seconds:=(p->>'provider_duration_seconds')::numeric;
 END IF;
 -- Every wait is used: six waits, so the seventh failed read is terminal.
 max_attempts:=jsonb_array_length(steps)+1;

 IF res='saved' THEN
  r.outcome:='saved'; r.transcript_event_id:=tx; r.next_at:=NULL; r.finished_at:=now_time; r.last_code:='saved';
 ELSIF res='not_expected' THEN
  r.outcome:='not_expected'; r.next_at:=NULL; r.finished_at:=now_time;
 ELSIF res='awaiting_agreement' THEN
  -- Not an attempt: the words were returned, the rule waits for a second read.
  r.seen_sentences:=(p->>'sentences')::integer; r.seen_digest:=p->>'digest'; r.seen_at:=now_time;
  r.next_at:=now_time+make_interval(mins=>(policy->>'agreement_minutes')::integer);
 ELSE
  n_attempts:=r.attempts+1; r.attempts:=n_attempts;
  final_now:= res='not_ready' AND md='backfill'
   AND call_at < now_time-make_interval(hours=>(policy->>'backfill_final_after_hours')::integer);
  IF final_now OR n_attempts>=max_attempts THEN
   r.next_at:=NULL; r.finished_at:=now_time;
   IF res='not_ready' THEN r.outcome:='not_returned';
   ELSE r.outcome:='failed'; r.failure_code:=code; END IF;
  ELSE
   r.outcome:='pending';
   r.next_at:=now_time+make_interval(mins=>(steps->>(n_attempts-1))::integer);
  END IF;
 END IF;

 IF existed THEN
  UPDATE public.call_transcript_fetches f SET outcome=r.outcome,attempts=r.attempts,next_at=r.next_at,last_code=r.last_code,
   failure_code=r.failure_code,provider_status=r.provider_status,provider_duration_seconds=r.provider_duration_seconds,
   seen_sentences=r.seen_sentences,seen_digest=r.seen_digest,seen_at=r.seen_at,transcript_event_id=r.transcript_event_id,
   updated_at=r.updated_at,finished_at=r.finished_at
  WHERE f.call_message_id=msg;
 ELSE
  INSERT INTO public.call_transcript_fetches (call_message_id,call_event_id,mode,outcome,attempts,next_at,last_code,failure_code,
   provider_status,provider_duration_seconds,seen_sentences,seen_digest,seen_at,transcript_event_id,created_at,updated_at,finished_at)
  VALUES (r.call_message_id,r.call_event_id,r.mode,r.outcome,r.attempts,r.next_at,r.last_code,r.failure_code,
   r.provider_status,r.provider_duration_seconds,r.seen_sentences,r.seen_digest,r.seen_at,r.transcript_event_id,r.created_at,r.updated_at,r.finished_at);
 END IF;

 -- Purge old terminal records, a bounded batch per call.
 DELETE FROM public.call_transcript_fetches f WHERE f.call_message_id IN (
  SELECT o.call_message_id FROM public.call_transcript_fetches o
  WHERE o.outcome<>'pending' AND o.finished_at<now_time-make_interval(days=>(policy->>'purge_days')::integer)
  ORDER BY o.finished_at LIMIT 200);
 GET DIAGNOSTICS purged=ROW_COUNT;

 RETURN jsonb_build_object('outcome',CASE WHEN r.outcome='failed' THEN 'failed:'||r.failure_code ELSE r.outcome END,
  'state',r.outcome,'attempts',r.attempts,'next_at',r.next_at,'purged',purged);
END $$;
COMMENT ON FUNCTION public.record_call_transcript_fetch(jsonb) IS
 'The one writer of call_transcript_fetches (transcripts slice T2). result: saved | not_ready | awaiting_agreement | error | not_expected. Owns the backoff (waits of 2m, 5m, 15m, 1h, 6h, 24h; the read after the last wait that fails again is terminal not_returned or failed:<code>); a terminal record is never reopened. Refusal codes: transcript_fetch_invalid, _call_invalid, _mode_invalid, _result_invalid, _code_invalid, _code_required, _call_not_found, _transcript_not_found.';

-- 5. Eligibility from the stored call row.
CREATE OR REPLACE FUNCTION public.context_call_transcript_eligible(p_event_type text,p_provider_message_id text,p_payload jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT coalesce(p_provider_message_id,'') LIKE 'ghl:%' AND (
  lower(coalesce(p_payload->>'call_status',''))='voicemail'
  OR upper(coalesce(p_payload->>'ghl_message_type','')) IN ('TYPE_VOICEMAIL','VOICEMAIL')
  OR (lower(coalesce(p_payload->>'call_status',''))='completed'
      AND (jsonb_typeof(p_payload->'duration_seconds') IS DISTINCT FROM 'number'
           OR (p_payload->>'duration_seconds')::numeric>=5))
  OR (p_event_type='client.call_initiated' AND nullif(p_payload->>'call_status','') IS NULL))
$$;
COMMENT ON FUNCTION public.context_call_transcript_eligible(text,text,jsonb) IS
 'Whether a stored GHL call row is worth asking for a transcript (transcripts slice T2, review M1): completed and at least 5 s or with no duration recorded, or a voicemail; a tool-initiated call with no status yet is asked and the provider decides.';

-- 6. Calls due a fetch now.
CREATE OR REPLACE FUNCTION public.context_transcript_due_calls(p_limit integer DEFAULT 40)
RETURNS TABLE (call_event_id uuid, call_message_id text, event_type text, event_at timestamptz, contact_id text,
 conversation_key text, direction text, call_status text, duration_seconds numeric, call_sid text, line text,
 from_line text, by_user text, capture_mode text, transcript_event_id uuid, attempts integer,
 seen_sentences integer, seen_digest text, seen_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH policy AS (SELECT public.context_transcript_capture_policy() AS p),
 calls AS (
  SELECT e.*, substr(e.provider_message_id,5) AS msg
  FROM public.business_events e, policy
  WHERE e.event_type IN (SELECT jsonb_array_elements_text(policy.p->'call_event_types'))
   AND e.provider_message_id LIKE 'ghl:%'
   AND e.event_at > now()-make_interval(days=>(policy.p->>'window_days')::integer) AND e.event_at <= now()
 )
 SELECT c.id, c.msg, c.event_type, c.event_at, c.contact_id, c.conversation_key, c.direction,
  c.payload->>'call_status',
  CASE WHEN jsonb_typeof(c.payload->'duration_seconds')='number' THEN (c.payload->>'duration_seconds')::numeric END,
  c.payload->>'call_sid', c.payload->>'line', c.payload->>'from_line', c.payload->>'by_user',
  coalesce(c.metadata->>'capture_mode','live'), tx.id, coalesce(f.attempts,0), f.seen_sentences, f.seen_digest, f.seen_at
 FROM calls c
 LEFT JOIN public.call_transcript_fetches f ON f.call_message_id=c.msg
 LEFT JOIN public.business_events tx ON tx.provider_message_id='ghltx:'||c.msg
 WHERE c.msg ~ '^[A-Za-z0-9_-]{6,64}$'
  AND (f.call_message_id IS NULL OR (f.outcome='pending' AND f.next_at<=now()))
  AND (tx.id IS NOT NULL OR public.context_call_transcript_eligible(c.event_type,c.provider_message_id,c.payload))
 ORDER BY c.event_at, c.id
 LIMIT greatest(1,least(coalesce(p_limit,40),200))
$$;
COMMENT ON FUNCTION public.context_transcript_due_calls(integer) IS
 'Calls due a transcript fetch now (transcripts slice T2): GHL call rows of the last 14 days, eligible from their stored status and duration, with no terminal fetch record and the next try due, oldest first. A call whose transcript row already exists is included so the fetcher records it saved.';

-- 7. History load: the contacts of the jobs that are live now.
CREATE OR REPLACE FUNCTION public.context_transcript_backfill_contacts(p_after text DEFAULT NULL,p_limit integer DEFAULT 10)
RETURNS TABLE (ghl_contact_id text, job_ids uuid[], job_numbers text[], statuses text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH policy AS (SELECT public.context_transcript_capture_policy() AS p),
 live AS (
  SELECT j.id, j.job_number, j.status, btrim(j.ghl_contact_id) AS contact
  FROM public.jobs j, policy
  WHERE nullif(btrim(j.ghl_contact_id),'') IS NOT NULL
   AND (j.status IN (SELECT jsonb_array_elements_text(policy.p->'live_statuses'))
    OR (j.status IN (SELECT jsonb_array_elements_text(policy.p->'quoted_statuses'))
     AND (EXISTS (SELECT 1 FROM public.job_documents d WHERE d.job_id=j.id AND d.type='quote'
                   AND d.sent_at>now()-make_interval(days=>(policy.p->>'quote_sent_days')::integer))
       OR EXISTS (SELECT 1 FROM public.quote_revisions r WHERE r.job_id=j.id
                   AND r.sent_at>now()-make_interval(days=>(policy.p->>'quote_sent_days')::integer)))))
 )
 SELECT l.contact, array_agg(l.id ORDER BY l.job_number), array_agg(l.job_number ORDER BY l.job_number),
  array_agg(DISTINCT l.status)
 FROM live l
 WHERE l.contact ~ '^[A-Za-z0-9_-]{6,64}$' AND (p_after IS NULL OR l.contact COLLATE "C" > p_after COLLATE "C")
 GROUP BY l.contact
 ORDER BY l.contact COLLATE "C"
 LIMIT greatest(1,least(coalesce(p_limit,10),50))
$$;
COMMENT ON FUNCTION public.context_transcript_backfill_contacts(text,integer) IS
 'History load (transcripts slice T2, owner 24 Sep 2026): GHL contacts of the jobs that are live now (live statuses of the policy, or draft or quoted with a quote sent in the last 60 days), contact ids ascending, after p_after.';

-- 8. The transcript_capture status block.
CREATE OR REPLACE FUNCTION public.context_transcript_capture_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_transcript_capture_policy();
 now_time timestamptz:=now();
 flag jsonb:=public.context_transcript_fetch_flag();
 flag_on boolean:=(flag->>'enabled')::boolean;
 flag_since timestamptz:=(flag->>'updated_at')::timestamptz;
 lane_on boolean:=public.automation_lane_enabled('capture');
 call_types text[]:=ARRAY(SELECT jsonb_array_elements_text(policy->'call_event_types'));
 window_start timestamptz:=now_time-make_interval(days=>(policy->>'window_days')::integer);
 last_run jsonb; last_run_at timestamptz; last_success timestamptz; runs jsonb; backfill_last jsonb;
 attempts_24h bigint; errors_24h bigint;
 due integer; unfetched integer; pending integer; oldest_pending timestamptz;
 outcomes_24h jsonb; failed_by_code jsonb; saved_24h jsonb; last_saved timestamptz;
 cov_total integer; cov_saved integer; cov_by_line jsonb; aged_out integer;
 alarms jsonb:='[]'::jsonb; since timestamptz; quiet integer;
BEGIN
 -- Runs (context_capture_runs, written only through record_capture_run).
 SELECT jsonb_build_object('run_id',c.id,'status',c.status,'started_at',c.started_at,'finished_at',c.finished_at,
   'error_code',c.error_code,'counts',c.counts), c.started_at
 INTO last_run,last_run_at FROM public.context_capture_runs c WHERE c.source=policy->>'run_source' ORDER BY c.started_at DESC LIMIT 1;
 SELECT max(c.finished_at) INTO last_success FROM public.context_capture_runs c
 WHERE c.source=policy->>'run_source' AND c.status IN ('succeeded','partial');
 SELECT coalesce(jsonb_object_agg(s.status,s.n),'{}'::jsonb) INTO runs FROM (
  SELECT c.status,count(*) n FROM public.context_capture_runs c
  WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours' GROUP BY c.status) s;
 SELECT coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'attempts')='number' THEN (c.counts->>'attempts')::bigint ELSE 0 END),0),
  coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'errors')='number' THEN (c.counts->>'errors')::bigint ELSE 0 END),0)
 INTO attempts_24h,errors_24h FROM public.context_capture_runs c
 WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours';
 SELECT jsonb_build_object('run_id',c.id,'status',c.status,'started_at',c.started_at,'finished_at',c.finished_at,
   'error_code',c.error_code,'counts',c.counts)
 INTO backfill_last FROM public.context_capture_runs c WHERE c.source=policy->>'backfill_run_source' ORDER BY c.started_at DESC LIMIT 1;

 -- Calls in the selection window, their transcripts and fetch records.
 WITH calls AS (
  SELECT e.event_at, e.payload->>'from_line' AS from_line, substr(e.provider_message_id,5) AS msg,
   public.context_call_transcript_eligible(e.event_type,e.provider_message_id,e.payload) AS eligible
  FROM public.business_events e
  WHERE e.event_type=ANY(call_types) AND e.provider_message_id LIKE 'ghl:%'
   AND e.event_at>window_start-interval '1 day' AND e.event_at<=now_time
 ), joined AS (
  SELECT c.*, f.outcome, f.next_at,
   EXISTS (SELECT 1 FROM public.business_events t WHERE t.provider_message_id='ghltx:'||c.msg) AS has_tx
  FROM calls c LEFT JOIN public.call_transcript_fetches f ON f.call_message_id=c.msg
 )
 SELECT
  count(*) FILTER (WHERE j.event_at>window_start AND j.eligible AND NOT j.has_tx AND (j.outcome IS NULL OR (j.outcome='pending' AND j.next_at<=now_time))),
  count(*) FILTER (WHERE j.event_at>window_start AND j.eligible AND NOT j.has_tx AND j.outcome IS NULL),
  count(*) FILTER (WHERE j.event_at>window_start AND NOT j.has_tx AND j.outcome='pending'),
  min(j.event_at) FILTER (WHERE j.event_at>window_start AND j.eligible AND NOT j.has_tx AND (j.outcome IS NULL OR j.outcome='pending')),
  count(*) FILTER (WHERE j.eligible AND j.event_at>now_time-make_interval(hours=>(policy->>'coverage_from_hours')::integer)
   AND j.event_at<=now_time-make_interval(hours=>(policy->>'coverage_to_hours')::integer)),
  count(*) FILTER (WHERE j.eligible AND j.has_tx AND j.event_at>now_time-make_interval(hours=>(policy->>'coverage_from_hours')::integer)
   AND j.event_at<=now_time-make_interval(hours=>(policy->>'coverage_to_hours')::integer)),
  count(*) FILTER (WHERE j.eligible AND NOT j.has_tx AND (j.outcome IS NULL OR j.outcome='pending')
   AND j.event_at<=window_start AND j.event_at>window_start-interval '1 day')
 INTO due,unfetched,pending,oldest_pending,cov_total,cov_saved,aged_out FROM joined j;

 SELECT coalesce(jsonb_object_agg(coalesce(x.from_line,'unknown'),jsonb_build_object('eligible',x.n,'with_transcript',x.s)),'{}'::jsonb)
 INTO cov_by_line FROM (
  SELECT e.payload->>'from_line' AS from_line, count(*) n,
   count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.business_events t WHERE t.provider_message_id='ghltx:'||substr(e.provider_message_id,5))) s
  FROM public.business_events e
  WHERE e.event_type=ANY(call_types) AND e.provider_message_id LIKE 'ghl:%'
   AND e.event_at>now_time-make_interval(hours=>(policy->>'coverage_from_hours')::integer)
   AND e.event_at<=now_time-make_interval(hours=>(policy->>'coverage_to_hours')::integer)
   AND public.context_call_transcript_eligible(e.event_type,e.provider_message_id,e.payload)
  GROUP BY 1) x;

 -- Fetch outcomes finished in the last 24 hours.
 SELECT coalesce(jsonb_object_agg(o.outcome,o.n),'{}'::jsonb) INTO outcomes_24h FROM (
  SELECT f.outcome,count(*) n FROM public.call_transcript_fetches f
  WHERE f.outcome<>'pending' AND f.finished_at>now_time-interval '24 hours' GROUP BY 1) o;
 SELECT coalesce(jsonb_object_agg(o.failure_code,o.n),'{}'::jsonb) INTO failed_by_code FROM (
  SELECT f.failure_code,count(*) n FROM public.call_transcript_fetches f
  WHERE f.outcome='failed' AND f.finished_at>now_time-interval '24 hours' GROUP BY 1) o;

 -- Transcript rows saved (the evidence itself), by capture mode.
 SELECT coalesce(jsonb_object_agg(s.mode,s.n),'{}'::jsonb) INTO saved_24h FROM (
  SELECT coalesce(t.metadata->>'capture_mode','live') AS mode,count(*) n FROM public.business_events t
  WHERE t.provider_message_id LIKE 'ghltx:%' AND t.source=policy->>'event_source' AND t.occurred_at>now_time-interval '24 hours'
  GROUP BY 1) s;
 SELECT max(f.finished_at) INTO last_saved FROM public.call_transcript_fetches f WHERE f.outcome='saved';

 -- Alarms: meaningful only while transcripts are being fetched.
 IF lane_on AND flag_on THEN
  since:=coalesce(last_run_at,flag_since);
  IF since IS NOT NULL AND now_time-since>make_interval(mins=>(policy->>'stale_minutes')::integer) THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','transcript_fetch_stale','severity','warning','since',since,
    'last_run_status',last_run->>'status','last_run_error',last_run->>'error_code',
    'what_to_do','The 5-minute call transcript fetcher has not run for 20 minutes. Check the ghl-call-transcript-fetch cron job and edge function logs, and the capture lane.'));
  END IF;
  quiet:=public.context_business_minutes(coalesce(last_saved,flag_since),now_time);
  IF (due>0 AND coalesce(last_saved,flag_since) IS NOT NULL AND quiet>=(policy->>'failing_business_minutes')::integer)
   OR (attempts_24h>=(policy->>'failing_min_attempts')::integer AND errors_24h>(policy->>'failing_error_ratio')::numeric*attempts_24h) THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','transcript_fetch_failing','severity','warning',
    'since',coalesce(last_saved,flag_since),'due',due,'attempts_24h',attempts_24h,'errors_24h',errors_24h,'failed_by_code_24h',failed_by_code,
    'what_to_do','Call transcripts are due but none has been saved for 2 business hours, or more than 1 in 5 reads failed in 24 hours. Check the failure codes, the GHL token and GHL''s transcription setting.'));
  END IF;
  IF cov_total>=(policy->>'coverage_min_eligible')::integer AND cov_saved<(policy->>'coverage_min_ratio')::numeric*cov_total THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','transcript_coverage_low','severity','warning','since',now_time-interval '26 hours',
    'eligible',cov_total,'with_transcript',cov_saved,'by_line',cov_by_line,
    'what_to_do','Fewer than 60% of answered calls from the last day have a transcript. Check by line whether GHL recording and transcription are on.'));
  END IF;
  IF aged_out>0 THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','transcript_aged_out','severity','warning','since',window_start-interval '1 day',
    'aged_out_unfetched_24h',aged_out,
    'what_to_do','Calls passed the 14-day fetch window without a transcript attempt finishing. The history load can still fetch them; check why the fetcher fell behind.'));
  END IF;
 END IF;

 RETURN jsonb_build_object(
  'as_of',now_time,'policy',policy,'fetch_flag',flag,'capture_lane',lane_on,
  'fetcher',jsonb_build_object('last_run',last_run,'last_success_at',last_success,'runs_24h',runs,
   'attempts_24h',attempts_24h,'errors_24h',errors_24h),
  'backfill',jsonb_build_object('last_run',backfill_last),
  'calls',jsonb_build_object('due_now',coalesce(due,0),'never_tried',coalesce(unfetched,0),'pending',coalesce(pending,0),
   'oldest_pending_at',oldest_pending,'aged_out_unfetched_24h',coalesce(aged_out,0)),
  'outcomes_24h',outcomes_24h,'failed_by_code_24h',failed_by_code,'saved_rows_24h',saved_24h,'last_saved_at',last_saved,
  'coverage_24h',jsonb_build_object('eligible',coalesce(cov_total,0),'with_transcript',coalesce(cov_saved,0),'by_line',cov_by_line),
  -- A transcript placed on a different job from a direct tool call is the
  -- placement slice's count (P-T).
  'not_measured',jsonb_build_array('call_transcript_split'),
  'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_transcript_capture_status() IS
 'Status block transcript_capture (transcripts slice T2): fetch flag, capture lane, the fetcher''s runs, calls due and pending, outcomes, coverage by line, aged-out calls, and the alarms transcript_fetch_stale, transcript_fetch_failing, transcript_coverage_low, transcript_aged_out. Counts and codes only, never words.';

-- 9. The cron caller. Idle while the fetch flag is off: no HTTP call at all.
CREATE OR REPLACE FUNCTION public.trigger_ghl_call_transcript_fetch() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT (public.context_transcript_fetch_flag()->>'enabled')::boolean THEN
  RETURN;
 END IF;
 PERFORM net.http_post(
  url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-call-transcript-fetch',
  body := jsonb_build_object('actor','cron:ghl-call-transcript-fetch'),
  headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
  timeout_milliseconds := 5000
 );
END $$;
COMMENT ON FUNCTION public.trigger_ghl_call_transcript_fetch() IS
 'pg_cron ghl-call-transcript-fetch (every 5 minutes, capture lane): posts to the ghl-call-transcript-fetch edge function with the service key while feature flag ghl_call_transcript_fetch_v1 is on. Owned by transcripts slice T2.';

-- 10. The capture lane owns the new job. The C1d body plus one row.
CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    ('ghl-message-reconcile', 'capture'),
    ('ghl-call-transcript-fetch', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;

-- Scheduled already gated, so the switch's wrap reports already_wrapped and its
-- unwrap can remove the suffix. Skipped where pg_cron is absent (contract runner).
DO $cron$
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'ghl-call-transcript-fetch: pg_cron absent, not scheduled';
  RETURN;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='ghl-call-transcript-fetch') THEN
  PERFORM cron.schedule('ghl-call-transcript-fetch','1-59/5 * * * *',
   $cmd$SELECT public.trigger_ghl_call_transcript_fetch() WHERE public.automation_lane_enabled('capture')$cmd$);
 END IF;
END $cron$;

-- 11. Grants. Service-side only.
REVOKE ALL ON FUNCTION public.context_transcript_capture_policy(),public.context_transcript_fetch_flag(),
 public.record_call_transcript_fetch(jsonb),public.context_call_transcript_eligible(text,text,jsonb),
 public.context_transcript_due_calls(integer),public.context_transcript_backfill_contacts(text,integer),
 public.context_transcript_capture_status(),public.trigger_ghl_call_transcript_fetch() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_transcript_capture_policy(),public.context_transcript_fetch_flag(),
 public.record_call_transcript_fetch(jsonb),public.context_call_transcript_eligible(text,text,jsonb),
 public.context_transcript_due_calls(integer),public.context_transcript_backfill_contacts(text,integer),
 public.context_transcript_capture_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_ghl_call_transcript_fetch() TO postgres;
REVOKE ALL ON FUNCTION public.automation_switch_cron_lanes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_switch_cron_lanes() TO service_role, postgres;
