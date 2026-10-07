-- The context scorecard, run every hour: a stored record of each run, a read
-- that says what to report and whether the hourly run is happening, and the
-- reader's receipt for what it passed on (done definition row 10, 7 Oct 2026).
--
-- Why. Row 10 of the owner's definition of done (5 Oct 2026, data/blueprints/
-- context-system/done-definition.md) is green only when one scorecard shows
-- rows 1 to 9 per lane and per job AND "Rayleigh runs it hourly and reports
-- only red rows". The scorecard (20261006032000) answers the first half; its
-- hourly_run lane is red with "no run record is stored", because nothing ran
-- it on a clock, nothing kept what it said and nothing showed that anyone
-- received its red rows. This migration makes the database run it itself and
-- keep every run, gives the hourly reader (Rayleigh) one read that says what to
-- pass on, and records the reader's receipt, so the hourly_run lane is green
-- only while a named reader keeps recording that it received the red rows.
--
--   context_scorecard_run_policy()  every number of the hourly run in one place:
--        the pg_cron job (name, schedule, command), its own statement and lock
--        timeouts, when a run counts as late, missed or slow, how long runs are
--        kept, and the report: the surface (this read), the readers whose
--        receipts count (rayleigh, the reader the done definition names) and
--        how fresh a receipt must be (75 minutes). Changed only by migration.
--   context_scorecard_runs  one row per run: as_of (the instant measured), the
--        trigger (cron or manual), start, finish and duration, ok or failed
--        (with the SQLSTATE, never message text), the scorecard's version,
--        live job count and summary verbatim, the status of each row with its
--        red and amber lane names, the red rows, the red lanes ("row:lane"),
--        each red lane's number, unit and value, and the alarms. Ids, statuses
--        and counts only: the scorecard holds no message words, names or
--        contact details. Kept 180 days (the recorder deletes older runs).
--   context_scorecard_receipts  one row per reader receipt: the run read (the
--        newest stored run at that moment), the reader, when, what the read said
--        to pass on (red_rows, all_clear, failing or late) and the red rows
--        passed on. Deleted with its run.
--   context_scorecard_record_run(p_trigger)  records one run: takes a
--        transaction advisory lock (a second caller while one runs records
--        nothing and says so), calls context_scorecard(now()), stores the run (a
--        scorecard that fails, times out or answers in a shape it cannot read is
--        stored as a failed run with its code, so a broken hour is never a
--        silent gap) and deletes runs past the keep window. It writes nothing
--        else. Service role (and the pg_cron job's postgres role).
--   context_scorecard_record_receipt(p_reader, p_run_id, p_red_rows)  the
--        reader's receipt, recorded after it has passed on what the status read
--        said. Refused unless the reader is one of the policy's readers, the run
--        is the newest stored run (a newer run means: read again) and the red
--        rows are exactly the newest ok run's. Service role.
--   context_scorecard_run_status(p_as_of)  read only: the newest run and the
--        newest ok run before p_as_of, the rows that turned red or cleared, runs
--        and missed hours in the last 24 hours, failures in a row and since
--        when, the pg_cron job, the report (what to pass on now, as one message,
--        and the newest receipt), and `lane`, a row 10 hourly_run lane in the
--        scorecard's own lane shape, ready for the scorecard v2 to add. Service
--        role only.
--   pg_cron job context-scorecard-hourly, '40 * * * *' (UTC, pg_cron's
--        cron.timezone is GMT): minute 40 of every hour, so the 08:40 Perth run
--        lands before the 08:45 context morning line; no other job starts at
--        minute 40. Command: SET statement_timeout = '60s'; SET lock_timeout =
--        '10s'; SELECT public.context_scorecard_record_run('cron').
--
-- Runtime, measured read only on production 7 Oct 2026 (12:19 to 12:24 Perth):
-- EXPLAIN ANALYZE of context_scorecard(now()) took 1,058, 1,243, 1,074 and
-- 1,091 ms (862 live jobs). pg_cron here connects over libpq as postgres
-- (cron.use_background_workers off), whose statement_timeout is the server
-- configuration's 120 s (no role setting). The job sets its own 60 s statement
-- timeout (48 times the slowest run) and a 10 s lock timeout, so a run that
-- hangs behind a migration's lock or a slow scorecard is cut and stored as a
-- failed run (57014 or 55P03) long before the server limit. Each statement of
-- the job's command gets its own timer (PostgreSQL 13+, one simple query).
--
-- How red rows are reported. Only through context_scorecard_run_status: its
-- report.message is the one line to pass on (null when nothing is red), one of
--   "Context system hourly check: N of 14 rows red at HH:MI Perth on D Mon (rows ...)."
--   "Context system hourly check failing since HH:MI Perth on D Mon (CODE): N failed runs in a row. ..."
--   "Context system hourly check: no run since HH:MI Perth on D Mon (N minutes ago), so the hourly job may have stopped. ..."
--   "Context system hourly check: no run recorded yet."
-- computed when it is read, so a failing streak is refreshed on every read and
-- a job that stopped running is reported by the reader, the dead-man switch:
-- nothing inside the database can report a job that no longer runs. Rayleigh's
-- hourly desk check reads it, passes the message on, and records
-- context_scorecard_record_receipt('rayleigh', report.run_id, report.red_rows).
-- The hourly_run lane is red with "red rows reported to no reader" when no
-- policy reader has recorded a receipt in the last 75 minutes. A receipt is the
-- reader's own statement, made with the service role; the database cannot see
-- past it to the person the reader told.
--
-- Nothing is written outside these two tables: no public.ai_alerts row, no
-- SMS, email, push, GHL call, job status or money. ai_alerts is not a neutral
-- log: secureworks-jarvis loads every open red and amber ai_alerts row of the
-- last 7 days into every agent run's memory (src/memory/retriever.ts
-- fetchAlerts, amber first, then newest first, a few rows per agent), and its
-- get_ai_alerts tool lists them in the ops, CEO and sales chats, so a builders'
-- row there would take a business alert's place. A push surface for the red
-- rows (ai_alerts, the realtime publication, an ops screen) needs the owner's
-- yes first.
--
-- Not gated by the automation switch on purpose: it writes no evidence and sends
-- nothing, and it keeps running while a lane is stopped so the scorecard shows
-- what the stop did. To pause it: SELECT cron.alter_job((SELECT jobid FROM
-- cron.job WHERE jobname = 'context-scorecard-hourly'), active := false).
--
-- Reads, never replaces: context_scorecard(timestamptz), which only the
-- scorecard v2 replaces (this file pins its signature and answer shape, never
-- its body). Replaces no existing function, adds no flag, view or policy, and
-- grants nothing to anon or authenticated.
--
-- Rollback: supabase/rollbacks/20261007040000_context_scorecard_hourly_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard: what is read exists; the run log and the receipts are absent or
-- exactly this migration's; each function is absent or this migration's (a
-- re-apply); a pg_cron job of this name is absent or exactly this migration's.
DO $guard$
DECLARE problems text[] := '{}'; f text; cols text; n integer;
BEGIN
 IF to_regprocedure('public.context_scorecard(timestamptz)') IS NULL THEN
  problems := problems || 'public.context_scorecard(timestamptz) is missing'::text;
 END IF;
 IF to_regclass('public.context_scorecard_runs') IS NOT NULL THEN
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_scorecard_runs'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:bigint,run_trigger:text,as_of:timestamp with time zone,started_at:timestamp with time zone,'
    'finished_at:timestamp with time zone,duration_ms:integer,status:text,error_code:text,scorecard_version:text,live_jobs:integer,'
    'summary:jsonb,row_status:jsonb,red_rows:integer[],red_lanes:text[],red_lane_values:jsonb,alarms:jsonb' THEN
   problems := problems || format('public.context_scorecard_runs exists with columns %s', cols);
  END IF;
 END IF;
 IF to_regclass('public.context_scorecard_receipts') IS NOT NULL THEN
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_scorecard_receipts'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:bigint,run_id:bigint,reader:text,received_at:timestamp with time zone,kind:text,red_rows:integer[]' THEN
   problems := problems || format('public.context_scorecard_receipts exists with columns %s', cols);
  END IF;
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_run_policy()', 'public.context_scorecard_record_run(text)',
   'public.context_scorecard_record_receipt(text,bigint,integer[])', 'public.context_scorecard_run_status(timestamptz)'] LOOP
  IF to_regprocedure(f) IS NOT NULL AND coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '')
     NOT LIKE 'Context scorecard hourly (20261007040000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', f);
  END IF;
 END LOOP;
 -- pg_cron row security can hide a job another role owns; this reads the jobs
 -- the applying role (postgres) can see, the role that schedules this one.
 IF to_regclass('cron.job') IS NOT NULL THEN
  EXECUTE 'SELECT count(*) FROM cron.job WHERE jobname = $1 AND (schedule IS DISTINCT FROM $2 OR command IS DISTINCT FROM $3)'
   INTO n USING 'context-scorecard-hourly', '40 * * * *',
   'SET statement_timeout = ''60s''; SET lock_timeout = ''10s''; SELECT public.context_scorecard_record_run(''cron'')';
  IF n > 0 THEN problems := problems || 'cron job context-scorecard-hourly exists with another schedule or command'::text; END IF;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_scorecard_hourly_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. Every number of the hourly run. To change one, change it here (by
-- migration) and say why; a changed schedule or command also needs the job
-- itself changed (cron.alter_job) in the same migration, and the guard above.
CREATE OR REPLACE FUNCTION public.context_scorecard_run_policy()
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT jsonb_build_object(
  'version', 'context-scorecard-hourly-v1',
  -- The pg_cron job. UTC (cron.timezone is GMT): minute 40 of every hour.
  'cron_job', 'context-scorecard-hourly',
  'schedule', '40 * * * *',
  -- The run's own limits, set by the job's command before the call. The
  -- scorecard took 1.06 to 1.24 s on 7 Oct 2026; the server limit is 120 s.
  'statement_timeout', '60s',
  'lock_timeout', '10s',
  'command', 'SET statement_timeout = ''60s''; SET lock_timeout = ''10s''; SELECT public.context_scorecard_record_run(''cron'')',
  -- Grading the hourly run (row 10, lane hourly_run). Late: the newest run is
  -- older than this many minutes (an hour plus 15 minutes of grace). Missed:
  -- a whole UTC hour in the window, since the first run, with no ok run; one
  -- missed hour is amber, more is red. Slow: an ok run took longer than this,
  -- half the statement timeout (amber).
  'late_after_minutes', 75,
  'window_hours', 24,
  'missed_hours', jsonb_build_object('green', 0, 'amber', 1),
  'slow_after_ms', 30000,
  -- Runs older than this many days are deleted by the recorder (receipts go with them).
  'keep_days', 180,
  -- Where red rows are reported: only through context_scorecard_run_status,
  -- read by these readers (done definition row 10: "Rayleigh runs it hourly
  -- and reports only red rows"), each recording a receipt once it has passed
  -- the report on. The lane is red when no reader's receipt is newer than this
  -- many minutes. Nothing else is written (see the migration header).
  'report', jsonb_build_object('surface', 'context_scorecard_run_status', 'readers', jsonb_build_array('rayleigh'),
   'receipt_fresh_minutes', 75)
 )
$fn$;
COMMENT ON FUNCTION public.context_scorecard_run_policy() IS
 'Context scorecard hourly (20261007040000): every number of the hourly scorecard run in one place: the pg_cron job (context-scorecard-hourly, 40 * * * * UTC, its command), the run''s statement and lock timeouts (60 s, 10 s), late (75 min), the missed-hour window (24 h) and grades, slow (30 s), keep (180 days), and the report (surface context_scorecard_run_status; readers whose receipts count: rayleigh; a receipt counts for 75 min). Changed only by migration.';

-- 2. The run log.
CREATE TABLE IF NOT EXISTS public.context_scorecard_runs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 run_trigger text NOT NULL,
 -- The instant the scorecard measured (its p_as_of): now() of the run's transaction.
 as_of timestamptz NOT NULL,
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL,
 duration_ms integer NOT NULL,
 status text NOT NULL,
 -- A failed run's SQLSTATE (57014 timeout, 55P03 lock wait, ...) or card_shape: never message text.
 error_code text,
 scorecard_version text,
 live_jobs integer,
 -- The scorecard's summary, verbatim.
 summary jsonb,
 -- One entry per row: {row, stage, status, red_lanes, amber_lanes}, in row order.
 row_status jsonb,
 red_rows integer[] NOT NULL DEFAULT '{}',
 -- "row:lane", in row then lane order.
 red_lanes text[] COLLATE "C" NOT NULL DEFAULT '{}',
 -- {row, lane, number, unit, value} for each red lane: why it is red.
 red_lane_values jsonb NOT NULL DEFAULT '[]'::jsonb,
 alarms jsonb NOT NULL DEFAULT '[]'::jsonb,
 CONSTRAINT context_scorecard_runs_trigger CHECK (run_trigger IN ('cron', 'manual')),
 CONSTRAINT context_scorecard_runs_status CHECK (status IN ('ok', 'failed')),
 CONSTRAINT context_scorecard_runs_error CHECK ((status = 'ok') = (error_code IS NULL)
  AND (error_code IS NULL OR error_code ~ '^([0-9A-Z]{5}|[a-z][a-z_]{0,39})$')),
 CONSTRAINT context_scorecard_runs_times CHECK (finished_at >= started_at AND duration_ms BETWEEN 0 AND 3600000),
 -- An ok run carries the card; a failed run carries none of it.
 CONSTRAINT context_scorecard_runs_ok_card CHECK (status = 'failed'
  OR (summary IS NOT NULL AND row_status IS NOT NULL AND scorecard_version IS NOT NULL)),
 CONSTRAINT context_scorecard_runs_failed_bare CHECK (status = 'ok'
  OR (summary IS NULL AND row_status IS NULL AND scorecard_version IS NULL AND live_jobs IS NULL
      AND cardinality(red_rows) = 0 AND cardinality(red_lanes) = 0 AND red_lane_values = '[]'::jsonb AND alarms = '[]'::jsonb)),
 CONSTRAINT context_scorecard_runs_shapes CHECK ((summary IS NULL OR jsonb_typeof(summary) = 'object')
  AND (row_status IS NULL OR jsonb_typeof(row_status) = 'array') AND jsonb_typeof(red_lane_values) = 'array'
  AND jsonb_typeof(alarms) = 'array'),
 CONSTRAINT context_scorecard_runs_size CHECK (octet_length(coalesce(summary::text, '')) + octet_length(coalesce(row_status::text, ''))
  + octet_length(red_lane_values::text) + octet_length(alarms::text) <= 262144)
);
CREATE INDEX IF NOT EXISTS context_scorecard_runs_as_of ON public.context_scorecard_runs (as_of);
CREATE INDEX IF NOT EXISTS context_scorecard_runs_ok_as_of ON public.context_scorecard_runs (as_of) WHERE status = 'ok';
ALTER TABLE public.context_scorecard_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_scorecard_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_scorecard_runs TO service_role;
COMMENT ON TABLE public.context_scorecard_runs IS
 'Context scorecard hourly (20261007040000): one row per run of context_scorecard(now()) (pg_cron context-scorecard-hourly, or a manual call of context_scorecard_record_run): as_of, trigger, start, finish, duration, ok or failed (SQLSTATE or card_shape, never message text), the scorecard version, live jobs and summary, each row''s status with its red and amber lane names, red rows, red lanes (row:lane), each red lane''s number, unit and value, and alarms. Statuses and counts only. Written only by context_scorecard_record_run; read with context_scorecard_run_status. Kept 180 days. RLS on, no policy; service_role may read.';

-- 3. The reader's receipts.
CREATE TABLE IF NOT EXISTS public.context_scorecard_receipts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 -- The run read: the newest stored run when the receipt was recorded.
 run_id bigint NOT NULL REFERENCES public.context_scorecard_runs (id) ON DELETE CASCADE,
 -- Who passed the report on: one of the policy's readers.
 reader text COLLATE "C" NOT NULL,
 -- now() of the receipt's transaction.
 received_at timestamptz NOT NULL,
 -- What the status read said to pass on at that moment.
 kind text COLLATE "C" NOT NULL,
 -- The red rows passed on: the newest ok run's, in row order.
 red_rows integer[] NOT NULL DEFAULT '{}',
 CONSTRAINT context_scorecard_receipts_reader CHECK (reader ~ '^[a-z][a-z0-9_-]{0,39}$'),
 CONSTRAINT context_scorecard_receipts_kind CHECK (kind IN ('red_rows', 'all_clear', 'failing', 'late')),
 CONSTRAINT context_scorecard_receipts_rows CHECK (cardinality(red_rows) <= 100
  AND (kind <> 'red_rows' OR cardinality(red_rows) > 0) AND (kind <> 'all_clear' OR cardinality(red_rows) = 0))
);
CREATE INDEX IF NOT EXISTS context_scorecard_receipts_received_at ON public.context_scorecard_receipts (received_at);
CREATE INDEX IF NOT EXISTS context_scorecard_receipts_run_id ON public.context_scorecard_receipts (run_id);
ALTER TABLE public.context_scorecard_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_scorecard_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_scorecard_receipts TO service_role;
COMMENT ON TABLE public.context_scorecard_receipts IS
 'Context scorecard hourly (20261007040000): one row per receipt from the hourly reader (the policy''s readers: rayleigh), recorded by context_scorecard_record_receipt after the reader passed on what context_scorecard_run_status said: the run read (the newest stored run then), the reader, when, the kind (red_rows, all_clear, failing, late) and the red rows passed on. Ids and counts only. Deleted with its run. RLS on, no policy; service_role may read.';

-- 4. Record one run.
CREATE OR REPLACE FUNCTION public.context_scorecard_record_run(p_trigger text DEFAULT 'manual')
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_pol jsonb := public.context_scorecard_run_policy();
 v_as_of timestamptz := now();
 v_started timestamptz;
 v_finished timestamptz;
 v_card jsonb;
 v_err text;
 v_rows jsonb;
 v_red integer[] := '{}';
 v_red_lanes text[] := '{}';
 v_red_values jsonb := '[]'::jsonb;
 v_id bigint;
 v_pruned integer := 0;
 v_prune_code text;
BEGIN
 IF p_trigger IS NULL OR p_trigger NOT IN ('cron', 'manual') THEN
  RAISE EXCEPTION 'context_scorecard_record_run: p_trigger must be cron or manual' USING ERRCODE = '22023';
 END IF;
 -- One run at a time. The lock is the transaction's, released at its end.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('context_scorecard_record_run', 0)) THEN
  RETURN jsonb_build_object('version', 'context-scorecard-run-v1', 'as_of', v_as_of, 'skipped', 'another_run_in_progress');
 END IF;

 -- The scorecard, and reading its answer. Anything that goes wrong in here,
 -- including the job's statement timeout, is stored as a failed run.
 v_started := clock_timestamp();
 BEGIN
  v_card := public.context_scorecard(v_as_of);
  IF v_card IS NULL OR jsonb_typeof(v_card) <> 'object' OR jsonb_typeof(v_card->'rows') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_card->'rows') = 0 OR jsonb_typeof(v_card->'summary') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_card->'version') IS DISTINCT FROM 'string'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_card->'rows') r
                WHERE jsonb_typeof(r->'row') IS DISTINCT FROM 'number' OR coalesce(r->>'status', '') NOT IN ('green', 'amber', 'red')
                   OR (r ? 'lanes' AND jsonb_typeof(r->'lanes') <> 'array')) THEN
   v_err := 'card_shape';
  ELSE
   SELECT jsonb_agg(jsonb_build_object('row', (r.v->>'row')::integer, 'stage', r.v->>'stage', 'status', r.v->>'status',
           'red_lanes', coalesce((SELECT jsonb_agg(l.v->>'lane' ORDER BY l.o) FROM jsonb_array_elements(coalesce(r.v->'lanes', '[]'::jsonb))
                                   WITH ORDINALITY AS l(v, o) WHERE l.v->>'status' = 'red'), '[]'::jsonb),
           'amber_lanes', coalesce((SELECT jsonb_agg(l.v->>'lane' ORDER BY l.o) FROM jsonb_array_elements(coalesce(r.v->'lanes', '[]'::jsonb))
                                     WITH ORDINALITY AS l(v, o) WHERE l.v->>'status' = 'amber'), '[]'::jsonb))
          ORDER BY (r.v->>'row')::integer, r.o)
   INTO v_rows FROM jsonb_array_elements(v_card->'rows') WITH ORDINALITY AS r(v, o);
   v_red := ARRAY(SELECT DISTINCT (r->>'row')::integer FROM jsonb_array_elements(v_card->'rows') r WHERE r->>'status' = 'red' ORDER BY 1);
   SELECT coalesce(array_agg((r.v->>'row') || ':' || coalesce(l.v->>'lane', '?') ORDER BY (r.v->>'row')::integer, r.o, l.o), '{}'),
          coalesce(jsonb_agg(jsonb_build_object('row', (r.v->>'row')::integer, 'lane', l.v->>'lane', 'number', l.v->'number',
                    'unit', l.v->>'unit', 'value', l.v->>'value') ORDER BY (r.v->>'row')::integer, r.o, l.o), '[]'::jsonb)
   INTO v_red_lanes, v_red_values
   FROM jsonb_array_elements(v_card->'rows') WITH ORDINALITY AS r(v, o)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.v->'lanes', '[]'::jsonb)) WITH ORDINALITY AS l(v, o)
   WHERE l.v->>'status' = 'red';
  END IF;
 EXCEPTION
  WHEN query_canceled THEN v_err := SQLSTATE;
  WHEN OTHERS THEN v_err := SQLSTATE;
 END;
 v_finished := clock_timestamp();
 IF v_err IS NOT NULL THEN
  v_card := NULL; v_rows := NULL; v_red := '{}'; v_red_lanes := '{}'; v_red_values := '[]'::jsonb;
 END IF;

 BEGIN
  INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, error_code,
    scorecard_version, live_jobs, summary, row_status, red_rows, red_lanes, red_lane_values, alarms)
  VALUES (p_trigger, v_as_of, v_started, v_finished,
    least(3600000, greatest(0, floor(extract(epoch FROM v_finished - v_started) * 1000)))::integer,
    CASE WHEN v_err IS NULL THEN 'ok' ELSE 'failed' END, v_err,
    v_card->>'version',
    CASE WHEN jsonb_typeof(v_card->'live_jobs') = 'number' THEN round((v_card->>'live_jobs')::numeric)::integer END,
    v_card->'summary', v_rows, v_red, v_red_lanes, v_red_values,
    CASE WHEN jsonb_typeof(v_card->'alarms') = 'array' THEN v_card->'alarms' ELSE '[]'::jsonb END)
  RETURNING id INTO v_id;
 EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- The card could not be stored (too large, an unexpected value, the job's
  -- statement timeout firing just now): store the hour as a failed run with
  -- that code rather than lose it. The timeout fires once per statement, so
  -- everything after a caught timeout runs to the end.
  v_err := SQLSTATE; v_card := NULL; v_rows := NULL; v_red := '{}'; v_red_lanes := '{}'; v_red_values := '[]'::jsonb;
  INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, error_code)
  VALUES (p_trigger, v_as_of, v_started, v_finished,
    least(3600000, greatest(0, floor(extract(epoch FROM v_finished - v_started) * 1000)))::integer, 'failed', v_err)
  RETURNING id INTO v_id;
 END;

 -- The keep window. If this is cut (the job's timeout firing late), the run is
 -- already stored and the next run prunes.
 BEGIN
  DELETE FROM public.context_scorecard_runs WHERE as_of < v_as_of - make_interval(days => (v_pol->>'keep_days')::integer);
  GET DIAGNOSTICS v_pruned = ROW_COUNT;
 EXCEPTION WHEN query_canceled OR OTHERS THEN
  v_prune_code := SQLSTATE; v_pruned := 0;
 END;

 RETURN jsonb_build_object('version', 'context-scorecard-run-v1', 'run_id', v_id, 'as_of', v_as_of, 'trigger', p_trigger,
  'status', CASE WHEN v_err IS NULL THEN 'ok' ELSE 'failed' END, 'error_code', v_err,
  'duration_ms', least(3600000, greatest(0, floor(extract(epoch FROM v_finished - v_started) * 1000)))::integer,
  'red_rows', to_jsonb(v_red), 'red_lanes', to_jsonb(v_red_lanes), 'pruned', v_pruned)
  || CASE WHEN v_prune_code IS NOT NULL THEN jsonb_build_object('prune_skipped_code', v_prune_code) ELSE '{}'::jsonb END;
END
$fn$;
COMMENT ON FUNCTION public.context_scorecard_record_run(text) IS
 'Context scorecard hourly (20261007040000): records one run of context_scorecard(now()) in context_scorecard_runs (p_trigger cron or manual). A scorecard that fails, times out or answers in an unreadable shape is stored as a failed run with its code. One run at a time (a concurrent call records nothing and returns skipped). Deletes runs past the keep window. Writes nothing else and sends nothing: red rows are reported through context_scorecard_run_status and the reader''s receipt. Service role and the pg_cron job (postgres).';

-- 5. The reader's receipt.
CREATE OR REPLACE FUNCTION public.context_scorecard_record_receipt(p_reader text, p_run_id bigint, p_red_rows integer[])
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_pol jsonb := public.context_scorecard_run_policy();
 v_now timestamptz := now();
 v_last public.context_scorecard_runs;
 v_ok public.context_scorecard_runs;
 v_red integer[];
 v_given integer[];
 v_kind text;
 v_id bigint;
BEGIN
 IF p_reader IS NULL OR NOT ((v_pol->'report'->'readers') ? p_reader) THEN
  RAISE EXCEPTION 'context_scorecard_record_receipt: p_reader must be one of %', v_pol->'report'->'readers' USING ERRCODE = '22023';
 END IF;
 IF p_red_rows IS NULL OR array_position(p_red_rows, NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'context_scorecard_record_receipt: p_red_rows must list the red rows passed on, empty when none' USING ERRCODE = '22023';
 END IF;
 SELECT r.* INTO v_last FROM public.context_scorecard_runs r WHERE r.as_of <= v_now ORDER BY r.as_of DESC, r.id DESC LIMIT 1;
 IF v_last.id IS NULL THEN
  RAISE EXCEPTION 'context_scorecard_record_receipt: no run is stored yet' USING ERRCODE = '22023';
 END IF;
 IF p_run_id IS DISTINCT FROM v_last.id THEN
  RAISE EXCEPTION 'context_scorecard_record_receipt: run % is not the newest stored run (%): read context_scorecard_run_status again and pass on what it says',
   coalesce(p_run_id::text, 'null'), v_last.id USING ERRCODE = '22023';
 END IF;
 SELECT r.* INTO v_ok FROM public.context_scorecard_runs r WHERE r.status = 'ok' AND r.as_of <= v_now ORDER BY r.as_of DESC, r.id DESC LIMIT 1;
 v_red := coalesce(v_ok.red_rows, '{}');
 v_given := ARRAY(SELECT DISTINCT x FROM unnest(p_red_rows) x ORDER BY 1);
 IF v_given IS DISTINCT FROM v_red THEN
  RAISE EXCEPTION 'context_scorecard_record_receipt: the red rows passed on ({%}) are not the newest ok run''s ({%})',
   array_to_string(v_given, ','), array_to_string(v_red, ',') USING ERRCODE = '22023';
 END IF;
 v_kind := CASE WHEN floor(extract(epoch FROM v_now - v_last.as_of) / 60) > (v_pol->>'late_after_minutes')::integer THEN 'late'
                WHEN v_last.status = 'failed' THEN 'failing'
                WHEN cardinality(v_red) > 0 THEN 'red_rows' ELSE 'all_clear' END;
 INSERT INTO public.context_scorecard_receipts (run_id, reader, received_at, kind, red_rows)
 VALUES (v_last.id, p_reader, v_now, v_kind, v_red)
 RETURNING id INTO v_id;
 RETURN jsonb_build_object('version', 'context-scorecard-receipt-v1', 'receipt_id', v_id, 'run_id', v_last.id, 'reader', p_reader,
  'received_at', v_now, 'kind', v_kind, 'red_rows', to_jsonb(v_red));
END
$fn$;
COMMENT ON FUNCTION public.context_scorecard_record_receipt(text, bigint, integer[]) IS
 'Context scorecard hourly (20261007040000): the hourly reader''s receipt, recorded after it passed on what context_scorecard_run_status said (report.message): p_reader one of the policy''s readers (rayleigh), p_run_id the newest stored run (report.run_id; a newer run is refused: read again), p_red_rows exactly the newest ok run''s red rows (report.red_rows, empty when none). Stores the run, reader, time, kind (red_rows, all_clear, failing, late) and red rows in context_scorecard_receipts. Writes nothing else. Service role.';

-- 6. Is the hourly run happening, what to report now, and who received it.
CREATE OR REPLACE FUNCTION public.context_scorecard_run_status(p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_pol jsonb := public.context_scorecard_run_policy();
 v_rep jsonb := v_pol->'report';
 v_as_of timestamptz := coalesce(p_as_of, now());
 v_late integer := (v_pol->>'late_after_minutes')::integer;
 v_fresh integer := (v_pol->'report'->>'receipt_fresh_minutes')::integer;
 v_last public.context_scorecard_runs;
 v_ok public.context_scorecard_runs;
 v_prev_ok public.context_scorecard_runs;
 v_fail_first public.context_scorecard_runs;
 v_rc public.context_scorecard_receipts;
 v_first timestamptz;
 v_slot_from timestamptz; v_slot_to timestamptz;
 v_hours_checked integer := 0; v_missed integer := 0; v_missed_list jsonb := '[]'::jsonb;
 v_runs integer; v_runs_ok integer; v_runs_failed integer; v_failures integer; v_receipts integer;
 v_cron_readable boolean := false; v_jobs integer := 0; v_active boolean; v_schedule text; v_command_ok boolean;
 v_cron jsonb;
 v_rc_min integer; v_reported boolean;
 v_kind text; v_msg text; v_good text; v_readers text;
 v_red_reasons text[] := '{}'; v_amber_reasons text[] := '{}';
 v_status text; v_last_min integer; v_ok_min integer;
 v_newly jsonb; v_cleared jsonb;
 v_lane jsonb;
BEGIN
 SELECT r.* INTO v_last FROM public.context_scorecard_runs r WHERE r.as_of <= v_as_of ORDER BY r.as_of DESC, r.id DESC LIMIT 1;
 SELECT r.* INTO v_ok FROM public.context_scorecard_runs r WHERE r.status = 'ok' AND r.as_of <= v_as_of
 ORDER BY r.as_of DESC, r.id DESC LIMIT 1;
 IF v_ok.id IS NOT NULL THEN
  SELECT r.* INTO v_prev_ok FROM public.context_scorecard_runs r
  WHERE r.status = 'ok' AND (r.as_of < v_ok.as_of OR (r.as_of = v_ok.as_of AND r.id < v_ok.id))
  ORDER BY r.as_of DESC, r.id DESC LIMIT 1;
 END IF;
 SELECT min(r.as_of) INTO v_first FROM public.context_scorecard_runs r WHERE r.as_of <= v_as_of;

 -- Runs and failures in the window; whole UTC hours since the first run with no ok run.
 SELECT count(*), count(*) FILTER (WHERE r.status = 'ok'), count(*) FILTER (WHERE r.status = 'failed')
 INTO v_runs, v_runs_ok, v_runs_failed
 FROM public.context_scorecard_runs r
 WHERE r.as_of > v_as_of - make_interval(hours => (v_pol->>'window_hours')::integer) AND r.as_of <= v_as_of;
 -- Every run after the newest ok run failed: the current failing streak, and its first run.
 SELECT count(*) INTO v_failures FROM public.context_scorecard_runs r
 WHERE r.as_of <= v_as_of AND (v_ok.id IS NULL OR r.as_of > v_ok.as_of OR (r.as_of = v_ok.as_of AND r.id > v_ok.id));
 IF v_failures > 0 THEN
  SELECT r.* INTO v_fail_first FROM public.context_scorecard_runs r
  WHERE r.as_of <= v_as_of AND (v_ok.id IS NULL OR r.as_of > v_ok.as_of OR (r.as_of = v_ok.as_of AND r.id > v_ok.id))
  ORDER BY r.as_of, r.id LIMIT 1;
 END IF;
 IF v_first IS NOT NULL THEN
  v_slot_from := greatest(date_trunc('hour', v_first, 'UTC'),
                          date_trunc('hour', v_as_of - make_interval(hours => (v_pol->>'window_hours')::integer), 'UTC'));
  v_slot_to := date_trunc('hour', v_as_of, 'UTC');
  SELECT count(*), count(*) FILTER (WHERE NOT s.covered),
         coalesce(jsonb_agg(s.slot ORDER BY s.slot) FILTER (WHERE NOT s.covered), '[]'::jsonb)
  INTO v_hours_checked, v_missed, v_missed_list
  FROM (SELECT g.slot, EXISTS (SELECT 1 FROM public.context_scorecard_runs r WHERE r.status = 'ok'
                                AND r.as_of >= g.slot AND r.as_of < g.slot + interval '1 hour' AND r.as_of <= v_as_of) AS covered
        FROM generate_series(v_slot_from, v_slot_to - interval '1 hour', interval '1 hour') AS g(slot)) s;
 END IF;

 -- The newest receipt from one of the policy's readers, and how many in the window.
 SELECT c.* INTO v_rc FROM public.context_scorecard_receipts c
 WHERE c.received_at <= v_as_of AND (v_rep->'readers') ? c.reader
 ORDER BY c.received_at DESC, c.id DESC LIMIT 1;
 SELECT count(*) INTO v_receipts FROM public.context_scorecard_receipts c
 WHERE c.received_at <= v_as_of AND c.received_at > v_as_of - make_interval(hours => (v_pol->>'window_hours')::integer)
   AND (v_rep->'readers') ? c.reader;
 v_rc_min := CASE WHEN v_rc.id IS NOT NULL THEN floor(extract(epoch FROM v_as_of - v_rc.received_at) / 60)::integer END;
 v_reported := v_rc.id IS NOT NULL AND v_rc_min <= v_fresh;
 v_readers := (SELECT string_agg(x, ' or ' ORDER BY o) FROM jsonb_array_elements_text(v_rep->'readers') WITH ORDINALITY AS r(x, o));

 -- The pg_cron job. pg_cron row security shows the jobs of the definer (postgres), which owns this one.
 IF to_regclass('cron.job') IS NOT NULL THEN
  BEGIN
   EXECUTE 'SELECT count(*), bool_or(active), min(schedule), bool_and(command = $2) FROM cron.job WHERE jobname = $1'
    INTO v_jobs, v_active, v_schedule, v_command_ok USING v_pol->>'cron_job', v_pol->>'command';
   v_cron_readable := true;
  EXCEPTION WHEN OTHERS THEN
   v_cron_readable := false;
  END;
 END IF;
 v_cron := jsonb_build_object('readable', v_cron_readable, 'jobname', v_pol->>'cron_job', 'exists', v_jobs > 0,
  'jobs', v_jobs, 'active', coalesce(v_active, false), 'schedule', v_schedule,
  'schedule_matches', v_schedule IS NOT DISTINCT FROM v_pol->>'schedule', 'command_matches', coalesce(v_command_ok, false));

 -- Rows that turned red, or cleared, since the ok run before the newest one.
 SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb) INTO v_newly
 FROM unnest(coalesce(v_ok.red_rows, '{}')) x WHERE v_prev_ok.id IS NOT NULL AND NOT x = ANY (v_prev_ok.red_rows);
 SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb) INTO v_cleared
 FROM unnest(coalesce(v_prev_ok.red_rows, '{}')) x WHERE v_ok.id IS NOT NULL AND NOT x = ANY (v_ok.red_rows);

 v_last_min := CASE WHEN v_last.id IS NOT NULL THEN floor(extract(epoch FROM v_as_of - v_last.as_of) / 60)::integer END;
 v_ok_min := CASE WHEN v_ok.id IS NOT NULL THEN floor(extract(epoch FROM v_as_of - v_ok.as_of) / 60)::integer END;

 -- What a reader passes on now: one message, computed when read, so a failing
 -- streak is refreshed on every read and a stopped job is reported by the
 -- reader. Null when nothing is red ("reports only red rows").
 v_kind := CASE WHEN v_last.id IS NULL THEN 'no_run' WHEN v_last_min > v_late THEN 'late'
                WHEN v_last.status = 'failed' THEN 'failing'
                WHEN cardinality(v_ok.red_rows) > 0 THEN 'red_rows' ELSE 'all_clear' END;
 v_good := CASE WHEN v_ok.id IS NULL THEN ' No good run is stored yet.'
                WHEN cardinality(v_ok.red_rows) = 0 THEN format(' The last good run, %s Perth on %s, had no red rows.',
                  to_char(v_ok.as_of AT TIME ZONE 'Australia/Perth', 'HH24:MI'), to_char(v_ok.as_of AT TIME ZONE 'Australia/Perth', 'FMDD Mon'))
                ELSE format(' The last good run, %s Perth on %s, had %s of %s rows red (rows %s).',
                  to_char(v_ok.as_of AT TIME ZONE 'Australia/Perth', 'HH24:MI'), to_char(v_ok.as_of AT TIME ZONE 'Australia/Perth', 'FMDD Mon'),
                  cardinality(v_ok.red_rows), jsonb_array_length(v_ok.row_status), array_to_string(v_ok.red_rows, ', ')) END;
 v_msg := CASE v_kind
  WHEN 'no_run' THEN 'Context system hourly check: no run recorded yet.'
  WHEN 'late' THEN format('Context system hourly check: no run since %s Perth on %s (%s minutes ago), so the hourly job may have stopped.',
    to_char(v_last.as_of AT TIME ZONE 'Australia/Perth', 'HH24:MI'), to_char(v_last.as_of AT TIME ZONE 'Australia/Perth', 'FMDD Mon'), v_last_min)
    || CASE WHEN v_last.status = 'failed' THEN format(' That run failed (%s).', v_last.error_code) ELSE '' END || v_good
  WHEN 'failing' THEN format('Context system hourly check failing since %s Perth on %s (%s): %s.',
    to_char(v_fail_first.as_of AT TIME ZONE 'Australia/Perth', 'HH24:MI'), to_char(v_fail_first.as_of AT TIME ZONE 'Australia/Perth', 'FMDD Mon'),
    v_last.error_code, CASE WHEN v_failures = 1 THEN '1 failed run' ELSE v_failures || ' failed runs in a row' END) || v_good
  WHEN 'red_rows' THEN format('Context system hourly check: %s of %s rows red at %s Perth on %s (rows %s).',
    cardinality(v_ok.red_rows), jsonb_array_length(v_ok.row_status), to_char(v_ok.as_of AT TIME ZONE 'Australia/Perth', 'HH24:MI'),
    to_char(v_ok.as_of AT TIME ZONE 'Australia/Perth', 'FMDD Mon'), array_to_string(v_ok.red_rows, ', '))
  END;

 -- The row 10 hourly_run lane.
 IF v_last.id IS NULL THEN v_red_reasons := v_red_reasons || 'no run recorded yet'::text; END IF;
 IF NOT v_cron_readable THEN
  v_red_reasons := v_red_reasons || 'the pg_cron job cannot be read here'::text;
 ELSIF v_jobs = 0 THEN
  v_red_reasons := v_red_reasons || format('no pg_cron job named %s', v_pol->>'cron_job');
 ELSIF v_jobs > 1 THEN
  v_red_reasons := v_red_reasons || format('%s pg_cron jobs named %s', v_jobs, v_pol->>'cron_job');
 ELSIF NOT coalesce(v_active, false) THEN
  v_red_reasons := v_red_reasons || format('pg_cron job %s is paused', v_pol->>'cron_job');
 ELSIF v_schedule IS DISTINCT FROM v_pol->>'schedule' OR NOT coalesce(v_command_ok, false) THEN
  v_red_reasons := v_red_reasons || format('pg_cron job %s differs from the policy', v_pol->>'cron_job');
 END IF;
 IF v_last_min > v_late THEN
  v_red_reasons := v_red_reasons || format('late: the newest run was %s minutes ago', v_last_min);
 END IF;
 IF v_last.status = 'failed' THEN
  v_red_reasons := v_red_reasons || format('the newest run failed (%s), %s in a row', v_last.error_code, v_failures);
 END IF;
 -- Reported means the hourly reader received it: a receipt from one of the
 -- policy's readers newer than receipt_fresh_minutes. A receipt names the
 -- newest run at its moment, so every run it does not cover is younger than
 -- the receipt.
 IF v_last.id IS NOT NULL AND NOT v_reported THEN
  v_red_reasons := v_red_reasons || CASE WHEN v_rc.id IS NULL THEN format('red rows reported to no reader: no receipt from %s yet', v_readers)
   ELSE format('red rows reported to no reader: the newest receipt from %s was %s minutes ago', v_rc.reader, v_rc_min) END;
 END IF;
 IF v_last.status = 'ok' AND v_last.duration_ms > (v_pol->>'slow_after_ms')::integer THEN
  v_amber_reasons := v_amber_reasons || format('slow: the newest run took %s ms', v_last.duration_ms);
 END IF;
 IF v_missed > (v_pol->'missed_hours'->>'green')::integer THEN
  v_amber_reasons := v_amber_reasons || format('%s of %s hours had no ok run', v_missed, v_hours_checked);
 END IF;
 v_status := CASE WHEN cardinality(v_red_reasons) > 0 OR v_missed > (v_pol->'missed_hours'->>'amber')::integer THEN 'red'
                  WHEN cardinality(v_amber_reasons) > 0 THEN 'amber' ELSE 'green' END;
 v_lane := jsonb_build_object('row', 10, 'lane', 'hourly_run',
  'number', CASE WHEN v_first IS NULL THEN NULL ELSE v_missed END,
  'unit', format('hours in the last %s with no ok run', v_pol->>'window_hours'),
  'green', (v_pol->'missed_hours'->>'green')::numeric, 'amber', (v_pol->'missed_hours'->>'amber')::numeric,
  'higher_is_better', false, 'status', v_status,
  'value', CASE WHEN v_last.id IS NULL THEN 'no hourly run recorded yet'
           ELSE format('newest run %s Perth on %s, %s; %s of %s hours missed; %s',
            to_char(v_last.as_of AT TIME ZONE 'Australia/Perth', 'HH24:MI'),
            to_char(v_last.as_of AT TIME ZONE 'Australia/Perth', 'FMDD Mon'),
            CASE WHEN v_last.status = 'ok' THEN 'ok in ' || v_last.duration_ms || ' ms' ELSE 'failed (' || v_last.error_code || ')' END,
            v_missed, v_hours_checked,
            CASE WHEN NOT v_reported THEN 'red rows reported to no reader'
                 WHEN v_rc.kind = 'all_clear' THEN format('read by %s at %s Perth, no red rows', v_rc.reader,
                   to_char(v_rc.received_at AT TIME ZONE 'Australia/Perth', 'HH24:MI'))
                 ELSE format('%s passed on by %s at %s Perth',
                   CASE v_rc.kind WHEN 'red_rows' THEN cardinality(v_rc.red_rows) || ' red rows' ELSE 'the ' || v_rc.kind || ' check' END,
                   v_rc.reader, to_char(v_rc.received_at AT TIME ZONE 'Australia/Perth', 'HH24:MI')) END)
           END,
  'note', CASE WHEN cardinality(v_red_reasons || v_amber_reasons) = 0
               THEN format('pg_cron %s at %s UTC; %s reads context_scorecard_run_status hourly and passes on only the red rows',
                 v_pol->>'cron_job', v_pol->>'schedule', v_readers)
          ELSE array_to_string(v_red_reasons || v_amber_reasons, '; ') END);

 RETURN jsonb_build_object(
  'version', 'context-scorecard-run-status-v1', 'as_of', v_as_of,
  'last_run_at', v_last.as_of, 'red_rows', to_jsonb(coalesce(v_ok.red_rows, '{}'::integer[])),
  'red_lanes', to_jsonb(coalesce(v_ok.red_lanes, '{}'::text[])),
  'last_run', CASE WHEN v_last.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_last.id, 'as_of', v_last.as_of,
    'trigger', v_last.run_trigger, 'status', v_last.status, 'error_code', v_last.error_code, 'duration_ms', v_last.duration_ms,
    'minutes_ago', v_last_min, 'red_rows', to_jsonb(v_last.red_rows)) END,
  'last_ok_run', CASE WHEN v_ok.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_ok.id, 'as_of', v_ok.as_of,
    'trigger', v_ok.run_trigger, 'duration_ms', v_ok.duration_ms, 'minutes_ago', v_ok_min, 'scorecard_version', v_ok.scorecard_version,
    'live_jobs', v_ok.live_jobs, 'summary', v_ok.summary, 'row_status', v_ok.row_status, 'red_rows', to_jsonb(v_ok.red_rows),
    'red_lanes', to_jsonb(v_ok.red_lanes), 'red_lane_values', v_ok.red_lane_values, 'alarms', v_ok.alarms) END,
  'changes', jsonb_build_object('previous_ok_run_id', v_prev_ok.id, 'newly_red', v_newly, 'cleared', v_cleared),
  'window', jsonb_build_object('hours', (v_pol->>'window_hours')::integer, 'runs', v_runs, 'ok', v_runs_ok, 'failed', v_runs_failed,
    'first_run_at', v_first, 'hours_checked', v_hours_checked, 'hours_missed', v_missed, 'missed_hours', v_missed_list,
    'receipts', v_receipts),
  'consecutive_failures', v_failures,
  'cron', v_cron,
  'report', jsonb_build_object('surface', v_rep->>'surface', 'readers', v_rep->'readers', 'kind', v_kind, 'message', v_msg,
    'run_id', v_last.id, 'red_rows', to_jsonb(coalesce(v_ok.red_rows, '{}'::integer[])),
    'failing_since', CASE WHEN v_kind IN ('failing', 'late') THEN v_fail_first.as_of END,
    'reported', v_reported,
    'receipt', CASE WHEN v_rc.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_rc.id, 'reader', v_rc.reader,
      'received_at', v_rc.received_at, 'minutes_ago', v_rc_min, 'run_id', v_rc.run_id, 'kind', v_rc.kind,
      'red_rows', to_jsonb(v_rc.red_rows)) END,
    'how', format('Pass on message when it is not null, then call context_scorecard_record_receipt(reader, run_id, red_rows); a receipt counts for %s minutes.',
      v_fresh)),
  'lane', v_lane,
  'policy', v_pol);
END
$fn$;
COMMENT ON FUNCTION public.context_scorecard_run_status(timestamptz) IS
 'Context scorecard hourly (20261007040000): read only. As of p_as_of (default now; runs and receipts after it are left out): last_run_at, red_rows and red_lanes of the newest ok run; the newest run and the newest ok run (when, trigger, duration, status or error code, summary, row statuses, red rows, lanes and values, alarms); rows newly red or cleared since the ok run before it; runs, ok, failed, receipts and whole UTC hours with no ok run in the last 24 h (since the first run); failures in a row; the pg_cron job (readable, exists, active, schedule and command as the policy says); report: what the hourly reader passes on now (kind no_run, late, failing, red_rows or all_clear; message, null when nothing is red; run_id and red_rows for its receipt; failing_since) and the newest receipt from a policy reader (rayleigh); and lane: the done definition''s row 10 hourly_run lane in the scorecard''s lane shape (row, lane, number = missed hours, unit, green, amber, higher_is_better, status, value, note), red when no run is recorded, the job is missing, paused or differs, the newest run is late (75 min) or failed, or no policy reader recorded a receipt in the last 75 min ("red rows reported to no reader"); amber for one missed hour or a slow run. Service role only.';

-- 7. Access: service role only (and the pg_cron job, which runs as postgres, the owner).
REVOKE ALL ON FUNCTION public.context_scorecard_run_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_scorecard_record_run(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_scorecard_record_receipt(text, bigint, integer[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_scorecard_run_status(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_scorecard_run_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_scorecard_record_run(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_scorecard_record_receipt(text, bigint, integer[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_scorecard_run_status(timestamptz) TO service_role;

-- 8. The schedule. Skipped where pg_cron is absent (the contract runner); a
-- job of this name already scheduled exactly so (a re-apply) is left alone.
DO $cron$
DECLARE v_pol jsonb := public.context_scorecard_run_policy();
BEGIN
 IF to_regclass('cron.job') IS NULL THEN
  RAISE NOTICE 'context-scorecard-hourly: pg_cron absent, not scheduled';
  RETURN;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_pol->>'cron_job') THEN
  PERFORM cron.schedule(v_pol->>'cron_job', v_pol->>'schedule', v_pol->>'command');
 END IF;
END $cron$;
