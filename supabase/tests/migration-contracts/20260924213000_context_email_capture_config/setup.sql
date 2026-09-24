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

-- The live T7 draft monitored_mailboxes (ledger 20260503063735), as read from
-- production 24 Sep 2026: its 17 columns, generated check names, unique email,
-- RLS with policies service_role_all and authenticated_select, Supabase's
-- default grants to anon and authenticated, and no rows.
CREATE TABLE IF NOT EXISTS public.monitored_mailboxes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid,
 email text NOT NULL UNIQUE,
 display_name text,
 scope_label text NOT NULL CHECK (scope_label IN ('owner','admin','finance','sales','patios','fencing','ops','other')),
 enabled boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','discovered_in_code','pending_review')),
 poll_interval_seconds integer NOT NULL DEFAULT 300 CHECK (poll_interval_seconds BETWEEN 60 AND 3600),
 privacy_classification text NOT NULL DEFAULT 'staff_only' CHECK (privacy_classification IN ('internal','client_safe','staff_only','restricted_pii')),
 graph_subscription_id text,
 graph_app_credential_id text,
 last_polled_at timestamptz,
 last_message_at timestamptz,
 last_error text,
 last_error_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monitored_mailboxes_enabled ON public.monitored_mailboxes(enabled,last_polled_at) WHERE enabled=true;
ALTER TABLE public.monitored_mailboxes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.monitored_mailboxes;
CREATE POLICY service_role_all ON public.monitored_mailboxes FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS authenticated_select ON public.monitored_mailboxes;
CREATE POLICY authenticated_select ON public.monitored_mailboxes FOR SELECT TO authenticated USING (true);
GRANT ALL ON TABLE public.monitored_mailboxes TO anon,authenticated,service_role;

-- Prove the fixtures leave exactly the pre-image the migration's guard pins:
-- F1b's stub for the email block, the empty draft table, no other email
-- capture object, no flag row.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_email_capture_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 'em1 setup: context_email_capture_status() is not the production F1b stub'; END IF;
 IF to_regclass('public.monitored_mailbox_changes') IS NOT NULL
  OR to_regprocedure('public.set_monitored_mailbox(text,boolean,text,text,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'em1 setup: a new object already exists'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_capture_v2')
 THEN RAISE EXCEPTION 'em1 setup: email_capture_v2 flag row already exists'; END IF;
END $$;
