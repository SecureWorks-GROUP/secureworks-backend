-- ════════════════════════════════════════════════════════════
-- Migration 010: Ops Dashboard Schema
--
-- Extends job_assignments for real scheduling, adds purchase_orders,
-- work_orders, suppliers tables, calendar/scheduling views, PO/WO
-- number sequences, and ops_manager role.
-- ════════════════════════════════════════════════════════════

-- Ensure required extensions are available
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" SCHEMA extensions;

-- Make extension functions available without schema prefix
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_bytes' AND pronamespace = 'public'::regnamespace) THEN
    CREATE OR REPLACE FUNCTION public.gen_random_bytes(int) RETURNS bytea AS 'SELECT extensions.gen_random_bytes($1)' LANGUAGE sql;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid' AND pronamespace = 'public'::regnamespace) THEN
    CREATE OR REPLACE FUNCTION public.gen_random_uuid() RETURNS uuid AS 'SELECT extensions.gen_random_uuid()' LANGUAGE sql;
  END IF;
END $$;

-- ── 1. Extend job_assignments for real scheduling ──

ALTER TABLE job_assignments
  ADD COLUMN IF NOT EXISTS scheduled_end date,
  ADD COLUMN IF NOT EXISTS start_time time,
  ADD COLUMN IF NOT EXISTS end_time time,
  ADD COLUMN IF NOT EXISTS assignment_type text DEFAULT 'install'
    CHECK (assignment_type IN ('install', 'scope', 'delivery', 'rectification', 'followup')),
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'confirmed', 'in_progress', 'complete', 'cancelled')),
  ADD COLUMN IF NOT EXISTS crew_name text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Allow same user on multiple dates for same job (was unique on job_id, user_id)
ALTER TABLE job_assignments DROP CONSTRAINT IF EXISTS job_assignments_job_id_user_id_key;
ALTER TABLE job_assignments ADD CONSTRAINT job_assignments_job_user_date_key
  UNIQUE(job_id, user_id, scheduled_date);

-- Trigger for updated_at
CREATE TRIGGER trg_job_assignments_updated BEFORE UPDATE ON job_assignments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 2. PO/WO Number Sequences ──

CREATE SEQUENCE IF NOT EXISTS po_number_seq START 1;
CREATE SEQUENCE IF NOT EXISTS wo_number_seq START 1;

-- ── 3. Suppliers (cached Xero supplier contacts) ──

CREATE TABLE IF NOT EXISTS suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  xero_contact_id text,
  name            text NOT NULL,
  email           text,
  phone           text,
  is_active       boolean DEFAULT true,
  synced_at       timestamptz DEFAULT now(),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(org_id, xero_contact_id)
);

CREATE INDEX idx_suppliers_org ON suppliers(org_id);
CREATE INDEX idx_suppliers_xero ON suppliers(xero_contact_id) WHERE xero_contact_id IS NOT NULL;

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view org suppliers"
  ON suppliers FOR SELECT
  USING (org_id = auth_org_id());

CREATE POLICY "Service role manages suppliers"
  ON suppliers FOR ALL
  USING (auth.role() = 'service_role');

CREATE TRIGGER trg_suppliers_updated BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 4. Purchase Orders ──

CREATE TABLE IF NOT EXISTS purchase_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  job_id          uuid REFERENCES jobs(id) ON DELETE SET NULL,
  po_number       text NOT NULL,
  supplier_name   text NOT NULL,
  xero_contact_id text,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'authorised', 'billed', 'deleted')),
  line_items      jsonb DEFAULT '[]'::jsonb,
  subtotal        numeric(12,2) DEFAULT 0,
  tax             numeric(12,2) DEFAULT 0,
  total           numeric(12,2) DEFAULT 0,
  delivery_date   date,
  reference       text,
  notes           text,
  xero_po_id      text,
  synced_at       timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Unique constraint for Xero sync upsert
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_org_xero_key
  UNIQUE(org_id, xero_po_id);

CREATE INDEX idx_po_org ON purchase_orders(org_id);
CREATE INDEX idx_po_job ON purchase_orders(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_po_status ON purchase_orders(status);
CREATE INDEX idx_po_xero ON purchase_orders(xero_po_id) WHERE xero_po_id IS NOT NULL;
CREATE INDEX idx_po_delivery ON purchase_orders(delivery_date) WHERE delivery_date IS NOT NULL;

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view org POs"
  ON purchase_orders FOR SELECT
  USING (org_id = auth_org_id());

CREATE POLICY "Service role manages POs"
  ON purchase_orders FOR ALL
  USING (auth.role() = 'service_role');

CREATE TRIGGER trg_po_updated BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 5. Work Orders ──

CREATE TABLE IF NOT EXISTS work_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  job_id              uuid REFERENCES jobs(id) ON DELETE SET NULL,
  wo_number           text NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'sent', 'accepted', 'in_progress', 'complete', 'cancelled')),
  -- Trade assigned (could be internal user or external)
  assigned_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  trade_name          text,
  trade_phone         text,
  trade_email         text,
  -- Scope
  scope_items         jsonb DEFAULT '[]'::jsonb,
  special_instructions text,
  -- Schedule
  scheduled_date      date,
  site_address        text,
  -- Sharing
  share_token         text UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  -- Tracking
  sent_at             timestamptz,
  viewed_at           timestamptz,
  accepted_at         timestamptz,
  completed_at        timestamptz,
  -- Meta
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE INDEX idx_wo_org ON work_orders(org_id);
CREATE INDEX idx_wo_job ON work_orders(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_wo_status ON work_orders(status);
CREATE INDEX idx_wo_scheduled ON work_orders(scheduled_date) WHERE scheduled_date IS NOT NULL;
CREATE INDEX idx_wo_token ON work_orders(share_token);

ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view org WOs"
  ON work_orders FOR SELECT
  USING (org_id = auth_org_id());

CREATE POLICY "Service role manages WOs"
  ON work_orders FOR ALL
  USING (auth.role() = 'service_role');

CREATE TRIGGER trg_wo_updated BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 6. Extend users role constraint to include ops_manager ──

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'estimator', 'installer', 'ops_manager'));

-- ── 7. Calendar Events View ──
-- Joins assignments + jobs + users for calendar rendering

CREATE OR REPLACE VIEW calendar_events AS
SELECT
  ja.id AS assignment_id,
  ja.job_id,
  ja.user_id,
  ja.scheduled_date,
  ja.scheduled_end,
  ja.start_time,
  ja.end_time,
  ja.assignment_type,
  ja.status AS assignment_status,
  ja.crew_name,
  ja.notes AS assignment_notes,
  j.type AS job_type,
  j.client_name,
  j.client_phone,
  j.site_address,
  j.site_suburb,
  j.status AS job_status,
  j.org_id,
  j.ghl_contact_id,
  j.pricing_json,
  u.name AS assigned_to,
  u.phone AS assigned_phone,
  xp.project_name AS xero_project_name,
  xp.total_invoiced AS xero_invoiced,
  xp.total_expenses AS xero_expenses
FROM job_assignments ja
JOIN jobs j ON j.id = ja.job_id
LEFT JOIN users u ON u.id = ja.user_id
LEFT JOIN xero_projects xp ON xp.job_id = ja.job_id;

-- ── 8. Jobs Needing Scheduling View ──
-- Accepted/scheduled jobs with no future assignments

CREATE OR REPLACE VIEW jobs_needing_scheduling AS
SELECT
  j.id,
  j.org_id,
  j.type,
  j.client_name,
  j.client_phone,
  j.site_address,
  j.site_suburb,
  j.status,
  j.accepted_at,
  j.pricing_json,
  j.ghl_contact_id,
  EXTRACT(DAY FROM now() - COALESCE(j.accepted_at, j.created_at))::int AS days_waiting
FROM jobs j
WHERE j.status IN ('accepted', 'quoted')
  AND NOT EXISTS (
    SELECT 1 FROM job_assignments ja
    WHERE ja.job_id = j.id
      AND ja.scheduled_date >= CURRENT_DATE
      AND ja.status NOT IN ('cancelled')
  )
ORDER BY j.accepted_at ASC NULLS LAST;

-- ── 9. Ops KPI Targets in org_config ──

INSERT INTO org_config (org_id, config_key, config_value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'ops_monthly_jobs_target', '{"amount": 15}'),
  ('00000000-0000-0000-0000-000000000001', 'ops_days_to_invoice_target', '{"amount": 7}'),
  ('00000000-0000-0000-0000-000000000001', 'ops_material_ontime_target', '{"amount": 90}'),
  ('00000000-0000-0000-0000-000000000001', 'ops_ar_current_pct_target', '{"amount": 80}'),
  ('00000000-0000-0000-0000-000000000001', 'ops_quote_win_rate_target', '{"amount": 40}')
ON CONFLICT (org_id, config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

-- ── 10. pg_cron: PO sync every 30 min (XX:05 and XX:35) ──

SELECT cron.schedule(
  'xero-po-sync',
  '5,35 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_purchase_orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── 11. pg_cron: Supplier sync daily at 5am AWST (9pm UTC) ──

SELECT cron.schedule(
  'xero-supplier-sync',
  '0 21 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_suppliers',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
