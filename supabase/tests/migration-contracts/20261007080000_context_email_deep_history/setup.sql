-- History depth PR B setup. Earlier registered fixtures supply feature_flags,
-- monitored_mailboxes (EM1, 11 selected sources), context_capture_runs (F1b),
-- jobs, business_events, job_documents, job_events, xero_invoices,
-- job_assignments, the email reader (EM2/EM3), B-1 and W7's plan
-- (20261006030000) and B-5's lane list (20261005210000). Prove the starting
-- point is production's on 7 Oct 2026: B-5's lane list body, W7's plan, and
-- none of this migration's objects or its flag.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM '99e6d70e80a79e548f2478b65fc6cd78'
 THEN RAISE EXCEPTION 'deep history setup: automation_switch_cron_lanes is not the 20261005210000 body'; END IF;
 IF to_regclass('public.context_email_history_plan') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_email_history_plan'::regclass AND attname='posts_since_progress' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'deep history setup: W7''s plan is missing'; END IF;
 IF to_regclass('public.context_email_deep_plan') IS NOT NULL OR to_regprocedure('public.trigger_context_email_deep_history()') IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_deep_v1')
 THEN RAISE EXCEPTION 'deep history setup: the deep load already exists'; END IF;
 IF (SELECT count(*) FROM public.monitored_mailboxes WHERE enabled AND status='active' AND kind IN ('user','group'))<>11
 THEN RAISE EXCEPTION 'deep history setup: expected the 11 selected sources of EM1'; END IF;
END $$;
