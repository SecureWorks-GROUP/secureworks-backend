-- Debt Workshop (secureworks-wiki coding/capabilities/debt-follow-up/debt-workshop-spec.md,
-- section 7). Captain: Shaun, approved 2026-10-08. The code that reads and writes these
-- tables is ops-api/debt_ws_*.ts; docs/debt-workshop/README.md explains the switches.
--
-- 1. debt_ws_settings: one row (id = 1). Every switch defaults OFF, so applying this
--    migration and deploying the code sends nothing:
--      tab_visible          the Debt tab shows on the ops dashboard
--      sending_enabled      half of the sending switch (the other half is the env
--                           DEBT_WS_SENDING_ENABLED, which must be exactly "true")
--      agent_enabled        the agent queue hands out work
--      auto_send_steps      stage 5 auto-send per step, e.g. {"d1": true}; also needs
--                           env DEBT_WS_AUTO_SEND_ENABLED = "true" and sending on
--      jan_list_auto_send   the Friday lock and the Sunday text to Jan
--    owner_user_ids is copied from debt_desk_settings when that table has a non-empty
--    list, else seeded with Shaun's users.id. Never a role: several users hold
--    ops_manager. not_chased_contacts and statement_emails are seeded from the spec.
--    One builder can sit on several Xero contacts, so companies are grouped by a
--    canonical Xero contact id: company_aliases maps each extra contact id to it
--    (seeded for Major Loss Builders, Western Building and Builderwest), and
--    statement_emails is keyed by the canonical id (a contact name key is only a
--    fallback). not_chased_contacts holds names or contact ids.
-- 2. debt_ws_log: what was done and noted per invoice (share) or company.
-- 3. debt_ws_suggestions: agent or template output waiting for Shaun.
-- 4. debt_ws_states: per share; says paid, a promise pause, the agent's last review, and
--    a cache of the Xero online-invoice link (pay_link, an addition to the spec).
-- 5. debt_ws_sends: the claim. One sending-or-sent row per share, cycle and step, so a
--    step is never texted twice.
-- 6. debt_ws_statements: one sending-or-sent statement per company per week. 'sending'
--    is an addition to the spec's statuses: the claim written before the email goes.
-- 7. debt_ws_jan_lists: one row per visit Monday. 'sending' is an addition to the spec's
--    statuses: the claim written before the text to Jan goes.
-- 8. Row-level security on every table, service role only, like payment_chase_logs.
--    The browser goes through ops-api.
-- 9. pg_cron (Perth is UTC+8, no daylight saving): Friday 09:00 Perth (01:00 UTC
--    Friday) posts debt_ws_jan_list_lock and Sunday 19:00 Perth (11:00 UTC Sunday) posts
--    debt_ws_jan_list_send to ops-api with the service key, like
--    20260911060000_ses_report_trigger_runs.sql. Each trigger returns without a call
--    unless debt_ws_settings.jan_list_auto_send is true, and ops-api checks again
--    (the send also needs sending effectively on). Skipped where pg_cron is absent.
--
-- Re-applying is a no-op and keeps a changed settings row.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Settings
CREATE TABLE IF NOT EXISTS public.debt_ws_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  owner_user_ids uuid[] NOT NULL DEFAULT '{}',
  tab_visible boolean NOT NULL DEFAULT false,
  sending_enabled boolean NOT NULL DEFAULT false,
  agent_enabled boolean NOT NULL DEFAULT false,
  auto_send_steps jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(auto_send_steps) = 'object'),
  jan_list_auto_send boolean NOT NULL DEFAULT false,
  not_chased_contacts text[] NOT NULL DEFAULT '{}',
  statement_emails jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(statement_emails) = 'object'),
  company_aliases jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(company_aliases) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Tolerate a partly created table from an earlier draft of this migration: make sure
-- the later columns exist before the seed below references them.
ALTER TABLE public.debt_ws_settings
  ADD COLUMN IF NOT EXISTS statement_emails jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS company_aliases jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE
  v_owners uuid[];
BEGIN
  IF to_regclass('public.debt_desk_settings') IS NOT NULL THEN
    EXECUTE 'SELECT owner_user_ids FROM public.debt_desk_settings WHERE id = 1'
      INTO v_owners;
  END IF;
  IF v_owners IS NULL OR cardinality(v_owners) = 0 THEN
    v_owners := ARRAY['9913309f-35ae-4a71-8e1f-f704ecc526ea']::uuid[];
  END IF;
  INSERT INTO public.debt_ws_settings (
    id, owner_user_ids, not_chased_contacts, statement_emails, company_aliases,
    updated_by
  ) VALUES (
    1,
    v_owners,
    -- Names, plus the contact ids (Emergency Trade Services; Builderwest's canonical id,
    -- which covers its alias contact too).
    ARRAY[
      'Emergency Trade Services', 'Builderwest',
      'd3d81d78-1f5e-450f-9852-ab6c2e1c9bc8',
      'c3a479ce-20c4-43fe-b893-bbcacfeb417e'
    ],
    -- Keyed by the canonical Xero contact id: Major Loss Builders, AJ Building &
    -- Restoration.
    jsonb_build_object(
      '96abb9b3-89d5-4021-8880-ce9e8c4f1a91', 'accounts@mlbuilders.com.au',
      '71a5e645-3ef7-4946-9926-470dcd78979d', 'accounts@ajs.build'
    ),
    -- Extra contact id -> canonical contact id: MLB ("ML Builders"), Western
    -- Building, Builderwest.
    jsonb_build_object(
      '4d7121e3-b324-4566-9552-96d6add93f58', '96abb9b3-89d5-4021-8880-ce9e8c4f1a91',
      '2a34b09f-ed34-4b26-9ad0-f59bd9d3b264', '29d70cdc-8ba1-4a21-ba9a-ade6374e987b',
      'aff63429-b473-4c46-bfaa-40c2678b3ae0', 'c3a479ce-20c4-43fe-b893-bbcacfeb417e'
    ),
    'migration 20261008170000_debt_workshop'
  )
  ON CONFLICT (id) DO NOTHING;
END $$;

COMMENT ON TABLE public.debt_ws_settings IS
  'Debt Workshop switches, one row. Everything defaults off. Effective sending = env DEBT_WS_SENDING_ENABLED = "true" AND sending_enabled. owner_user_ids (users.id) may send, approve statements, link contacts and move cards; env DEBT_WS_OWNER_USER_IDS overrides it. See docs/debt-workshop/README.md.';
COMMENT ON COLUMN public.debt_ws_settings.company_aliases IS
  'Extra Xero contact id -> canonical Xero contact id, so one builder on several Xero contacts is one company (one statement, one company_key).';
COMMENT ON COLUMN public.debt_ws_settings.statement_emails IS
  'Canonical Xero contact id -> accounts email for the Monday statement. A contact-name key is a fallback only.';

-- 2. The log
CREATE TABLE IF NOT EXISTS public.debt_ws_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  share_key text NOT NULL CHECK (length(share_key) BETWEEN 1 AND 200),
  xero_invoice_ids text[] NOT NULL DEFAULT '{}',
  job_id uuid,
  kind text NOT NULL CHECK (kind IN (
    'note', 'text_sent', 'email_sent', 'call', 'statement_sent', 'jan_list',
    'category_change', 'promise', 'link_contact', 'agent_flag', 'send_refused',
    'skip'
  )),
  step text,
  body text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_debt_ws_log_share
  ON public.debt_ws_log (org_id, share_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_debt_ws_log_job
  ON public.debt_ws_log (job_id, created_at DESC) WHERE job_id IS NOT NULL;
COMMENT ON TABLE public.debt_ws_log IS
  'Debt Workshop: what was done and noted per invoice (share_key = Xero invoice id) or company (share_key = Xero contact id). Written by ops-api debt_ws_* only.';

-- 3. Suggestions
CREATE TABLE IF NOT EXISTS public.debt_ws_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  share_key text NOT NULL,
  xero_invoice_ids text[] NOT NULL DEFAULT '{}',
  job_id uuid,
  cycle_start date,
  step text,
  kind text NOT NULL CHECK (kind IN ('draft', 'move', 'flag')),
  channel text CHECK (channel IS NULL OR channel IN ('sms', 'email')),
  text text,
  why text,
  proposed_category text
    CHECK (proposed_category IS NULL OR proposed_category IN ('says_paid', 'rectification')),
  amount numeric(12, 2),
  source text NOT NULL CHECK (source IN ('agent', 'template')),
  agent_version text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sent', 'skipped', 'superseded', 'accepted', 'dismissed'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text
);
CREATE INDEX IF NOT EXISTS idx_debt_ws_suggestions_share
  ON public.debt_ws_suggestions (org_id, share_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_debt_ws_suggestions_pending
  ON public.debt_ws_suggestions (org_id, share_key) WHERE status = 'pending';
COMMENT ON TABLE public.debt_ws_suggestions IS
  'Debt Workshop: agent suggestions (draft, move, flag) waiting for Shaun. A new pending draft or move supersedes older pending drafts and moves on the share; flags stay until dismissed.';

-- 4. States
CREATE TABLE IF NOT EXISTS public.debt_ws_states (
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  share_key text NOT NULL,
  says_paid_since date,
  paused_until date,
  agent_reviewed_at timestamptz,
  pay_link text,
  pay_link_read_at timestamptz,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (org_id, share_key)
);
COMMENT ON TABLE public.debt_ws_states IS
  'Debt Workshop per share: says_paid_since (Says paid category), paused_until (a promise to pay pauses the steps), agent_reviewed_at, and pay_link (cached Xero online-invoice URL).';

-- 5. Sends (the claim)
CREATE TABLE IF NOT EXISTS public.debt_ws_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  share_key text NOT NULL,
  cycle_start date NOT NULL,
  step text NOT NULL,
  suggestion_id uuid REFERENCES public.debt_ws_suggestions (id),
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'refused')),
  provider_message_id text,
  error text,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_ws_sends_claim
  ON public.debt_ws_sends (share_key, cycle_start, step)
  WHERE status IN ('sending', 'sent');
CREATE INDEX IF NOT EXISTS idx_debt_ws_sends_share
  ON public.debt_ws_sends (org_id, share_key);
COMMENT ON TABLE public.debt_ws_sends IS
  'Debt Workshop send claims. A row is written as sending before the text goes; one sending-or-sent row per share, cycle and step (idx_debt_ws_sends_claim), so a step is never texted twice. refused releases the claim (nothing went); a send that is not confirmed stays sending.';

-- 6. Statements
CREATE TABLE IF NOT EXISTS public.debt_ws_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  company_key text NOT NULL,
  week_start date NOT NULL,
  xero_invoice_ids text[] NOT NULL DEFAULT '{}',
  total numeric(12, 2),
  to_email text,
  html text,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'refused')),
  approved_by text,
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_ws_statements_week
  ON public.debt_ws_statements (company_key, week_start)
  WHERE status IN ('sending', 'sent');
COMMENT ON TABLE public.debt_ws_statements IS
  'Debt Workshop company statements (company_key = Xero contact id). One sending-or-sent statement per company per Monday-to-Sunday Perth week. HTML only, with Xero online-invoice links; never a PDF.';

-- 7. Jan's visit lists
CREATE TABLE IF NOT EXISTS public.debt_ws_jan_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_date date NOT NULL UNIQUE,
  items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  removed_share_keys text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'locked', 'sending', 'sent', 'failed', 'skipped'
  )),
  locked_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.debt_ws_jan_lists IS
  'Debt Workshop: Jan''s visit list per visit Monday. Locked Friday 09:00 Perth, texted to Jan Sunday 19:00 Perth (only while jan_list_auto_send and sending are on).';

-- 8. Row-level security: service role only.
ALTER TABLE public.debt_ws_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debt_ws_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debt_ws_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debt_ws_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debt_ws_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debt_ws_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debt_ws_jan_lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS debt_ws_settings_service_role_all ON public.debt_ws_settings;
CREATE POLICY debt_ws_settings_service_role_all ON public.debt_ws_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS debt_ws_log_service_role_all ON public.debt_ws_log;
CREATE POLICY debt_ws_log_service_role_all ON public.debt_ws_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS debt_ws_suggestions_service_role_all ON public.debt_ws_suggestions;
CREATE POLICY debt_ws_suggestions_service_role_all ON public.debt_ws_suggestions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS debt_ws_states_service_role_all ON public.debt_ws_states;
CREATE POLICY debt_ws_states_service_role_all ON public.debt_ws_states
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS debt_ws_sends_service_role_all ON public.debt_ws_sends;
CREATE POLICY debt_ws_sends_service_role_all ON public.debt_ws_sends
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS debt_ws_statements_service_role_all ON public.debt_ws_statements;
CREATE POLICY debt_ws_statements_service_role_all ON public.debt_ws_statements
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS debt_ws_jan_lists_service_role_all ON public.debt_ws_jan_lists;
CREATE POLICY debt_ws_jan_lists_service_role_all ON public.debt_ws_jan_lists
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 9. The two scheduled calls. Each returns without a call unless jan_list_auto_send is
--    on; ops-api re-checks the switches before doing anything.
CREATE OR REPLACE FUNCTION public.trigger_debt_ws_jan_list(p_action text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_action NOT IN ('debt_ws_jan_list_lock', 'debt_ws_jan_list_send') THEN
    RAISE EXCEPTION 'trigger_debt_ws_jan_list: unknown action %', p_action;
  END IF;
  IF NOT coalesce(
    (SELECT jan_list_auto_send FROM public.debt_ws_settings WHERE id = 1), false
  ) THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=' || p_action,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'debt-ws-cron'
    ),
    body := jsonb_build_object('actor', 'debt-ws-cron'),
    timeout_milliseconds := 30000
  );
END $$;
COMMENT ON FUNCTION public.trigger_debt_ws_jan_list(text) IS
  'pg_cron debt-ws-jan-list-lock (Fri 09:00 Perth) and debt-ws-jan-list-send (Sun 19:00 Perth): posts the ops-api action with the service key while debt_ws_settings.jan_list_auto_send is on. Otherwise a no-op.';
REVOKE ALL ON FUNCTION public.trigger_debt_ws_jan_list(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_debt_ws_jan_list(text) TO service_role, postgres;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'debt workshop: pg_cron absent, Jan list jobs not scheduled';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'debt-ws-jan-list-lock') THEN
    PERFORM cron.schedule('debt-ws-jan-list-lock', '0 1 * * 5',
      $cmd$SELECT public.trigger_debt_ws_jan_list('debt_ws_jan_list_lock')$cmd$);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'debt-ws-jan-list-send') THEN
    PERFORM cron.schedule('debt-ws-jan-list-send', '0 11 * * 0',
      $cmd$SELECT public.trigger_debt_ws_jan_list('debt_ws_jan_list_send')$cmd$);
  END IF;
END $cron$;
