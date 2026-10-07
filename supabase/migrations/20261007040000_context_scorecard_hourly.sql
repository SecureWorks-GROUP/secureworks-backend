-- The context scorecard, run every hour: a stored record of each run, its red
-- rows reported, and the read that says whether the hourly run is happening
-- (done definition row 10, 7 Oct 2026).
--
-- Why. Row 10 of the owner's definition of done (5 Oct 2026, data/blueprints/
-- context-system/done-definition.md) is green only when one scorecard shows
-- rows 1 to 9 per lane and per job AND it is run hourly with only the red rows
-- reported. The scorecard (20261006032000) answers the first half; its
-- hourly_run lane is red with "no run record is stored", because nothing ran
-- it on a clock and nothing kept what it said. This migration makes the
-- database run it itself, keep every run, and expose one read for the
-- scorecard v2's hourly_run lane.
--
--   context_scorecard_run_policy()  every number of the hourly run in one place:
--        the pg_cron job (name, schedule, command), its own statement and lock
--        timeouts, when a run counts as late, missed or slow, how long runs are
--        kept, and where red rows are reported. Changed only by migration.
--   context_scorecard_runs  one row per run: as_of (the instant measured), the
--        trigger (cron or manual), start, finish and duration, ok or failed
--        (with the SQLSTATE, never message text), the scorecard's version,
--        live job count and summary verbatim, the status of each row with its
--        red and amber lane names, the red rows, the red lanes ("row:lane"),
--        each red lane's number, unit and value, the alarms, and what the report
--        step did. Ids, statuses and counts only: the scorecard holds no message
--        words, names or contact details. Kept 180 days (the recorder deletes
--        older runs).
--   context_scorecard_record_run(p_trigger)  records one run: takes a
--        transaction advisory lock (a second caller while one runs records
--        nothing and says so), calls context_scorecard(now()), stores the run
--        (a scorecard that fails, times out or answers in a shape it cannot read
--        is stored as a failed run with its code, so a broken hour is never a
--        silent gap), reports its red rows (below), and deletes runs past the
--        keep window. Service role (and the pg_cron job's postgres role).
--   context_scorecard_run_status(p_as_of)  read only: the newest run and the
--        newest ok run before p_as_of (when, how long, red rows and lanes, what
--        was reported), the rows that turned red or cleared since the ok run
--        before it, runs and missed hours in the last 24 hours, failures in a
--        row, the pg_cron job (present, active, schedule and command as the
--        policy says), the report's current state, and `lane`, a row 10
--        hourly_run lane in the scorecard's own lane shape, ready for the
--        scorecard v2 to add. Service role only.
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
-- Where red rows are reported. How ops alerts reach people today, read on
-- production and in both apps on 7 Oct 2026:
--   * Telegram is deleted from the whole system (the owner, 25 Sep 2026); the
--     telegram-bot edge function is not deployed, so Jarvis's scheduler
--     deliveries (deliverToTelegram, notifyFailure) and the old system-health
--     message reach no one.
--   * system-health (pg_cron every 30 minutes) returns JSON to pg_net, which
--     nobody reads.
--   * daily-digest's webhook and email deliveries are off (org_config
--     digest_webhook_url and digest_email: enabled false, no URL).
--   * The ops dashboard and the CEO page subscribe to ai_alerts inserts (a
--     toast and the Jarvis icon pulse), but the supabase_realtime publication
--     holds no tables, so the subscriptions never fire. Their alert panels draw
--     on daily-digest's computed list, not on the table.
--   * Jarvis reads the open ai_alerts rows two ways: its get_ai_alerts tool
--     (ops-ai, behind the ops and CEO dashboard chats), and every agent run's
--     memory context (secureworks-jarvis src/memory/retriever.ts fetchAlerts:
--     open red and amber rows of the last 7 days, every agent type, the 6 AM
--     morning brief included). Nothing pushes them.
-- So no path pushes an alert to the owner or the ops view today without a
-- message to someone. The red rows are therefore put where both apps already
-- read alerts: one open public.ai_alerts row, alert_type
-- context_scorecard_red_rows, severity red, message "Context system hourly
-- check: N of 14 rows red at HH:MI Perth on D Mon (rows ...)", detail_json
-- {kind, source, run_id, as_of, red_rows, red_lanes, red_lane_values, summary,
-- alarm_keys}. The rule, run by run: no red row closes the open report; the
-- same red rows refresh the open report in place (no new row, no new insert
-- event); a person's dismissal of the same red rows (or resolution under their
-- name) holds for 24 hours; new or different red rows, or an open report closed
-- by no one in particular (daily-digest closes every open ai_alerts row on each
-- full run, about 2 to 10 times a day), raise a new row and close the old one.
-- A failed run leaves the report as it was. Nothing is sent: no SMS, email,
-- push, Telegram or GHL call, no job status and no money.
--
-- Not gated by the automation switch on purpose: it writes no evidence and sends
-- nothing, and it keeps running while a lane is stopped so the scorecard shows
-- what the stop did. To pause it: SELECT cron.alter_job((SELECT jobid FROM
-- cron.job WHERE jobname = 'context-scorecard-hourly'), active := false).
--
-- Reads, never replaces: context_scorecard(timestamptz), which only the
-- scorecard v2 replaces (this file pins its signature and answer shape, never
-- its body). Writes: its own table and ai_alerts rows of its own alert type.
-- Replaces no existing function, adds no flag, view or policy, and grants
-- nothing to anon or authenticated.
--
-- Rollback: supabase/rollbacks/20261007040000_context_scorecard_hourly_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard: what is read exists in the shape used; the run log is absent or
-- exactly this migration's; each function is absent or this migration's (a
-- re-apply); a pg_cron job of this name is absent or exactly this migration's.
DO $guard$
DECLARE problems text[] := '{}'; f text; cols text; n integer;
BEGIN
 IF to_regprocedure('public.context_scorecard(timestamptz)') IS NULL THEN
  problems := problems || 'public.context_scorecard(timestamptz) is missing'::text;
 END IF;
 IF to_regclass('public.ai_alerts') IS NULL THEN
  problems := problems || 'public.ai_alerts is missing'::text;
 ELSE
  SELECT string_agg(w.col || ' ' || w.typ, ', ' ORDER BY w.ord) INTO cols
  FROM (VALUES (1, 'id', 'uuid'), (2, 'org_id', 'uuid'), (3, 'alert_type', 'text'), (4, 'severity', 'text'), (5, 'message', 'text'),
               (6, 'recommended_action', 'text'), (7, 'detail_json', 'jsonb'), (8, 'created_at', 'timestamp with time zone'),
               (9, 'dismissed_at', 'timestamp with time zone'), (10, 'resolved_at', 'timestamp with time zone'),
               (11, 'resolved_by', 'uuid')) AS w(ord, col, typ)
  WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.ai_alerts'::regclass AND a.attname = w.col
                      AND NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = w.typ);
  IF cols IS NOT NULL THEN problems := problems || format('public.ai_alerts lacks %s', cols); END IF;
 END IF;
 IF to_regclass('public.context_scorecard_runs') IS NOT NULL THEN
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_scorecard_runs'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:bigint,run_trigger:text,as_of:timestamp with time zone,started_at:timestamp with time zone,'
    'finished_at:timestamp with time zone,duration_ms:integer,status:text,error_code:text,scorecard_version:text,live_jobs:integer,'
    'summary:jsonb,row_status:jsonb,red_rows:integer[],red_lanes:text[],red_lane_values:jsonb,alarms:jsonb,report:jsonb' THEN
   problems := problems || format('public.context_scorecard_runs exists with columns %s', cols);
  END IF;
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_run_policy()', 'public.context_scorecard_record_run(text)',
   'public.context_scorecard_run_status(timestamptz)'] LOOP
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
  -- Runs older than this many days are deleted by the recorder.
  'keep_days', 180,
  -- Where red rows are reported: one open row in the backend's ops alert table
  -- (see the migration header for why this table and who reads it). A person's
  -- dismissal of the same red rows holds this many hours.
  'report', jsonb_build_object('surface', 'public.ai_alerts', 'alert_type', 'context_scorecard_red_rows', 'severity', 'red',
   'org_id', '00000000-0000-0000-0000-000000000001', 'dismissed_quiet_hours', 24)
 )
$fn$;
COMMENT ON FUNCTION public.context_scorecard_run_policy() IS
 'Context scorecard hourly (20261007040000): every number of the hourly scorecard run in one place: the pg_cron job (context-scorecard-hourly, 40 * * * * UTC, its command), the run''s statement and lock timeouts (60 s, 10 s), late (75 min), the missed-hour window (24 h) and grades, slow (30 s), keep (180 days), and the report (public.ai_alerts, alert_type context_scorecard_red_rows, dismissal quiet 24 h). Changed only by migration.';

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
 -- What the report step did: {action, surface, alert_type, alert_id, ...}.
 report jsonb NOT NULL DEFAULT '{}'::jsonb,
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
  AND jsonb_typeof(alarms) = 'array' AND jsonb_typeof(report) = 'object'),
 CONSTRAINT context_scorecard_runs_size CHECK (octet_length(coalesce(summary::text, '')) + octet_length(coalesce(row_status::text, ''))
  + octet_length(red_lane_values::text) + octet_length(alarms::text) + octet_length(report::text) <= 262144)
);
CREATE INDEX IF NOT EXISTS context_scorecard_runs_as_of ON public.context_scorecard_runs (as_of);
CREATE INDEX IF NOT EXISTS context_scorecard_runs_ok_as_of ON public.context_scorecard_runs (as_of) WHERE status = 'ok';
ALTER TABLE public.context_scorecard_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_scorecard_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_scorecard_runs TO service_role;
COMMENT ON TABLE public.context_scorecard_runs IS
 'Context scorecard hourly (20261007040000): one row per run of context_scorecard(now()) (pg_cron context-scorecard-hourly, or a manual call of context_scorecard_record_run): as_of, trigger, start, finish, duration, ok or failed (SQLSTATE or card_shape, never message text), the scorecard version, live jobs and summary, each row''s status with its red and amber lane names, red rows, red lanes (row:lane), each red lane''s number, unit and value, alarms, and what the report step did. Statuses and counts only. Written only by context_scorecard_record_run; read with context_scorecard_run_status. Kept 180 days. RLS on, no policy; service_role may read.';

-- 3. Record one run.
CREATE OR REPLACE FUNCTION public.context_scorecard_record_run(p_trigger text DEFAULT 'manual')
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_pol jsonb := public.context_scorecard_run_policy();
 v_rep jsonb := v_pol->'report';
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
 v_report jsonb;
 v_prev_id uuid; v_prev_resolved timestamptz; v_prev_resolved_by uuid; v_prev_dismissed timestamptz; v_prev_detail jsonb;
 v_prev_red integer[]; v_prev_state text; v_prev_ack timestamptz;
 v_alert uuid;
 v_msg text; v_action text; v_detail jsonb;
 v_pruned integer := 0;
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

 -- Report the red rows (an ok run only; a failed run leaves the report as it was).
 IF v_err IS NOT NULL THEN
  v_report := jsonb_build_object('action', 'not_run', 'reason', 'failed_run', 'surface', v_rep->>'surface', 'alert_type', v_rep->>'alert_type');
 ELSE
  BEGIN
   -- The current report: the alert the newest earlier run raised, kept, held or closed.
   SELECT (r.report->>'alert_id')::uuid INTO v_prev_id
   FROM public.context_scorecard_runs r
   WHERE r.id < v_id AND r.report ? 'alert_id'
   ORDER BY r.id DESC LIMIT 1;
   IF v_prev_id IS NOT NULL THEN
    SELECT a.resolved_at, a.resolved_by, a.dismissed_at, a.detail_json
    INTO v_prev_resolved, v_prev_resolved_by, v_prev_dismissed, v_prev_detail
    FROM public.ai_alerts a WHERE a.id = v_prev_id;
    IF NOT FOUND THEN v_prev_id := NULL; END IF;
   END IF;
   -- A person acknowledged it (dismissed it, or resolved it under their name);
   -- daily-digest's sweep and this check's own closing name nobody.
   v_prev_state := CASE WHEN v_prev_id IS NULL THEN 'none' WHEN v_prev_dismissed IS NOT NULL THEN 'dismissed'
                        WHEN v_prev_resolved IS NOT NULL AND v_prev_resolved_by IS NOT NULL THEN 'resolved_by_person'
                        WHEN v_prev_resolved IS NOT NULL THEN 'resolved' ELSE 'open' END;
   v_prev_ack := CASE v_prev_state WHEN 'dismissed' THEN v_prev_dismissed WHEN 'resolved_by_person' THEN v_prev_resolved END;
   IF v_prev_id IS NOT NULL AND jsonb_typeof(v_prev_detail->'red_rows') = 'array' THEN
    v_prev_red := ARRAY(SELECT x::integer FROM jsonb_array_elements_text(v_prev_detail->'red_rows') x ORDER BY 1);
   END IF;
   v_msg := format('Context system hourly check: %s of %s rows red at %s Perth on %s (rows %s).',
     cardinality(v_red), jsonb_array_length(v_rows), to_char(v_as_of AT TIME ZONE 'Australia/Perth', 'HH24:MI'),
     to_char(v_as_of AT TIME ZONE 'Australia/Perth', 'FMDD Mon'), array_to_string(v_red, ', '));
   v_detail := jsonb_build_object('kind', v_rep->>'alert_type', 'source', 'context_scorecard_record_run (20261007040000)',
     'run_id', v_id, 'as_of', v_as_of, 'red_rows', to_jsonb(v_red), 'red_lanes', to_jsonb(v_red_lanes),
     'red_lane_values', v_red_values, 'summary', v_card->'summary',
     'alarm_keys', coalesce((SELECT jsonb_agg(a->>'key' ORDER BY o) FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_card->'alarms') = 'array' THEN v_card->'alarms' ELSE '[]'::jsonb END) WITH ORDINALITY AS x(a, o)), '[]'::jsonb));
   IF cardinality(v_red) = 0 THEN
    IF v_prev_state = 'open' THEN
     UPDATE public.ai_alerts SET resolved_at = v_as_of WHERE id = v_prev_id AND resolved_at IS NULL AND dismissed_at IS NULL;
     v_action := 'resolved'; v_alert := v_prev_id;
    ELSE
     v_action := 'none';
    END IF;
   ELSIF v_prev_state = 'open' AND v_prev_red IS NOT DISTINCT FROM v_red THEN
    UPDATE public.ai_alerts SET message = v_msg, detail_json = v_detail WHERE id = v_prev_id;
    v_action := 'kept'; v_alert := v_prev_id;
   ELSIF v_prev_state IN ('dismissed', 'resolved_by_person') AND v_prev_red IS NOT DISTINCT FROM v_red
         AND v_prev_ack > v_as_of - make_interval(hours => (v_rep->>'dismissed_quiet_hours')::integer) THEN
    v_action := 'held_dismissed'; v_alert := v_prev_id;
   ELSE
    IF v_prev_state = 'open' THEN
     UPDATE public.ai_alerts SET resolved_at = v_as_of WHERE id = v_prev_id AND resolved_at IS NULL AND dismissed_at IS NULL;
    END IF;
    INSERT INTO public.ai_alerts (org_id, alert_type, severity, message, recommended_action, detail_json, created_at)
    VALUES ((v_rep->>'org_id')::uuid, v_rep->>'alert_type', v_rep->>'severity', v_msg,
      'For the context system''s builders: read the red lanes in context_scorecard_run_status() or the staff scorecard door '
      || '(ops-api action context_scorecard). No job or customer action is asked for, and nothing was sent to anyone. '
      || 'This alert is refreshed every hour and closes itself when no row is red.',
      v_detail, v_as_of)
    RETURNING id INTO v_alert;
    v_action := 'raised';
   END IF;
   v_report := jsonb_build_object('action', v_action, 'surface', v_rep->>'surface', 'alert_type', v_rep->>'alert_type',
     'previous_alert_id', v_prev_id, 'previous_state', v_prev_state, 'red_rows', to_jsonb(v_red))
     || CASE WHEN v_alert IS NOT NULL THEN jsonb_build_object('alert_id', v_alert) ELSE '{}'::jsonb END;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
   v_report := jsonb_build_object('action', 'failed', 'error_code', SQLSTATE, 'surface', v_rep->>'surface', 'alert_type', v_rep->>'alert_type');
  END;
 END IF;

 -- What the report step did, and the keep window. If this is cut (the job's
 -- timeout firing late), the report is written once more without the keep
 -- window (next hour's run prunes); only if that fails too does the run keep
 -- an empty report, which the status reads as not reported. The run itself is
 -- never lost.
 BEGIN
  UPDATE public.context_scorecard_runs SET report = v_report WHERE id = v_id;
  DELETE FROM public.context_scorecard_runs WHERE as_of < v_as_of - make_interval(days => (v_pol->>'keep_days')::integer);
  GET DIAGNOSTICS v_pruned = ROW_COUNT;
 EXCEPTION WHEN query_canceled OR OTHERS THEN
  v_report := v_report || jsonb_build_object('prune_skipped_code', SQLSTATE);
  BEGIN
   UPDATE public.context_scorecard_runs SET report = v_report WHERE id = v_id;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
   v_report := v_report || jsonb_build_object('stored', false, 'store_error_code', SQLSTATE);
  END;
 END;

 RETURN jsonb_build_object('version', 'context-scorecard-run-v1', 'run_id', v_id, 'as_of', v_as_of, 'trigger', p_trigger,
  'status', CASE WHEN v_err IS NULL THEN 'ok' ELSE 'failed' END, 'error_code', v_err,
  'duration_ms', least(3600000, greatest(0, floor(extract(epoch FROM v_finished - v_started) * 1000)))::integer,
  'red_rows', to_jsonb(v_red), 'red_lanes', to_jsonb(v_red_lanes), 'report', v_report, 'pruned', v_pruned);
END
$fn$;
COMMENT ON FUNCTION public.context_scorecard_record_run(text) IS
 'Context scorecard hourly (20261007040000): records one run of context_scorecard(now()) in context_scorecard_runs (p_trigger cron or manual) and reports its red rows as one open public.ai_alerts row (alert_type context_scorecard_red_rows): closed when no row is red, refreshed in place while the same rows stay red, held 24 h after a person dismisses (or resolves under their name) the same rows, raised anew (closing the old) when the rows change or the open one was closed by no one in particular (the daily digest''s sweep). A scorecard that fails, times out or answers in an unreadable shape is stored as a failed run with its code and reports nothing. One run at a time (a concurrent call records nothing and returns skipped). Deletes runs past the keep window. Sends nothing. Service role and the pg_cron job (postgres).';

-- 4. Is the hourly run happening, and what did it last say.
CREATE OR REPLACE FUNCTION public.context_scorecard_run_status(p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_pol jsonb := public.context_scorecard_run_policy();
 v_as_of timestamptz := coalesce(p_as_of, now());
 v_last public.context_scorecard_runs;
 v_ok public.context_scorecard_runs;
 v_prev_ok public.context_scorecard_runs;
 v_first timestamptz;
 v_slot_from timestamptz; v_slot_to timestamptz;
 v_hours_checked integer := 0; v_missed integer := 0; v_missed_list jsonb := '[]'::jsonb;
 v_runs integer; v_runs_ok integer; v_runs_failed integer; v_failures integer;
 v_cron_readable boolean := false; v_jobs integer := 0; v_active boolean; v_schedule text; v_command_ok boolean;
 v_cron jsonb;
 v_alert_id uuid; v_alert_state text := 'none'; v_alert_created timestamptz; v_alert_red jsonb;
 v_reported boolean;
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
 SELECT count(*) INTO v_failures FROM public.context_scorecard_runs r
 WHERE r.as_of <= v_as_of AND (v_ok.id IS NULL OR r.as_of > v_ok.as_of OR (r.as_of = v_ok.as_of AND r.id > v_ok.id));
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

 -- The report the newest ok run made, and the state of its alert now.
 IF v_ok.id IS NOT NULL AND v_ok.report ? 'alert_id' THEN
  v_alert_id := (v_ok.report->>'alert_id')::uuid;
  BEGIN
   SELECT CASE WHEN a.dismissed_at IS NOT NULL THEN 'dismissed' WHEN a.resolved_at IS NOT NULL THEN 'resolved' ELSE 'open' END,
          a.created_at, a.detail_json->'red_rows'
   INTO v_alert_state, v_alert_created, v_alert_red
   FROM public.ai_alerts a WHERE a.id = v_alert_id;
   IF NOT FOUND THEN v_alert_state := 'missing'; END IF;
  EXCEPTION WHEN OTHERS THEN
   v_alert_state := 'unreadable';
  END;
 END IF;
 v_reported := v_ok.id IS NOT NULL AND coalesce(v_ok.report->>'action', '') IN ('raised', 'kept', 'held_dismissed', 'resolved', 'none');

 -- Rows that turned red, or cleared, since the ok run before the newest one.
 SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb) INTO v_newly
 FROM unnest(coalesce(v_ok.red_rows, '{}')) x WHERE v_prev_ok.id IS NOT NULL AND NOT x = ANY (v_prev_ok.red_rows);
 SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb) INTO v_cleared
 FROM unnest(coalesce(v_prev_ok.red_rows, '{}')) x WHERE v_ok.id IS NOT NULL AND NOT x = ANY (v_ok.red_rows);

 v_last_min := CASE WHEN v_last.id IS NOT NULL THEN floor(extract(epoch FROM v_as_of - v_last.as_of) / 60)::integer END;
 v_ok_min := CASE WHEN v_ok.id IS NOT NULL THEN floor(extract(epoch FROM v_as_of - v_ok.as_of) / 60)::integer END;

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
 IF v_last_min > (v_pol->>'late_after_minutes')::integer THEN
  v_red_reasons := v_red_reasons || format('late: the newest run was %s minutes ago', v_last_min);
 END IF;
 IF v_last.status = 'failed' THEN
  v_red_reasons := v_red_reasons || format('the newest run failed (%s), %s in a row', v_last.error_code, v_failures);
 END IF;
 IF v_ok.id IS NOT NULL AND NOT v_reported THEN
  v_red_reasons := v_red_reasons || format('the red rows of the newest scorecard were not reported (%s)',
   coalesce(v_ok.report->>'error_code', v_ok.report->>'action', 'no report'));
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
            CASE WHEN v_ok.id IS NULL THEN 'no ok run yet'
                 WHEN cardinality(v_ok.red_rows) = 0 THEN 'no red rows'
                 ELSE cardinality(v_ok.red_rows) || ' red rows reported (' || coalesce(v_ok.report->>'action', 'none') || ', alert ' || v_alert_state || ')' END)
           END,
  'note', CASE WHEN cardinality(v_red_reasons || v_amber_reasons) = 0 THEN 'pg_cron ' || (v_pol->>'cron_job') || ' at ' || (v_pol->>'schedule')
               || ' UTC; red rows go to ' || (v_pol->'report'->>'surface') || ' (' || (v_pol->'report'->>'alert_type') || ')'
          ELSE array_to_string(v_red_reasons || v_amber_reasons, '; ') END);

 RETURN jsonb_build_object(
  'version', 'context-scorecard-run-status-v1', 'as_of', v_as_of,
  'last_run_at', v_last.as_of, 'red_rows', to_jsonb(coalesce(v_ok.red_rows, '{}'::integer[])),
  'red_lanes', to_jsonb(coalesce(v_ok.red_lanes, '{}'::text[])),
  'last_run', CASE WHEN v_last.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_last.id, 'as_of', v_last.as_of,
    'trigger', v_last.run_trigger, 'status', v_last.status, 'error_code', v_last.error_code, 'duration_ms', v_last.duration_ms,
    'minutes_ago', v_last_min, 'red_rows', to_jsonb(v_last.red_rows), 'report', v_last.report) END,
  'last_ok_run', CASE WHEN v_ok.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_ok.id, 'as_of', v_ok.as_of,
    'trigger', v_ok.run_trigger, 'duration_ms', v_ok.duration_ms, 'minutes_ago', v_ok_min, 'scorecard_version', v_ok.scorecard_version,
    'live_jobs', v_ok.live_jobs, 'summary', v_ok.summary, 'row_status', v_ok.row_status, 'red_rows', to_jsonb(v_ok.red_rows),
    'red_lanes', to_jsonb(v_ok.red_lanes), 'red_lane_values', v_ok.red_lane_values, 'alarms', v_ok.alarms, 'report', v_ok.report) END,
  'changes', jsonb_build_object('previous_ok_run_id', v_prev_ok.id, 'newly_red', v_newly, 'cleared', v_cleared),
  'window', jsonb_build_object('hours', (v_pol->>'window_hours')::integer, 'runs', v_runs, 'ok', v_runs_ok, 'failed', v_runs_failed,
    'first_run_at', v_first, 'hours_checked', v_hours_checked, 'hours_missed', v_missed, 'missed_hours', v_missed_list),
  'consecutive_failures', v_failures,
  'cron', v_cron,
  'report', jsonb_build_object('surface', v_pol->'report'->>'surface', 'alert_type', v_pol->'report'->>'alert_type',
    'reported', v_reported, 'action', v_ok.report->>'action', 'alert_id', v_alert_id, 'alert_state', v_alert_state,
    'alert_created_at', v_alert_created, 'alert_red_rows', v_alert_red),
  'lane', v_lane,
  'policy', v_pol);
END
$fn$;
COMMENT ON FUNCTION public.context_scorecard_run_status(timestamptz) IS
 'Context scorecard hourly (20261007040000): read only. As of p_as_of (default now; runs after it are left out): last_run_at, red_rows and red_lanes of the newest ok run; the newest run and the newest ok run (when, trigger, duration, status or error code, summary, row statuses, red rows, lanes and values, alarms, report); rows newly red or cleared since the ok run before it; runs, ok, failed and whole UTC hours with no ok run in the last 24 h (since the first run); failures in a row; the pg_cron job (readable, exists, active, schedule and command as the policy says); the report (surface, alert type, reported, the alert''s state now); and lane: the done definition''s row 10 hourly_run lane in the scorecard''s lane shape (row, lane, number = missed hours, unit, green, amber, higher_is_better, status, value, note), red when no run is recorded, the job is missing, paused or differs, the newest run is late (75 min) or failed, or its red rows were not reported; amber for one missed hour or a slow run. Service role only.';

-- 5. Access: service role only (and the pg_cron job, which runs as postgres, the owner).
REVOKE ALL ON FUNCTION public.context_scorecard_run_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_scorecard_record_run(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_scorecard_run_status(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_scorecard_run_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.context_scorecard_record_run(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_scorecard_run_status(timestamptz) TO service_role;

-- 6. The schedule. Skipped where pg_cron is absent (the contract runner); a
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
