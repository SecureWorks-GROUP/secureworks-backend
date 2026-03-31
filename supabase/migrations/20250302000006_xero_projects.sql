-- ════════════════════════════════════════════════════════════
-- Migration 006: Xero Projects Table
--
-- Stores per-project financial data from Xero Projects API.
-- Each project has invoiced revenue + expenses = per-job P&L.
-- ════════════════════════════════════════════════════════════

-- ── Xero Projects ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS xero_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  xero_project_id text NOT NULL,           -- Xero Projects API projectId
  xero_contact_id text,                     -- Xero contactId on the project
  project_name text NOT NULL,               -- e.g. "SW1334 15 Cloudberry Crescent Upper Swan"
  status text,                              -- INPROGRESS, CLOSED
  total_invoiced numeric(12,2) DEFAULT 0,   -- Revenue invoiced to client
  total_expenses numeric(12,2) DEFAULT 0,   -- Costs/expenses logged against project
  total_to_be_invoiced numeric(12,2) DEFAULT 0,
  deposit numeric(12,2) DEFAULT 0,
  credit_note_amount numeric(12,2) DEFAULT 0,
  project_amount_invoiced numeric(12,2) DEFAULT 0,  -- Amount invoiced from project itself
  task_amount_invoiced numeric(12,2) DEFAULT 0,
  expense_amount_invoiced numeric(12,2) DEFAULT 0,
  expense_amount_to_be_invoiced numeric(12,2) DEFAULT 0,
  job_id uuid REFERENCES jobs(id),          -- Matched to internal job
  job_number text,                          -- Extracted SW number (e.g. "SW1334")
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(org_id, xero_project_id)
);
ALTER TABLE xero_projects ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_xero_projects_org ON xero_projects(org_id);
CREATE INDEX idx_xero_projects_contact ON xero_projects(xero_contact_id);
CREATE INDEX idx_xero_projects_job ON xero_projects(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_xero_projects_status ON xero_projects(status);

CREATE POLICY "Users view own org projects"
  ON xero_projects FOR SELECT
  USING (org_id = (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Service role manages projects"
  ON xero_projects FOR ALL
  USING (auth.role() = 'service_role');

CREATE TRIGGER update_xero_projects_updated_at
  BEFORE UPDATE ON xero_projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
