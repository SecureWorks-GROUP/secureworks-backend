-- ════════════════════════════════════════════════════════════
-- Migration: Multi-Neighbour Run Quoting & Invoicing
-- Adds structured per-run line items, run acceptance tracking,
-- and run_label columns for quote/invoice cross-referencing.
-- ════════════════════════════════════════════════════════════

-- ── 1. run_line_items: Structured per-run items for AI queryability ──

CREATE TABLE IF NOT EXISTS run_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_label text NOT NULL, -- REAR, LHS, RHS, FRONT, REAR-W, REAR-E
  job_contact_id uuid REFERENCES job_contacts(id) ON DELETE SET NULL,
    -- The neighbour for this run. NULL if no neighbour (100% client).

  description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit text, -- 'm', 'ea', 'job', 'sheet', etc.
  unit_price_ex numeric(12,2) NOT NULL DEFAULT 0,
  line_total_ex numeric(12,2) NOT NULL DEFAULT 0,

  allocation text NOT NULL DEFAULT 'shared'
    CHECK (allocation IN ('shared', 'client_only', 'neighbour_only')),
  split_pct numeric(5,2) NOT NULL DEFAULT 50,
    -- Client's percentage. Neighbour gets (100 - split_pct).
    -- shared: typically 50. client_only: 100. neighbour_only: 0.
  allocation_note text,
    -- e.g. "Tree removal on neighbour's side — neighbour's cost in full"

  client_amount_ex numeric(12,2) NOT NULL DEFAULT 0,
  neighbour_amount_ex numeric(12,2) NOT NULL DEFAULT 0,

  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_run_items_job ON run_line_items(job_id);
CREATE INDEX idx_run_items_run ON run_line_items(job_id, run_label);
CREATE INDEX idx_run_items_allocation ON run_line_items(allocation)
  WHERE allocation != 'shared';

ALTER TABLE run_line_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages run items"
  ON run_line_items FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE run_line_items IS
  'Structured per-run line items with cost allocation for multi-neighbour fencing. '
  'Mirrors pricing_json.runs[].items for AI queryability. '
  'Written at same time as pricing_json — dual source: structured for analytics, JSONB for PDF rendering.';
COMMENT ON COLUMN run_line_items.run_label IS
  'Boundary position label: REAR, LHS, RHS, FRONT. Split boundaries: REAR-W, REAR-E.';
COMMENT ON COLUMN run_line_items.split_pct IS
  'Client share percentage. 50 = even split. 100 = client only. 0 = neighbour only.';
COMMENT ON COLUMN run_line_items.job_contact_id IS
  'The neighbour party for this run. NULL if fence has no neighbour (council land, laneway, client owns both sides).';


-- ── 2. run_acceptances: Per-party acceptance tracking ──

CREATE TABLE IF NOT EXISTS run_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_contact_id uuid NOT NULL REFERENCES job_contacts(id) ON DELETE CASCADE,
  job_document_id uuid REFERENCES job_documents(id) ON DELETE SET NULL,
  run_label text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  accepted_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_accept_job ON run_acceptances(job_id);
CREATE UNIQUE INDEX idx_run_accept_unique
  ON run_acceptances(job_id, job_contact_id, run_label);

ALTER TABLE run_acceptances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages run acceptances"
  ON run_acceptances FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE run_acceptances IS
  'Per-party acceptance tracking for multi-neighbour fencing runs. '
  'Both client AND neighbour must accept for a run to proceed to scheduling. '
  'No neighbour entry needed if run has no neighbour (job_contact_id is always the client or the neighbour).';


-- ── 3. Add run_label to job_documents ──

ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS run_label text;
COMMENT ON COLUMN job_documents.run_label IS
  'Boundary position for per-run fencing quotes: REAR, LHS, RHS, FRONT.';
CREATE INDEX IF NOT EXISTS idx_job_docs_run
  ON job_documents(job_id, run_label) WHERE run_label IS NOT NULL;


-- ── 4. Add run_label to xero_invoices ──

ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS run_label text;
COMMENT ON COLUMN xero_invoices.run_label IS
  'Links invoice to specific fencing run for multi-neighbour cost splitting.';


-- ── 5. Run summary view for ops dashboard / AI ──

CREATE OR REPLACE VIEW run_summary AS
SELECT
  rli.job_id,
  rli.run_label,
  rli.job_contact_id,
  jc.client_name AS neighbour_name,
  jc.site_address AS neighbour_address,
  j.job_number,
  j.client_name AS client_name,
  j.site_address AS client_address,
  COUNT(*) AS item_count,
  SUM(rli.line_total_ex) AS run_total_ex,
  SUM(rli.client_amount_ex) AS client_total_ex,
  SUM(rli.neighbour_amount_ex) AS neighbour_total_ex,
  ROUND(SUM(rli.line_total_ex) * 1.1, 2) AS run_total_inc,
  ROUND(SUM(rli.client_amount_ex) * 1.1, 2) AS client_total_inc,
  ROUND(SUM(rli.neighbour_amount_ex) * 1.1, 2) AS neighbour_total_inc
FROM run_line_items rli
JOIN jobs j ON j.id = rli.job_id
LEFT JOIN job_contacts jc ON jc.id = rli.job_contact_id
GROUP BY rli.job_id, rli.run_label, rli.job_contact_id,
         jc.client_name, jc.site_address, j.job_number, j.client_name, j.site_address;

COMMENT ON VIEW run_summary IS
  'Pre-aggregated per-run totals with client/neighbour shares for dashboard display and AI analysis.';
