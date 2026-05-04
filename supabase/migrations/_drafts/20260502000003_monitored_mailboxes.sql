-- T7 Loop 1 — Mailbox configuration table (DRAFT — NOT YET APPLIED)
--
-- Status: draft only. Apply only after explicit user approval naming this
-- migration AND Marnin confirming the seed list. Apply in Loop 8.
--
-- Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 6, Loop 8)
--
-- Why:
-- Today the monitored mailbox list is hard-coded in
-- secureworks-site/supabase/functions/monitor-inbox/index.ts. Adding finance@
-- or pausing a personal mailbox requires a code change and deploy. This
-- table makes the mailbox list data, with per-mailbox cursor state, enabled
-- flag, and privacy classification.
--
-- Marnin's required base set (Section 6 of roadmap):
--   - marnin@secureworkswa.com.au
--   - jan@secureworkswa.com.au
--   - admin@secureworkswa.com.au
--   - finance group mailbox (exact address pending Marnin confirmation; candidate finance@secureworkswa.com.au)
--   - patios@secureworkswa.com.au
--   - fencing@secureworkswa.com.au
-- Discovered-in-code carry-forward (pending Marnin review):
--   - nithin@secureworkswa.com.au   (already in monitor-inbox/index.ts)
--   - shaun@secureworkswa.com.au    (already in monitor-inbox/index.ts)
-- NOT seeded by default:
--   - khairo@   (must be explicitly approved)
--   - any other rep-personal mailbox
--
-- Privacy classification defaults:
--   personal mailboxes (marnin, jan, admin, nithin, shaun) -> 'restricted_pii'
--   group mailboxes    (finance, patios, fencing)          -> 'staff_only'
--
-- Seed inserts are NOT in this draft. Loop 8 includes a separate seed step
-- after Marnin confirms the finance address and the nithin/shaun decision.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.monitored_mailboxes;
--   Time-to-revert: <1s. Table not yet referenced by live code.
--
-- Downstream impact (post-apply):
--   - monitor-inbox/index.ts will read this table instead of the hard-coded
--     MONITORED_MAILBOXES constant. Loop 8 ships that refactor.
--   - Evidence Health page reads last_polled_at to surface stale monitors.
--   - No impact on any other function until Loop 8.

BEGIN;

CREATE TABLE IF NOT EXISTS public.monitored_mailboxes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid,                                       -- nullable until multi-org; current single-org installs leave NULL
  email                    text NOT NULL UNIQUE,
  display_name             text,
  scope_label              text NOT NULL                                -- 'owner' | 'admin' | 'finance' | 'sales' | 'patios' | 'fencing' | 'ops' | 'other'
                              CHECK (scope_label IN (
                                'owner','admin','finance','sales','patios','fencing','ops','other'
                              )),
  enabled                  boolean NOT NULL DEFAULT true,
  status                   text NOT NULL DEFAULT 'active'               -- 'active' | 'paused' | 'discovered_in_code' | 'pending_review'
                              CHECK (status IN (
                                'active','paused','discovered_in_code','pending_review'
                              )),
  poll_interval_seconds    integer NOT NULL DEFAULT 300
                              CHECK (poll_interval_seconds BETWEEN 60 AND 3600),
  privacy_classification   text NOT NULL DEFAULT 'staff_only'
                              CHECK (privacy_classification IN (
                                'internal','client_safe','staff_only','restricted_pii'
                              )),
  graph_subscription_id    text,                                        -- populated when push subscriptions land in a future loop
  graph_app_credential_id  text,                                        -- which Graph credential authenticates this mailbox
  last_polled_at           timestamptz,                                 -- per-mailbox cursor; replaces the 15-min global overlap window
  last_message_at          timestamptz,                                 -- newest message observed
  last_error               text,
  last_error_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monitored_mailboxes_enabled
  ON public.monitored_mailboxes(enabled, last_polled_at)
  WHERE enabled = true;

ALTER TABLE public.monitored_mailboxes ENABLE ROW LEVEL SECURITY;

-- Service role full access (monitor-inbox runs as service role).
CREATE POLICY "service_role_all" ON public.monitored_mailboxes
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Authenticated read for ops dashboard observability (Evidence Health page).
CREATE POLICY "authenticated_select" ON public.monitored_mailboxes
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.monitored_mailboxes IS
  'T7 mailbox config. Replaces the hard-coded MONITORED_MAILBOXES constant in monitor-inbox/index.ts. Per-mailbox cursor state, enabled flag, privacy classification. Seeded with Marnin required base set + discovered-in-code carry-forward in Loop 8 after Marnin confirmation.';

COMMIT;
