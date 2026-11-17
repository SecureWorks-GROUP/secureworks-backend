BEGIN;
DO $rollback$ BEGIN
 IF to_regclass('public.reconcile_items') IS NOT NULL
 OR to_regclass('public.reconcile_decisions') IS NOT NULL
 OR to_regclass('public.reconcile_item_kinds') IS NOT NULL
 OR to_regprocedure('public.reconcile_decisions_append_only()') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.job_cost_lines'::regclass AND conname='job_cost_lines_decision_fk')
 OR md5(pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true))<>'d8ccd9fe8847bbcb735baa871f08fd70' THEN
  RAISE EXCEPTION 'P2-03.1 rollback must restore original line reader and remove new schema'; END IF;
END $rollback$;
SELECT 'PASS P2-03.1 rollback: original line reader restored, new schema removed';
ROLLBACK;
