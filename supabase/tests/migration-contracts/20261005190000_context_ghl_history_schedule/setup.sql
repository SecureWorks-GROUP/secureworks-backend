-- B-2 setup: every table and function this migration reads, calls or replaces
-- already exists from earlier registered fixtures (M4's history load and link
-- action, the catch-up list with the backlog writer's mode and scope, the
-- extraction runs and receipts, the cron lane list). Nothing to add; this
-- checks the bodies it replaces are the repository ones it was built on.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_ghl_history_due(integer)')) IS DISTINCT FROM 'a52b2ffa5db7ca748e1d1069ec97da00'
 THEN RAISE EXCEPTION 'b2 setup: context_ghl_history_due is not the M4 body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.reserve_ghl_history_run(integer,text)')) IS DISTINCT FROM 'dc0848e3b103f0e5c8a9a3947bebc154'
 THEN RAISE EXCEPTION 'b2 setup: reserve_ghl_history_run is not the M4 body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM '5c1e0e526a74d5b4ad612792c7f076cc'
 THEN RAISE EXCEPTION 'b2 setup: automation_switch_cron_lanes is not the 20261002150000 body'; END IF;
END $$;
