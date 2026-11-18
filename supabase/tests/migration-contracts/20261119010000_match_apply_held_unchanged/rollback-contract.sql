\set ON_ERROR_STOP on
BEGIN;
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure)
     <> 'b011ec334de5208fffc613e5f6fe7fc9' THEN RAISE EXCEPTION 'failed: rollback restores main''s match_apply'; END IF;
  IF to_regprocedure('public.match_clues_unchanged(text,text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'failed: rollback drops the helper'; END IF;
  IF to_regprocedure('public.match_bill_read(text,jsonb)') IS NOT NULL OR to_regclass('public.match_slow_bills') IS NOT NULL THEN
    RAISE EXCEPTION 'failed: rollback drops the read function and the slow-bills table'; END IF;
  IF NOT has_function_privilege('service_role','public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)','execute')
     OR has_function_privilege('authenticated','public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)','execute') THEN
    RAISE EXCEPTION 'failed: rollback keeps match_apply grants'; END IF;
END $check$;
-- The down runs again cleanly on main's body.
\ir ../../../rollbacks/20261119010000_match_apply_held_unchanged_down.sql
SELECT 'PASS P2-02.8 rollback';
ROLLBACK;
