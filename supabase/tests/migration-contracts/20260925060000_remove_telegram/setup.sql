-- Pre-image for 20260925060000_remove_telegram, as read from production
-- (read-only) on 25 Sep 2026. Each CHECK below reproduces the production
-- md5(pg_get_constraintdef) the migration pins, and v_evidence_health
-- reproduces the production md5(pg_get_viewdef) d5cccec9e949e15d4998587e1f7a223a.
-- Tables that are live drift carry only the columns the migration touches.

-- Production's business_events_channel_check is validated; the earlier fixture
-- added it NOT VALID.
ALTER TABLE public.business_events VALIDATE CONSTRAINT business_events_channel_check;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS telegram_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_username text;
ALTER TABLE public.users ADD CONSTRAINT users_telegram_id_key UNIQUE (telegram_id);
CREATE UNIQUE INDEX idx_users_telegram ON public.users USING btree (telegram_id) WHERE (telegram_id IS NOT NULL);

ALTER TABLE public.inbox_events ADD COLUMN IF NOT EXISTS telegram_notified boolean DEFAULT false;

CREATE TABLE public.staff_agent_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text,
  telegram_user_id bigint NOT NULL,
  CONSTRAINT staff_agent_preferences_telegram_user_id_key UNIQUE (telegram_user_id)
);
CREATE INDEX idx_staff_prefs_telegram ON public.staff_agent_preferences USING btree (telegram_user_id);

CREATE TABLE public.agent_memory_log (
  id bigserial PRIMARY KEY,
  channel text NOT NULL DEFAULT 'system'
    CONSTRAINT agent_memory_log_channel_check CHECK (channel IN ('telegram','web','api','system','cron'))
);
CREATE TABLE public.authority_levels (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  channel text NOT NULL
    CONSTRAINT authority_levels_channel_check CHECK (channel IN ('telegram','web','api','system','cron'))
);
CREATE TABLE public.intention_log (
  id bigserial PRIMARY KEY,
  channel text NOT NULL
    CONSTRAINT intention_log_channel_check CHECK (channel IN ('telegram','web','api','system','cron'))
);
CREATE TABLE public.communications_log (
  id bigserial PRIMARY KEY,
  channel text NOT NULL
    CONSTRAINT communications_log_channel_check CHECK (channel IN ('telegram','email','sms','web','whatsapp'))
);
CREATE TABLE public.pending_entity_matches (
  id bigserial PRIMARY KEY,
  source_channel text NOT NULL
    CONSTRAINT pending_entity_matches_source_channel_check CHECK (source_channel IN ('telegram','email','sms','web','system'))
);
CREATE TABLE public.entity_observations (
  id bigserial PRIMARY KEY,
  source_channel text NOT NULL
    CONSTRAINT entity_observations_source_channel_check CHECK (source_channel IN ('telegram','web','api','system','manual'))
);
CREATE TABLE public.corrections (
  id bigserial PRIMARY KEY,
  corrected_via text NOT NULL DEFAULT 'telegram'
    CONSTRAINT corrections_corrected_via_check CHECK (corrected_via IN ('telegram','web','api','system'))
);
CREATE TABLE public.commitments (
  id bigserial PRIMARY KEY,
  source_channel text NOT NULL DEFAULT 'telegram'
    CONSTRAINT commitments_source_channel_check CHECK (source_channel IN ('telegram','web','api','system'))
);

CREATE TABLE public.smart_nudges (
  id bigserial PRIMARY KEY,
  title text,
  channel text DEFAULT 'telegram'
);
-- Production: every row is telegram (1650 at the read); the fixture uses 5.
INSERT INTO public.smart_nudges (title) SELECT 'nudge ' || g FROM generate_series(1, 5) AS g;
CREATE TABLE public.conversation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  channel text NOT NULL DEFAULT 'telegram'
);
INSERT INTO public.conversation_sessions (user_id, channel) VALUES ('fixture', 'dashboard');
CREATE TABLE public.conversation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  channel text NOT NULL DEFAULT 'telegram'
);
CREATE TABLE public.pending_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text,
  channel text DEFAULT 'telegram_dm'
);

-- Production held 13 telegram rows out of 47.
INSERT INTO public.authority_levels (action, channel)
SELECT 'fixture_' || g, 'telegram' FROM generate_series(1, 13) AS g;
INSERT INTO public.authority_levels (action, channel)
SELECT 'fixture_web_' || g, 'web' FROM generate_series(1, 34) AS g;

CREATE TABLE public.action_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  action_type text NOT NULL,
  risk_level text,
  autonomy_level text,
  description text
);
INSERT INTO public.action_permissions (org_id, action_type, risk_level, autonomy_level, description) VALUES
  ('00000000-0000-0000-0000-000000000001', 'send_telegram', 'low', 'approve', 'Must be human-approved'),
  ('00000000-0000-0000-0000-000000000001', 'add_ghl_note', 'low', 'approve', 'Must be human-approved');

-- Stand-in with the production signature, result and delivery target; the
-- production body (md5 60d6ad1c4f30eb9fc424817a3a97d080) is not reproduced.
CREATE FUNCTION public.deliver_proposed_actions() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  -- fixture: production posted pending actions to functions/v1/telegram-bot
  RETURN jsonb_build_object('delivered', 0);
END
$fn$;
GRANT EXECUTE ON FUNCTION public.deliver_proposed_actions() TO PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.trigger_daily_digest() RETURNS void LANGUAGE sql AS $fn$ SELECT $fn$;
COMMENT ON FUNCTION public.trigger_daily_digest() IS 'Fire daily digest + Telegram morning brief. Usage: SELECT trigger_daily_digest();';

CREATE VIEW public.v_evidence_health AS SELECT COALESCE(channel,'_legacy_no_channel') AS channel, COALESCE(direction,'_legacy_no_direction') AS direction, COALESCE(source_table,'_legacy_no_source_table') AS source_table, count(*) AS rows_30d, count(*) FILTER (WHERE job_id IS NULL) AS missing_job, count(*) FILTER (WHERE contact_id IS NULL) AS missing_contact, count(*) FILTER (WHERE channel IS NULL OR direction IS NULL OR source_table IS NULL OR source_id IS NULL) AS missing_envelope, count(*) FILTER (WHERE body_preview IS NULL AND channel = ANY (ARRAY['email','sms','call','telegram','note'])) AS comms_missing_preview, count(*) FILTER (WHERE body_preview IS NOT NULL AND char_length(body_preview) >= 500 AND body_pointer IS NULL) AS preview_truncated_no_pointer, count(*) FILTER (WHERE match_status='matched') AS matched, count(*) FILTER (WHERE match_status='ambiguous') AS ambiguous, count(*) FILTER (WHERE match_status='unresolved') AS unresolved, count(*) FILTER (WHERE match_status='ignored') AS ignored, count(*) FILTER (WHERE match_status IS NULL) AS no_match_status, max(occurred_at) AS last_event_at, min(occurred_at) AS first_event_at FROM business_events WHERE occurred_at > now() - '30 days'::interval GROUP BY 1,2,3 ORDER BY 1,2,3;
-- Production ACL: {postgres=arwdDxtm, anon=awdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}.
REVOKE ALL ON public.v_evidence_health FROM PUBLIC;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.v_evidence_health TO anon;
GRANT ALL ON public.v_evidence_health TO authenticated, service_role;

-- The fixture must match the pinned production fingerprints exactly.
DO $$
DECLARE r record;
BEGIN
  IF md5(pg_get_viewdef('public.v_evidence_health'::regclass)) <> 'd5cccec9e949e15d4998587e1f7a223a' THEN
    RAISE EXCEPTION 'remove_telegram setup: v_evidence_health does not reproduce the production view';
  END IF;
  FOR r IN SELECT conname, md5(pg_get_constraintdef(oid)) AS m FROM pg_constraint
           WHERE contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%telegram%'
  LOOP
    IF r.m NOT IN ('da2449459d9104b26380b5928ee0efea', 'dffd6fa669fe2db79a7af7fdb72f2327',
                   'e23672f7c0d4834bae5c048e548776b3', '9f540bb62a07f928090b15e4d7719472',
                   'b2c78cccb3837eb42b90f5fe98a842d6', 'feb44cbefce2820f8d60d8c45717aa40',
                   '26e27300bd074bf0969ebb480bb3be04') THEN
      RAISE EXCEPTION 'remove_telegram setup: % does not reproduce production (md5 %)', r.conname, r.m;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%telegram%') <> 9 THEN
    RAISE EXCEPTION 'remove_telegram setup: expected 9 telegram CHECK constraints';
  END IF;
END
$$;
