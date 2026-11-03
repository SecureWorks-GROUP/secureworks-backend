-- The document text reader stopped closing runs (finish line C1, CIO 3 Nov 2026 18:25Z).
--
-- Why: from 30 Oct 2026 18:07Z every run of context-document-text stopped its worker on one document
-- (email attachment 2612d4d2, a PDF pdf.js cannot open): the extractor's fallback left a rejected
-- DecompressionStream write unhandled and Deno ended the worker ("event loop error: TypeError: corrupt
-- deflate stream"), 87 times in the 24 hours to 3 Nov 18:35Z. The document was never recorded, so every
-- run took it again; the six documents behind it were never read; no run row closed (360 left running);
-- and document_text_stale, measured from the last run's START, never fired because a run started every
-- 20 minutes. The extractor fix is in ops-api/makesafe_pdf_text.ts; this is the database half.
--
-- What it does:
--  1. record_context_document_text(jsonb): the reader now records a mark (result error, code
--     read_started) before it downloads and reads any PDF. The mark counts as one attempt with the
--     usual backoff (15 min, 1 h, 6 h, 24 h), so a file that stops the worker ends failed:read_started
--     after 5 tries. The next write from the same read (same fingerprint, the record still that mark)
--     completes that attempt: it is not counted again, and it replaces a mark that ended the record
--     failed. So a read that finishes keeps exactly the attempts, outcome, next try and codes it had
--     before. large_read_started (the 20261104130000 reader's mark over 5 MB) is treated the same.
--  2. context_document_text_status(): document_text_stale is measured from the last run the reader
--     itself finished (succeeded or partial), not from the last run's start. The reader block and the
--     alarm also give last_completed_at and unfinished_runs_24h (runs still running after 10 minutes,
--     or closed as stale, in 24 hours). Every other number and the failing alarm are unchanged.
--  3. close_stale_context_document_text_runs(): closes, as failed:run_stale, every run of this reader
--     still running 10 minutes after it started (the edge function's own stale window). The reader
--     calls it at the start of each run, so every run row ends closed.
--
-- No flag, switch, schedule, policy, grant for anon or authenticated, or row is written by this file.
-- The edge function context-document-text writes the mark and calls the closer; deployed before this
-- migration it would count a mark and its outcome as two attempts (the 20261104130000 behaviour for
-- large reads) and skip the closing, never more.
--
-- Replaces two functions, guarded on their live bodies (md5 of prosrc, read from production 3 Nov 2026
-- 18:32Z after 20261104130000): record_context_document_text(jsonb) c09711fa...,
-- context_document_text_status() 69cafa27.... Reads, never replaces: context_document_text_policy()
-- e672da9e... (run_source, backoff_minutes, stale_minutes) and context_capture_runs (F1b). Adds
-- close_stale_context_document_text_runs(). The guard refuses unless each is that pre-image or
-- already this file's result (a re-apply changes nothing).
--
-- Rollback: supabase/rollbacks/20261104183000_context_document_text_stuck_read_down.sql (restores both
-- bodies and comments byte for byte, drops the closer). Runs already closed as run_stale stay closed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record; cols text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.record_context_document_text(jsonb)',ARRAY['c09711fa2928f366daecb41deed7e3ed','8b3b8652a2d01cbf8cdd17c7971fa70d']),
  ('public.context_document_text_status()',ARRAY['69cafa2747e11a63c10179195054865a','c787cf5a1a55d3710022e8b8bd2acb20']),
  -- Read, never replaced: the run source, the backoff and stale_minutes come from it.
  ('public.context_document_text_policy()',ARRAY['e672da9e885bfbaeef5007c0cd756060'])
 ) AS t(sig,accepted) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 live:=NULL;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.close_stale_context_document_text_runs()');
 IF live IS NOT NULL AND live<>'dfe414d8315c801aa52429df95e57fa2' THEN problems:=problems||format('public.close_stale_context_document_text_runs() exists with md5 %s',live); END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
   AND p.proname='close_stale_context_document_text_runs' AND p.oid<>coalesce(to_regprocedure('public.close_stale_context_document_text_runs()'),0))
 THEN problems:=problems||'another overload of close_stale_context_document_text_runs exists'::text; END IF;
 -- The run rows, as F1b made them: closing one sets status, error_code, finished_at and updated_at.
 IF to_regclass('public.context_capture_runs') IS NULL THEN problems:=problems||'context_capture_runs missing'::text;
 ELSE
  SELECT string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attname) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.context_capture_runs'::regclass AND a.attnum>0 AND NOT a.attisdropped
   AND a.attname IN ('id','source','status','started_at','updated_at','finished_at','error_code','counts');
  IF cols IS DISTINCT FROM 'counts:jsonb,error_code:text,finished_at:timestamp with time zone,id:uuid,source:text,started_at:timestamp with time zone,status:text,updated_at:timestamp with time zone'
  THEN problems:=problems||format('context_capture_runs has columns %s',cols); END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_capture_runs'::regclass AND conname='context_capture_runs_finished')
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.context_capture_runs'::regclass AND conname='context_capture_runs_failed_code')
  THEN problems:=problems||'context_capture_runs lacks its finished or failed_code check'::text; END IF;
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_document_text_stuck_read_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The one writer of context_document_texts: the 20261104130000 body, with the read mark.
CREATE OR REPLACE FUNCTION public.record_context_document_text(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_text_policy();
 now_time timestamptz:=clock_timestamp();
 kind text; src uuid; job uuid; fp text; fk text; res text; code text; sha text; ev uuid;
 r public.context_document_texts; existed boolean; reopened boolean:=false;
 steps jsonb:=policy->'backoff_minutes'; max_attempts integer; n_attempts integer; completing boolean:=false;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('source_kind','source_id','job_id','fingerprint','file_kind',
   'result','code','sha256','page_count','char_count','truncated','event_id'))
 THEN RAISE EXCEPTION 'document_text_invalid'; END IF;
 kind:=p->>'source_kind'; fp:=p->>'fingerprint'; fk:=p->>'file_kind'; res:=p->>'result'; code:=nullif(p->>'code',''); sha:=nullif(p->>'sha256','');
 IF kind IS NULL OR kind NOT IN ('job_document','email_attachment') THEN RAISE EXCEPTION 'document_text_source_invalid'; END IF;
 IF fp IS NULL OR fp !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'document_text_fingerprint_invalid'; END IF;
 IF fk IS NULL OR fk NOT IN ('pdf','image','other') THEN RAISE EXCEPTION 'document_text_file_kind_invalid'; END IF;
 IF res IS NULL OR res NOT IN ('saved','no_text_layer','not_supported','too_large','too_many_pages','unreadable','no_file','error')
 THEN RAISE EXCEPTION 'document_text_result_invalid'; END IF;
 IF code IS NOT NULL AND code !~ '^[a-z0-9][a-z0-9_.:-]{0,79}$' THEN RAISE EXCEPTION 'document_text_code_invalid'; END IF;
 IF res='error' AND code IS NULL THEN RAISE EXCEPTION 'document_text_code_required'; END IF;
 IF sha IS NOT NULL AND sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'document_text_sha256_invalid'; END IF;
 BEGIN
  src:=(p->>'source_id')::uuid; job:=(p->>'job_id')::uuid; ev:=(p->>'event_id')::uuid;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'document_text_invalid';
 END;
 IF src IS NULL THEN RAISE EXCEPTION 'document_text_invalid'; END IF;
 IF job IS NULL THEN
  -- Requests (20261104130000): only an email attachment a request names, whose email is on no job,
  -- is read on no job.
  IF kind<>'email_attachment' OR NOT EXISTS(SELECT 1 FROM public.context_document_text_requests q
    JOIN public.context_email_attachments a ON a.id=q.source_id
    JOIN public.business_events e ON e.id=a.business_event_id
    WHERE q.source_kind='email_attachment' AND q.source_id=src AND e.job_id IS NULL) THEN
   RAISE EXCEPTION 'document_text_source_not_found';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=job) THEN RAISE EXCEPTION 'document_text_job_not_found'; END IF;
  -- The source must be this job's document.
  IF kind='job_document' AND NOT EXISTS(SELECT 1 FROM public.job_documents d WHERE d.id=src AND d.job_id=job) THEN
   RAISE EXCEPTION 'document_text_source_not_found';
  END IF;
  IF kind='email_attachment' AND NOT EXISTS(SELECT 1 FROM public.context_email_attachments a
    JOIN public.business_events e ON e.id=a.business_event_id WHERE a.id=src AND e.job_id=job) THEN
   RAISE EXCEPTION 'document_text_source_not_found';
  END IF;
 END IF;
 -- A saved read names the evidence row it saved: doctext:<job>:<sha256>, or doctext:no_job:<sha256>
 -- on no job (and that row is on no job).
 IF res='saved' THEN
  IF sha IS NULL OR ev IS NULL THEN RAISE EXCEPTION 'document_text_invalid'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.business_events e WHERE e.id=ev
    AND e.provider_message_id=(policy->>'key_prefix')||coalesce(job::text,policy->>'no_job_key')||':'||sha
    AND (job IS NOT NULL OR e.job_id IS NULL)) THEN
   RAISE EXCEPTION 'document_text_event_not_found';
  END IF;
 END IF;

 SELECT * INTO r FROM public.context_document_texts t WHERE t.source_kind=kind AND t.source_id=src AND t.job_id IS NOT DISTINCT FROM job FOR UPDATE;
 existed:=FOUND;
 -- A read mark (20261104183000): the reader records result error, code read_started, before it downloads
 -- and reads a PDF, so a file that stops the worker backs off and ends failed:read_started. The next
 -- write from the same read completes that one attempt: it is not counted again, and it replaces a mark
 -- that ended the record failed. large_read_started is the 20261104130000 reader's mark (over 5 MB).
 completing:=existed AND r.source_fingerprint=fp AND r.last_code IN ('read_started','large_read_started')
  AND (r.outcome='pending' OR (r.outcome='failed' AND r.failure_code=r.last_code))
  AND NOT (res='error' AND code IN ('read_started','large_read_started'));
 IF existed AND r.outcome<>'pending' AND NOT completing THEN
  IF r.source_fingerprint=fp THEN
   RETURN jsonb_build_object('outcome','unchanged','state',r.outcome,'attempts',r.attempts);
  END IF;
  -- The document changed since its terminal outcome: a fresh read.
  reopened:=true;
  r.attempts:=0; r.failure_code:=NULL; r.sha256:=NULL; r.page_count:=NULL; r.char_count:=NULL; r.truncated:=NULL; r.event_id:=NULL;
 END IF;
 IF NOT existed THEN
  r.id:=gen_random_uuid(); r.source_kind:=kind; r.source_id:=src; r.job_id:=job; r.attempts:=0; r.created_at:=now_time;
 END IF;
 r.source_fingerprint:=fp; r.file_kind:=fk; r.updated_at:=now_time; r.last_code:=coalesce(code,res);
 IF sha IS NOT NULL THEN r.sha256:=sha; END IF;
 IF jsonb_typeof(p->'page_count')='number' AND (p->>'page_count')::numeric>=0 THEN r.page_count:=(p->>'page_count')::integer; END IF;
 IF jsonb_typeof(p->'char_count')='number' AND (p->>'char_count')::numeric>=0 THEN r.char_count:=(p->>'char_count')::integer; END IF;
 IF jsonb_typeof(p->'truncated')='boolean' THEN r.truncated:=(p->>'truncated')::boolean; END IF;
 max_attempts:=jsonb_array_length(steps)+1;

 IF res='error' THEN
  n_attempts:=r.attempts+CASE WHEN completing THEN 0 ELSE 1 END; r.attempts:=n_attempts;
  IF n_attempts>=max_attempts THEN
   r.outcome:='failed'; r.failure_code:=code; r.next_at:=NULL; r.finished_at:=now_time;
  ELSE
   r.outcome:='pending'; r.finished_at:=NULL;
   r.next_at:=now_time+make_interval(mins=>(steps->>(n_attempts-1))::integer);
  END IF;
 ELSE
  r.attempts:=r.attempts+CASE WHEN completing THEN 0 ELSE 1 END; r.outcome:=res; r.next_at:=NULL; r.finished_at:=now_time; r.failure_code:=NULL;
  r.event_id:=CASE WHEN res='saved' THEN ev END;
 END IF;

 IF existed THEN
  UPDATE public.context_document_texts t SET source_fingerprint=r.source_fingerprint,file_kind=r.file_kind,outcome=r.outcome,
   attempts=r.attempts,next_at=r.next_at,last_code=r.last_code,failure_code=r.failure_code,sha256=r.sha256,page_count=r.page_count,
   char_count=r.char_count,truncated=r.truncated,event_id=r.event_id,updated_at=r.updated_at,finished_at=r.finished_at
  WHERE t.id=r.id;
 ELSE
  INSERT INTO public.context_document_texts (id,source_kind,source_id,job_id,source_fingerprint,file_kind,outcome,attempts,next_at,
   last_code,failure_code,sha256,page_count,char_count,truncated,event_id,created_at,updated_at,finished_at)
  VALUES (r.id,r.source_kind,r.source_id,r.job_id,r.source_fingerprint,r.file_kind,r.outcome,r.attempts,r.next_at,
   r.last_code,r.failure_code,r.sha256,r.page_count,r.char_count,r.truncated,r.event_id,r.created_at,r.updated_at,r.finished_at);
 END IF;

 RETURN jsonb_build_object('outcome',CASE WHEN r.outcome='failed' THEN 'failed:'||r.failure_code ELSE r.outcome END,
  'state',r.outcome,'attempts',r.attempts,'next_at',r.next_at,'reopened',reopened);
END $$;
COMMENT ON FUNCTION public.record_context_document_text(jsonb) IS
 'The one writer of context_document_texts (gap plan B-5). result: saved | no_text_layer | not_supported | too_large | too_many_pages | unreadable | no_file | error. Owns the backoff (waits of 15m, 1h, 6h, 24h; the read after the last wait that fails again is terminal failed:<code>); every other result is terminal at once; a terminal record reopens only when the document''s fingerprint changed. Requests (20261104130000): job_id may be NULL only for an email attachment named in context_document_text_requests whose email is on no job; its saved evidence row is doctext:no_job:<sha256> and carries no job. A read mark (20261104183000): result error with code read_started (or large_read_started) counts as one attempt and the next write from the same read completes it without counting again, so a file that stops the worker ends failed:read_started after the usual tries and every other read keeps its attempts. Refusal codes: document_text_invalid, _source_invalid, _fingerprint_invalid, _file_kind_invalid, _result_invalid, _code_invalid, _code_required, _sha256_invalid, _job_not_found, _source_not_found, _event_not_found.';

-- 2. The status block: the 20261104130000 body, with the stale alarm measured from the last run the reader finished.
CREATE OR REPLACE FUNCTION public.context_document_text_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_document_text_policy();
 now_time timestamptz:=now();
 flag jsonb:=public.context_document_text_flag();
 flag_on boolean:=(flag->>'enabled')::boolean;
 lane_on boolean:=public.automation_lane_enabled('capture');
 last_run jsonb; last_run_at timestamptz; runs jsonb; attempts_24h bigint; errors_24h bigint;
 docs jsonb; due integer; alarms jsonb:='[]'::jsonb; since timestamptz; last_done_at timestamptz; unfinished_24h bigint;
BEGIN
 SELECT jsonb_build_object('run_id',c.id,'status',c.status,'started_at',c.started_at,'finished_at',c.finished_at,
   'error_code',c.error_code,'counts',c.counts), c.started_at
 INTO last_run,last_run_at FROM public.context_capture_runs c WHERE c.source=policy->>'run_source' ORDER BY c.started_at DESC LIMIT 1;
 SELECT coalesce(jsonb_object_agg(s.status,s.n),'{}'::jsonb) INTO runs FROM (
  SELECT c.status,count(*) n FROM public.context_capture_runs c
  WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours' GROUP BY c.status) s;
 SELECT coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'selected')='number' THEN (c.counts->>'selected')::bigint ELSE 0 END),0),
  coalesce(sum(CASE WHEN jsonb_typeof(c.counts->'errors')='number' THEN (c.counts->>'errors')::bigint ELSE 0 END),0)
 INTO attempts_24h,errors_24h FROM public.context_capture_runs c
 WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours';
 -- A run is done only when the reader itself closed it (succeeded or partial). A run that starts and
 -- never finishes, or that the next run closed as stale (failed:run_stale), is not (20261104183000:
 -- from 30 Oct to 3 Nov 2026 a run started every 20 minutes and none finished, so the old rule, the
 -- last run's start, never raised the alarm).
 SELECT max(c.finished_at) INTO last_done_at FROM public.context_capture_runs c
 WHERE c.source=policy->>'run_source' AND c.status IN ('succeeded','partial');
 SELECT count(*) INTO unfinished_24h FROM public.context_capture_runs c
 WHERE c.source=policy->>'run_source' AND c.started_at>now_time-interval '24 hours'
  AND ((c.status='running' AND c.started_at<now_time-interval '10 minutes') OR (c.status='failed' AND c.error_code='run_stale'));

 WITH j AS (
  SELECT s.*, t.outcome, t.file_kind, t.next_at, t.source_fingerprint
  FROM public.context_document_text_sources() s
  LEFT JOIN public.context_document_texts t ON t.source_kind=s.source_kind AND t.source_id=s.source_id AND t.job_id IS NOT DISTINCT FROM s.job_id
 )
 SELECT jsonb_build_object(
  'total',count(*),
  'jobs',count(DISTINCT j.job_id),
  'with_text',count(*) FILTER (WHERE j.outcome='saved' AND j.source_fingerprint=j.fingerprint),
  'no_text_layer',count(*) FILTER (WHERE j.outcome='no_text_layer' AND j.source_fingerprint=j.fingerprint),
  'no_text_layer_pdf',count(*) FILTER (WHERE j.outcome='no_text_layer' AND j.file_kind='pdf' AND j.source_fingerprint=j.fingerprint),
  'no_text_layer_image',count(*) FILTER (WHERE j.outcome='no_text_layer' AND j.file_kind='image' AND j.source_fingerprint=j.fingerprint),
  'not_supported',count(*) FILTER (WHERE j.outcome='not_supported' AND j.source_fingerprint=j.fingerprint),
  'too_large',count(*) FILTER (WHERE j.outcome='too_large' AND j.source_fingerprint=j.fingerprint),
  'too_many_pages',count(*) FILTER (WHERE j.outcome='too_many_pages' AND j.source_fingerprint=j.fingerprint),
  'unreadable',count(*) FILTER (WHERE j.outcome='unreadable' AND j.source_fingerprint=j.fingerprint),
  'no_file',count(*) FILTER (WHERE j.outcome='no_file' AND j.source_fingerprint=j.fingerprint),
  'failed',count(*) FILTER (WHERE j.outcome='failed' AND j.source_fingerprint=j.fingerprint),
  'pending',count(*) FILTER (WHERE j.outcome='pending'),
  'never_tried',count(*) FILTER (WHERE j.outcome IS NULL),
  'changed_since_read',count(*) FILTER (WHERE j.outcome IS NOT NULL AND j.outcome<>'pending' AND j.source_fingerprint<>j.fingerprint)),
  count(*) FILTER (WHERE j.outcome IS NULL OR (j.outcome='pending' AND j.next_at<=now_time)
   OR (j.outcome<>'pending' AND j.source_fingerprint<>j.fingerprint))::integer
 INTO docs,due FROM j;

 IF lane_on AND flag_on THEN
  since:=coalesce(last_done_at,(flag->>'updated_at')::timestamptz);
  IF due>0 AND since IS NOT NULL AND now_time-since>make_interval(mins=>(policy->>'stale_minutes')::integer) THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','document_text_stale','severity','warning','since',since,'due',due,
    'last_run_status',last_run->>'status','last_run_error',last_run->>'error_code',
    'last_completed_at',last_done_at,'unfinished_runs_24h',unfinished_24h,
    'what_to_do','Documents are waiting for a text read but no run of the 10-minute reader has finished for 30 minutes (a run that starts and never finishes counts as not run). Check the context-document-text edge function logs for a worker that stops, the cron job, and the capture lane.'));
  END IF;
  IF attempts_24h>=(policy->>'failing_min_attempts')::integer AND errors_24h>(policy->>'failing_error_ratio')::numeric*attempts_24h THEN
   alarms:=alarms||jsonb_build_array(jsonb_build_object('key','document_text_failing','severity','warning','since',now_time-interval '24 hours',
    'attempts_24h',attempts_24h,'errors_24h',errors_24h,
    'what_to_do','More than 1 in 5 document reads failed in 24 hours. Check the failure codes in context_document_texts and the storage buckets.'));
  END IF;
 END IF;

 RETURN jsonb_build_object('as_of',now_time,'policy',policy,'flag',flag,'capture_lane',lane_on,
  'reader',jsonb_build_object('last_run',last_run,'runs_24h',runs,'selected_24h',attempts_24h,'errors_24h',errors_24h,
   'last_completed_at',last_done_at,'unfinished_runs_24h',unfinished_24h),
  'documents',docs,'due_now',coalesce(due,0),'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_document_text_status() IS
 'Document text status (gap plan B-5): for every document on a live job, how many carry their text as evidence, how many have no text layer (pdf and image, for the vision reader B-5b), the other outcomes, pending and never tried; the reader''s runs, the last run the reader finished and the runs left unfinished in 24 hours; the alarms document_text_stale (documents due and no run finished for stale_minutes; a run that starts and never finishes does not count, 20261104183000) and document_text_failing. Counts and codes only, never words.';

-- 3. Close this reader's runs left running.
CREATE OR REPLACE FUNCTION public.close_stale_context_document_text_runs() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 src text:=public.context_document_text_policy()->>'run_source';
 now_time timestamptz:=clock_timestamp();
 n integer;
BEGIN
 -- The edge function's own stale window (LIMITS.runningStaleMs, 10 minutes): a run of this reader
 -- still running after it is one whose worker stopped.
 UPDATE public.context_capture_runs c SET status='failed',error_code='run_stale',finished_at=now_time,updated_at=now_time
 WHERE c.source=src AND c.status='running' AND c.started_at<now_time-interval '10 minutes';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('closed',n,'source',src,'older_than_minutes',10);
END $$;
COMMENT ON FUNCTION public.close_stale_context_document_text_runs() IS
 'Closes, as failed:run_stale, every run of the document text reader (context_document_text_policy run_source) still running 10 minutes after it started: a worker that stopped never closes its own run (20261104183000). Called by the reader at the start of each run. Returns {closed, source, older_than_minutes}. Touches no other source and no closed run.';

-- 4. Grants. Service-side only; the two replaced functions keep theirs (CREATE OR REPLACE).
REVOKE ALL ON FUNCTION public.close_stale_context_document_text_runs() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.close_stale_context_document_text_runs() TO service_role;
