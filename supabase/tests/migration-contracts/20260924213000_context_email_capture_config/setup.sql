-- EM1 setup. Earlier registered fixtures supply business_events, inbox_events
-- (reduced shape), feature_flags (C1d, live shape), context_capture_runs and
-- record_capture_run() (F1, F1b), automation_lane_enabled() and F1b's composer
-- with the email_capture stub.
--
-- Adds the live inbox_events columns the contract touches and the live access
-- rule. No row is seeded here: an earlier contract reads the first
-- inbox_events row it finds, so fixture rows live inside this case's contract.
ALTER TABLE public.inbox_events
 ADD COLUMN IF NOT EXISTS graph_message_id text,
 ADD COLUMN IF NOT EXISTS mailbox text,
 ADD COLUMN IF NOT EXISTS subject text;
-- Live access rule (20260405000003_inbox_events.sql): RLS on, service role only.
ALTER TABLE public.inbox_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.inbox_events;
CREATE POLICY service_role_all ON public.inbox_events FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Prove the fixtures leave exactly the pre-image the migration's guard pins:
-- F1b's stub for the email block, no email capture objects, no flag row.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_email_capture_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 'em1 setup: context_email_capture_status() is not the production F1b stub'; END IF;
 IF to_regclass('public.monitored_mailboxes') IS NOT NULL OR to_regclass('public.monitored_mailbox_changes') IS NOT NULL
  OR to_regprocedure('public.set_monitored_mailbox(text,boolean,text,text,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'em1 setup: a new object already exists'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_capture_v2')
 THEN RAISE EXCEPTION 'em1 setup: email_capture_v2 flag row already exists'; END IF;
END $$;
