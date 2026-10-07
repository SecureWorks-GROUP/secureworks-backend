-- History daily (20261007050000) setup: every table, column and function this
-- migration reads, calls or replaces already exists from earlier registered
-- fixtures (M4's history load and link record, B-2's link attempts, B-4's Xero
-- evidence writer, the job record's stage stamps, job events and bookings).
-- Nothing to add. This checks the two bodies it replaces are the ones it was
-- built on (the live production bodies, read 7 Oct 2026).
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_ghl_history_live_jobs()')) IS DISTINCT FROM '49eb23015b724a29058c11b2743954bf'
 THEN RAISE EXCEPTION 'history daily setup: context_ghl_history_live_jobs is not the M4 body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM '99e6d70e80a79e548f2478b65fc6cd78'
 THEN RAISE EXCEPTION 'history daily setup: automation_switch_cron_lanes is not the 20261005210000 body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_xero_evidence_backfill(boolean,integer)')) IS DISTINCT FROM 'eb9a51fc91bb4341e4a56b4e65552aae'
 THEN RAISE EXCEPTION 'history daily setup: context_xero_evidence_backfill is not the B-4 body'; END IF;
END $$;
