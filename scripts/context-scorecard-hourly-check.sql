-- The hourly scorecard run (migration 20261007040000_context_scorecard_hourly):
-- the check after it lands, an optional first run, and the hourly reader's desk
-- check (Rayleigh) that passes the red rows on and records the receipt.
--
-- PART 1 is READ ONLY. PARTS 2 and 3 are WRITES, as dry runs: as written each
-- ends in ROLLBACK and changes nothing. Production: run each PART on its own,
-- and only after the migration is applied. Proved on a disposable PostgreSQL 17
-- copy of the migration stack with pg_cron and ledger stand-ins, never against
-- production by its author.

-- PART 1 (read only). Expect: the ledger row; one job context-scorecard-hourly,
-- active, schedule 40 * * * *, command_matches true; after its first minute 40,
-- a pg_cron run that succeeded and a stored run (status ok, or failed with a
-- SQLSTATE that says why); the lane and the report (report.message is what the
-- reader passes on); and the newest reader receipts.
BEGIN READ ONLY;
SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261007040000';
SELECT j.jobid, j.jobname, j.schedule, j.active, j.username,
       j.command = public.context_scorecard_run_policy()->>'command' AS command_matches
FROM cron.job j WHERE j.jobname = 'context-scorecard-hourly';
SELECT d.runid, d.status, d.start_time, d.end_time - d.start_time AS took
FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
WHERE j.jobname = 'context-scorecard-hourly' ORDER BY d.start_time DESC LIMIT 5;
SELECT r.id, r.run_trigger, r.as_of, r.duration_ms, r.status, r.error_code, r.red_rows
FROM public.context_scorecard_runs r ORDER BY r.id DESC LIMIT 5;
SELECT s->'lane' AS lane, s->'report' AS report, s->'window' AS run_window, s->'cron' AS cron_job
FROM (SELECT public.context_scorecard_run_status() AS s) x;
SELECT c.id, c.run_id, c.reader, c.received_at, c.kind, c.red_rows
FROM public.context_scorecard_receipts c ORDER BY c.received_at DESC, c.id DESC LIMIT 5;
ROLLBACK;

-- PART 2 (write, dry run). Records the first run now instead of waiting for
-- the next minute 40 (UTC): one context_scorecard_runs row and nothing else.
-- Sends nothing. The guards hold it to the first run only. To keep it, change
-- the final ROLLBACK to COMMIT.
-- Undo after a COMMIT, with the id it printed:
--   DELETE FROM public.context_scorecard_runs WHERE id = <run_id>;
BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '10s';
DO $before$
BEGIN
 IF to_regprocedure('public.context_scorecard_record_run(text)') IS NULL THEN
  RAISE EXCEPTION 'first run: 20261007040000 is not applied';
 END IF;
 IF (SELECT count(*) FROM public.context_scorecard_runs) <> 0 THEN
  RAISE EXCEPTION 'first run: % runs are already stored; nothing to do', (SELECT count(*) FROM public.context_scorecard_runs);
 END IF;
END $before$;
SELECT public.context_scorecard_record_run('manual') - 'red_lanes' AS first_run;
DO $after$
BEGIN
 IF (SELECT count(*) FROM public.context_scorecard_runs) <> 1 THEN
  RAISE EXCEPTION 'first run: expected exactly 1 stored run, found %', (SELECT count(*) FROM public.context_scorecard_runs);
 END IF;
 IF (SELECT count(*) FROM public.context_scorecard_receipts) <> 0 THEN
  RAISE EXCEPTION 'first run: a run wrote a receipt';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_stat_xact_user_tables s
            WHERE s.n_tup_ins + s.n_tup_upd + s.n_tup_del > 0 AND s.schemaname !~ '^pg_temp'
              AND s.schemaname || '.' || s.relname <> 'public.context_scorecard_runs') THEN
  RAISE EXCEPTION 'first run: wrote outside the run log: %', (SELECT string_agg(s.schemaname || '.' || s.relname, ', ')
   FROM pg_stat_xact_user_tables s WHERE s.n_tup_ins + s.n_tup_upd + s.n_tup_del > 0 AND s.schemaname !~ '^pg_temp');
 END IF;
END $after$;
SELECT r.id AS run_id, r.status, r.error_code, r.red_rows FROM public.context_scorecard_runs r;
ROLLBACK;

-- PART 3 (write, dry run): the hourly reader's desk check, once an hour.
--   1. Read the status: report.kind, report.message, report.run_id, report.red_rows.
--   2. When report.message is not null, pass it on (the red rows, a failing
--      check, or no run for 75 minutes). When it is null nothing is red: pass
--      nothing on ("reports only red rows").
--   3. Record the receipt: one context_scorecard_receipts row and nothing else.
--      A newer run landing between 1 and 3 is refused (22023): read again.
-- The lane (row 10, hourly_run) is green only while a receipt is under 75
-- minutes old. For the real check change the final ROLLBACK to COMMIT.
-- Undo a committed receipt, with the id it printed:
--   DELETE FROM public.context_scorecard_receipts WHERE id = <receipt_id>;
BEGIN;
SET LOCAL statement_timeout = '30s';
SELECT s->'report'->>'kind' AS kind, s->'report'->>'message' AS pass_on, s->'report'->>'run_id' AS run_id,
       s->'report'->'red_rows' AS red_rows, s->'lane'->>'status' AS lane, s->'lane'->>'note' AS lane_note
FROM (SELECT public.context_scorecard_run_status() AS s) x;
CREATE TEMP TABLE hourly_receipts_before ON COMMIT DROP AS SELECT count(*) AS n FROM public.context_scorecard_receipts;
SELECT public.context_scorecard_record_receipt('rayleigh', (s->'report'->>'run_id')::bigint,
         ARRAY(SELECT jsonb_array_elements_text(s->'report'->'red_rows')::integer)) AS receipt
FROM (SELECT public.context_scorecard_run_status() AS s) x;
DO $receipt$
BEGIN
 IF (SELECT count(*) FROM public.context_scorecard_receipts) <> (SELECT n FROM pg_temp.hourly_receipts_before) + 1 THEN
  RAISE EXCEPTION 'desk check: expected exactly 1 new receipt';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_stat_xact_user_tables s
            WHERE s.n_tup_ins + s.n_tup_upd + s.n_tup_del > 0 AND s.schemaname !~ '^pg_temp'
              AND s.schemaname || '.' || s.relname <> 'public.context_scorecard_receipts') THEN
  RAISE EXCEPTION 'desk check: wrote outside the receipts';
 END IF;
END $receipt$;
SELECT s->'lane'->>'status' AS lane_after, s->'report'->'receipt' AS receipt_after
FROM (SELECT public.context_scorecard_run_status() AS s) x;
ROLLBACK;
