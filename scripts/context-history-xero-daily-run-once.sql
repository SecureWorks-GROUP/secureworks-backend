-- One Xero history top-up now (migration 20261007050000), instead of waiting
-- for the cron job's next run at 03:30 Perth. Pair with
-- scripts/context-history-xero-daily-undo.sql.
--
-- Not run by its author. A live-data WRITE, guarded:
--  - it refuses unless exactly :expected_missing rows are missing from
--    context_xero_evidence_backfill_plan() when it runs (read that number
--    first with scripts/context-history-daily-check.sql, section 3);
--  - it refuses unless the run wrote exactly that many rows and left none;
--  - as written it ends in ROLLBACK: a dry run that changes nothing. Change
--    the last line to COMMIT only with the owner's go.
-- What it writes: the missing raised, authorised and paid evidence rows of live
-- jobs' sales invoices (source xero-history, capture_mode backfill, through
-- capture_business_event), and one context_capture_runs row
-- (xero_history_daily) whose cursor names every key written. It sends nothing,
-- moves no money and changes no job.
-- Undo: scripts/context-history-xero-daily-undo.sql -v run_id=<the run_id below>.
--
-- Usage (as the database owner, who alone may call the cron caller):
--   psql "$DB" -v expected_missing=14 -f scripts/context-history-xero-daily-run-once.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT set_config('hd.expected_missing', :'expected_missing', true) AS expected_missing;

-- Guard 1: exactly the number of missing rows the operator read.
DO $$
DECLARE want integer := current_setting('hd.expected_missing')::integer; got integer;
BEGIN
 SELECT count(*) INTO got FROM public.context_xero_evidence_backfill_plan();
 IF got IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'xero run-once refused: % rows are missing, expected %; nothing written', got, want;
 END IF;
END $$;

-- The write: one run of the daily top-up.
SELECT set_config('hd.run', public.trigger_xero_history_daily()::text, true) IS NOT NULL AS ran;

-- Guard 2: it ran, wrote exactly that many rows, named each one, and left none.
DO $$
DECLARE r jsonb := current_setting('hd.run')::jsonb; want integer := current_setting('hd.expected_missing')::integer;
BEGIN
 IF r->>'outcome' IS DISTINCT FROM 'ran' OR r->>'status' IS DISTINCT FROM 'succeeded'
  OR (r->'counts'->>'inserted')::integer IS DISTINCT FROM want OR (r->'counts'->>'written_keys')::integer IS DISTINCT FROM want
  OR (r->'counts'->>'missing_after')::integer IS DISTINCT FROM 0 THEN
  RAISE EXCEPTION 'xero run-once: unexpected result (outcome %, status %, inserted %, written_keys %, missing_after %); rolled back',
   r->>'outcome', r->>'status', r->'counts'->>'inserted', r->'counts'->>'written_keys', r->'counts'->>'missing_after';
 END IF;
END $$;

SELECT current_setting('hd.run')::jsonb->>'run_id' AS run_id,
 (current_setting('hd.run')::jsonb->'counts'->>'inserted')::integer AS rows_written,
 (SELECT count(*) FROM public.context_xero_evidence_backfill_plan()) AS rows_still_missing;

ROLLBACK;
