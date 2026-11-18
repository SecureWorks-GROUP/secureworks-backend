BEGIN;
DO $rollback$ BEGIN
 IF md5(pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true))<>'c98dd14a51e982b78493c3385b25c9d9'
 OR to_regprocedure('public.install_dispatch_order_commitment()') IS NOT NULL
 OR to_regprocedure('public.remove_dispatch_order_commitment()') IS NOT NULL
 OR to_regprocedure('public.dispatch_order_commitment_trg()') IS NOT NULL
 OR to_regprocedure('public.dispatch_order_rematch_subjects(uuid,text,text)') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='dispatch_order_commitment')
 OR to_regclass('public.v_job_orders') IS NULL THEN
  RAISE EXCEPTION 'P2-10.2 rollback must restore main reader and remove new functions'; END IF;
END $rollback$;
SELECT 'PASS P2-10.2 rollback: main reader restored, trigger and functions removed';
ROLLBACK;
