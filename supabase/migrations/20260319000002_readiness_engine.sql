-- ════════════════════════════════════════════════════════════
-- Migration: Readiness Engine + Calendar Enhancements
--
-- 1. uploaded_by on job_documents
-- 2. placeholder added to confirmation_status constraint
-- 3. Updated calendar_events view (+ confirmation_status, job_number, scope_json)
-- 4. Extended job_intelligence materialized view (wo_count, assignment_count,
--    doc_types, all_pos_delivery_confirmed, deposit_paid)
-- ════════════════════════════════════════════════════════════

-- ── 1. uploaded_by on job_documents ──
ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS uploaded_by text;

-- ── 2. Add 'placeholder' to confirmation_status constraint ──
ALTER TABLE job_assignments DROP CONSTRAINT IF EXISTS job_assignments_confirmation_status_check;
ALTER TABLE job_assignments ADD CONSTRAINT job_assignments_confirmation_status_check
  CHECK (confirmation_status IN ('placeholder', 'tentative', 'confirmed', 'declined'));

-- ── 3. Updated calendar_events view ──
DROP VIEW IF EXISTS calendar_events;

CREATE VIEW calendar_events AS
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
  ja.confirmation_status,
  ja.confirmed_at,
  ja.crew_name,
  ja.notes AS assignment_notes,
  ja.started_at,
  ja.completed_at,
  ja.job_phase,
  ja.last_phase_changed_at,
  ja.duration_days,
  j.type AS job_type,
  j.job_number,
  j.client_name,
  j.client_phone,
  j.site_address,
  j.site_suburb,
  j.status AS job_status,
  j.org_id,
  j.ghl_contact_id,
  j.pricing_json,
  j.scope_json,
  u.name AS assigned_to,
  u.phone AS assigned_phone,
  xp.project_name AS xero_project_name,
  xp.total_invoiced AS xero_invoiced,
  xp.total_expenses AS xero_expenses
FROM job_assignments ja
JOIN jobs j ON j.id = ja.job_id
LEFT JOIN users u ON u.id = ja.user_id
LEFT JOIN xero_projects xp ON xp.job_id = ja.job_id;

-- ── 4. Extended job_intelligence materialized view ──
-- DROP and recreate with new columns (wo_count, assignment_count, doc_types,
-- all_pos_delivery_confirmed, deposit_paid)
DROP MATERIALIZED VIEW IF EXISTS job_intelligence CASCADE;

CREATE MATERIALIZED VIEW job_intelligence AS
SELECT
  j.id AS job_id,
  j.job_number,
  j.type AS job_type,
  j.status,
  j.client_name,
  j.site_suburb,
  j.created_at,
  j.accepted_at,
  j.completed_at,

  -- Quoted amount from pricing_json
  COALESCE((j.pricing_json->>'totalIncGST')::numeric, 0) AS quoted_amount,

  -- PO costs (materials)
  COALESCE(po_agg.po_total, 0) AS po_costs_total,
  COALESCE(po_agg.po_count, 0) AS po_count,

  -- Trade labour costs
  COALESCE(ti_agg.labour_total, 0) AS labour_costs_total,
  COALESCE(ti_agg.labour_hours, 0) AS total_trade_hours,
  COALESCE(ti_agg.invoice_count, 0) AS trade_invoice_count,

  -- Gross profit
  COALESCE((j.pricing_json->>'totalIncGST')::numeric, 0)
    - COALESCE(po_agg.po_total, 0)
    - COALESCE(ti_agg.labour_total, 0) AS gross_profit,

  -- Margin %
  CASE WHEN COALESCE((j.pricing_json->>'totalIncGST')::numeric, 0) > 0
    THEN ROUND(
      (COALESCE((j.pricing_json->>'totalIncGST')::numeric, 0)
        - COALESCE(po_agg.po_total, 0)
        - COALESCE(ti_agg.labour_total, 0))
      / (j.pricing_json->>'totalIncGST')::numeric * 100, 1)
    ELSE NULL
  END AS margin_pct,

  -- Event counts
  COALESCE(ev_agg.total_events, 0) AS total_events,
  COALESCE(ev_agg.notes_count, 0) AS notes_count,
  ev_agg.last_activity,

  -- Cycle time (days from created to completed)
  CASE WHEN j.completed_at IS NOT NULL
    THEN EXTRACT(DAY FROM j.completed_at - j.created_at)::int
    ELSE NULL
  END AS cycle_days,

  -- Days since last activity
  CASE WHEN ev_agg.last_activity IS NOT NULL
    THEN EXTRACT(DAY FROM NOW() - ev_agg.last_activity)::int
    ELSE EXTRACT(DAY FROM NOW() - j.created_at)::int
  END AS days_since_activity,

  -- ═══ NEW: Readiness engine columns ═══

  -- Work order count
  COALESCE(wo_agg.wo_count, 0) AS wo_count,

  -- Assignment count (non-cancelled)
  COALESCE(assign_agg.assignment_count, 0) AS assignment_count,

  -- Document types (aggregated as jsonb: { "site_photo": 2, "council_plans": 1 })
  COALESCE(doc_agg.doc_types, '{}'::jsonb) AS doc_types,

  -- All POs have delivery confirmed?
  COALESCE(po_agg.all_delivery_confirmed, true) AS all_pos_delivery_confirmed,

  -- Deposit paid (any Xero invoice with amount_paid > 0)
  COALESCE(inv_agg.deposit_paid, false) AS deposit_paid

FROM jobs j

LEFT JOIN LATERAL (
  SELECT
    SUM(COALESCE(po.total, 0)) AS po_total,
    COUNT(*) AS po_count,
    -- All POs: delivery confirmed (timestamp set), status is delivered/confirmed, or delivery date has passed
    BOOL_AND(
      po.delivery_confirmed_at IS NOT NULL
      OR po.status IN ('delivered', 'confirmed', 'billed')
      OR (po.delivery_date IS NOT NULL AND po.delivery_date <= CURRENT_DATE)
    ) AS all_delivery_confirmed
  FROM purchase_orders po
  WHERE po.job_id = j.id AND po.status != 'deleted'
) po_agg ON true

LEFT JOIN LATERAL (
  SELECT
    SUM(COALESCE(ti.total, 0)) AS labour_total,
    SUM(COALESCE(
      (SELECT SUM((li->>'hours')::numeric) FROM jsonb_array_elements(ti.line_items::jsonb) li
       WHERE (li->>'job_number') = j.job_number), 0
    )) AS labour_hours,
    COUNT(*) AS invoice_count
  FROM trade_invoices ti
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(ti.line_items::jsonb) li
    WHERE (li->>'job_number') = j.job_number
  )
) ti_agg ON true

LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS total_events,
    COUNT(*) FILTER (WHERE event_type = 'note') AS notes_count,
    MAX(created_at) AS last_activity
  FROM job_events
  WHERE job_id = j.id
) ev_agg ON true

-- NEW: Work orders
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS wo_count
  FROM work_orders wo
  WHERE wo.job_id = j.id AND wo.status != 'cancelled'
) wo_agg ON true

-- NEW: Assignments (non-cancelled)
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS assignment_count
  FROM job_assignments ja
  WHERE ja.job_id = j.id AND ja.status != 'cancelled'
) assign_agg ON true

-- NEW: Document types aggregated
LEFT JOIN LATERAL (
  SELECT jsonb_object_agg(dt.doc_type, dt.cnt) AS doc_types
  FROM (
    SELECT jd.type AS doc_type, COUNT(*) AS cnt
    FROM job_documents jd
    WHERE jd.job_id = j.id
    GROUP BY jd.type
  ) dt
) doc_agg ON true

-- NEW: Deposit paid (any ACCREC invoice with amount_paid > 0)
LEFT JOIN LATERAL (
  SELECT
    BOOL_OR(COALESCE(xi.amount_paid, 0) > 0) AS deposit_paid
  FROM xero_invoices xi
  WHERE xi.job_id = j.id
    AND xi.invoice_type = 'ACCREC'
    AND xi.status NOT IN ('VOIDED', 'DELETED')
) inv_agg ON true

WHERE j.legacy = false AND j.org_id = (SELECT id FROM organisations LIMIT 1);

-- Unique index for CONCURRENTLY refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_intelligence_job_id ON job_intelligence(job_id);

-- Refresh the view
REFRESH MATERIALIZED VIEW job_intelligence;
