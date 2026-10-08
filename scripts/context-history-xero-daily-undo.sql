-- Undo ONE run of the daily Xero history top-up (migration 20261007050000):
-- retract, never delete, the Xero evidence rows that run wrote, exactly as its
-- run row's cursor names them (cursor.written_keys).
--
-- Not run by its author. A live-data WRITE, guarded:
--  - it refuses unless :run_id is a finished xero_history_daily run whose
--    cursor names as many keys as its counts say it wrote;
--  - it refuses unless every one of those rows is still a live (not
--    retracted) xero-history row, so a row changed since is never touched;
--  - it refuses unless it retracts exactly that many rows;
--  - as written it ends in ROLLBACK: a dry run that changes nothing. Change
--    the last line to COMMIT only with the owner's go.
-- Retracted, not deleted: a retracted row is evidence no reader admits from
-- then on (the ledger's admission refuses it), and the daily top-up never
-- writes its key again. The row stays as the record of what was read.
-- Undo of this undo (put the rows back): the redo statement at the end,
-- guarded the same way.
--
-- Usage: psql "$DB" -v run_id=<uuid> -f scripts/context-history-xero-daily-undo.sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT set_config('hd.run_id', :'run_id', true) AS run_id;

DO $$
DECLARE v_run uuid := current_setting('hd.run_id')::uuid; r record; keys text[]; n_live integer; n_done integer;
BEGIN
 SELECT c.id, c.source, c.status, c.counts, c.cursor INTO r FROM public.context_capture_runs c WHERE c.id = v_run;
 IF NOT FOUND OR r.source <> 'xero_history_daily' OR r.status = 'running' THEN
  RAISE EXCEPTION 'xero undo refused: % is not a finished xero_history_daily run', v_run;
 END IF;
 keys := ARRAY(SELECT jsonb_array_elements_text(coalesce(r.cursor->'written_keys', '[]'::jsonb)));
 IF cardinality(keys) IS DISTINCT FROM (r.counts->>'written_keys')::integer THEN
  RAISE EXCEPTION 'xero undo refused: the run names % keys, its counts say %', cardinality(keys), r.counts->>'written_keys';
 END IF;
 SELECT count(*) INTO n_live FROM public.business_events b
 WHERE b.provider_message_id = ANY (keys) AND b.source = 'xero-history' AND coalesce(b.metadata->>'retracted', '') <> 'true';
 IF n_live <> cardinality(keys) THEN
  RAISE EXCEPTION 'xero undo refused: % of the run''s % rows are live xero-history rows (changed since)', n_live, cardinality(keys);
 END IF;
 UPDATE public.business_events b SET metadata = b.metadata || jsonb_build_object('retracted', true, 'retracted_at', clock_timestamp(),
  'retracted_by', 'context-history-xero-daily-undo', 'retracted_run_id', v_run::text)
 WHERE b.provider_message_id = ANY (keys) AND b.source = 'xero-history' AND coalesce(b.metadata->>'retracted', '') <> 'true';
 GET DIAGNOSTICS n_done = ROW_COUNT;
 IF n_done <> cardinality(keys) THEN RAISE EXCEPTION 'xero undo: retracted %, expected %; rolled back', n_done, cardinality(keys); END IF;
 RAISE NOTICE 'xero undo: retracted % rows of run %', n_done, v_run;
END $$;

-- Redo (put the rows back), when wanted instead of the block above: in its own
-- transaction, the same guard shape, removing the four keys this undo added.
--   UPDATE public.business_events b
--   SET metadata = b.metadata - 'retracted' - 'retracted_at' - 'retracted_by' - 'retracted_run_id'
--   WHERE b.source = 'xero-history' AND b.metadata->>'retracted_by' = 'context-history-xero-daily-undo'
--    AND b.metadata->>'retracted_run_id' = current_setting('hd.run_id');

ROLLBACK;
