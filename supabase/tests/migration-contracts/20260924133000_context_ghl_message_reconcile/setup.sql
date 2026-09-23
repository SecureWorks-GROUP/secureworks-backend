-- C1d setup: the two live tables the status block reads that no earlier
-- registered fixture creates, in their live production shape as read on
-- 23 Sep 2026 (information_schema, read-only):
--   webhook_log(id uuid, org_id uuid, source text, event_type text, payload jsonb,
--               status text, error_message text, created_at timestamptz)
--   feature_flags(id uuid, flag_name text, enabled boolean, description text,
--                 updated_at timestamptz)
-- No row is seeded: production has no ghl_message_capture_v2 row.
-- And a check that the fixtures leave exactly production's pre-image of the two
-- functions this migration replaces.
CREATE TABLE IF NOT EXISTS public.webhook_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 source text NOT NULL,
 event_type text,
 payload jsonb,
 status text DEFAULT 'received',
 error_message text,
 created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_log_source ON public.webhook_log(source);
CREATE INDEX IF NOT EXISTS idx_webhook_log_created ON public.webhook_log(created_at);
CREATE TABLE IF NOT EXISTS public.feature_flags (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 flag_name text NOT NULL UNIQUE,
 enabled boolean NOT NULL DEFAULT false,
 description text,
 updated_at timestamptz DEFAULT now()
);

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_ghl_capture_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 'c1d setup: context_ghl_capture_status is not the production F1 stub'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM 'e67b1b27f41133154915f3666421f475'
 THEN RAISE EXCEPTION 'c1d setup: automation_switch_cron_lanes is not the production body'; END IF;
END $$;
