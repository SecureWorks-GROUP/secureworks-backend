-- ============================================================
-- MIGRATION: job_financials skeleton extension
-- Timestamp: 20260617000010
-- Branch: ludwig/job-financials-skeleton-2026-06-17
-- Status: STAGED — DO NOT APPLY until Marnin's M1 gate
--
-- PURPOSE
-- -------
-- Extends the PARKED migration 20260613000001_job_financials_views.sql
-- by adding the trade-count aggregation view needed for the cost-control
-- checks (Lane R / Lane B), and widens job_financials to all job types
-- (currently scoped to makesafe in the parked file; the type filter is
-- preserved as a commented-out line for the M6 expansion date).
--
-- APPLY ORDER (must apply AFTER 20260613000001 which this extends):
--   1. v_job_trade_count         — distinct billing trades per job (new)
--   2. job_financials            — REPLACE: widen to all job types (edit)
--
-- ASSUMPTIONS TO VERIFY AT M1 (against live DB / information_schema)
-- ------------------------------------------------------------------
-- [A1] xero_invoices.job_id is reliably populated for ACCREC (client)
--      invoices on make-safe jobs. The xero-sync function auto-links via
--      the SWMS-NNNNN reference pattern, with a fallback matchUnlinkedInvoices
--      pass. Confirmed by code inspection of xero-sync/index.ts:483-516.
--      VERIFY LIVE: SELECT count(*) FROM xero_invoices WHERE invoice_type='ACCREC'
--        AND job_id IS NOT NULL AND status NOT IN ('VOIDED','DELETED');
--      Expected: > 0 rows linking to makesafe jobs.
--
-- [A2] xero_invoices.sub_total is EX-GST; xero_invoices.amount_paid is
--      INC-GST (therefore amount_paid / 1.1 for EX-GST collected).
--      This is stated in the parked migration header (§2a / 473/478 paid
--      ACCREC measured INC-GST). Carry forward as-is.
--      VERIFY LIVE: spot-check a PAID ACCREC row:
--        SELECT sub_total, amount_paid, total FROM xero_invoices
--        WHERE invoice_type='ACCREC' AND status='PAID' LIMIT 5;
--      Expected: amount_paid ≈ total (INC-GST) ≈ sub_total * 1.1.
--
-- [A3] The parked v_trade_charge_resolved view is not live yet
--      (confirmed absent from remote migration history 2026-06-17).
--      This extension VIEW and the widened job_financials both depend on it.
--      M1 gate = apply 20260613000001 first, THEN apply this file.
--
-- [A4] trade_invoice_lines.division column exists and 'Make Safe' is the
--      canonical value for make-safe lines (not 'makesafe', 'MAKE SAFE' etc).
--      Confirmed by Surveyor read of ops-api/index.ts code paths.
--      VERIFY LIVE: SELECT DISTINCT division FROM trade_invoice_lines LIMIT 20;
--
-- [A5] trade_invoices.user_id maps to a user in the users table.
--      Confirmed by existing code join in v_makesafe_charge_ledger (parked).
--
-- [A6] job_assignments.user_id = trade user id, job_assignments.job_id = job.
--      Distinct user_id per job_id gives the ALLOCATED trade count baseline.
--      VERIFY LIVE: SELECT count(*) FROM job_assignments WHERE job_id IS NOT NULL;
--
-- [A7] org_id constant '00000000-0000-0000-0000-000000000001' is correct for
--      this single-org deployment. Carried from the parked view.
--
-- [A8] job_financials is widened to all job types by removing the
--      j.type = 'makesafe' filter. This means patio/fence/reno jobs with no
--      trade_invoice_lines will appear with cost = 0 (COALESCE). That is
--      correct behaviour: they are visible but show "no_labour_linked" cost_flag.
--      The margin suppression rule (net_margin_ex NULL when cost_flag != 'ok')
--      prevents any misleading P&L number showing for those jobs.
--      VERIFY: confirm with Marnin that all-job-type visibility is desired
--      NOW at M1, or whether to keep the makesafe scope until a later gate.
-- ============================================================


-- ============================================================
-- 1. v_job_trade_count
--    Per-job aggregation of distinct billing trades and distinct allocated trades.
--    Used by the cost-control (Lane B) trade-count check:
--      IF billing_trade_count > allocated_trade_count → flag as over-count.
--    Scoped to make-safe jobs initially (j.type='makesafe'). Generalise at M6.
--
--    Join path for billing trades:
--      trade_invoice_lines.job_id → trade_invoices.user_id
--      (no per-line user_id; join via trade_invoice_id — Risk 6 in CONTRACT)
--
--    ASSUMPTIONS: [A3] [A4] [A5] [A6]
-- ============================================================
CREATE OR REPLACE VIEW v_job_trade_count AS
SELECT
  j.id                                              AS job_id,
  j.job_number,
  j.type                                            AS job_type,

  -- Billing trade count: distinct trades who submitted a line for this job
  -- via trade_invoice_lines (all statuses counted; exclude VOIDED invoices)
  COUNT(DISTINCT ti.user_id)
    FILTER (WHERE ti.status NOT IN ('VOIDED', 'DELETED'))
                                                    AS billing_trade_count,

  -- Allocated trade count: distinct trades assigned to this job in job_assignments
  -- This is the v1 baseline for the authorised N (Lane R)
  COUNT(DISTINCT ja.user_id)                        AS allocated_trade_count,

  -- Over-count flag: billing trades exceed allocated trades
  -- NULL when either count is 0/null (incomplete data — do not flag)
  CASE
    WHEN COUNT(DISTINCT ti.user_id) FILTER (WHERE ti.status NOT IN ('VOIDED', 'DELETED')) > 0
     AND COUNT(DISTINCT ja.user_id) > 0
     AND COUNT(DISTINCT ti.user_id) FILTER (WHERE ti.status NOT IN ('VOIDED', 'DELETED'))
         > COUNT(DISTINCT ja.user_id)
    THEN true
    ELSE false
  END                                               AS over_count_flag

FROM jobs j

-- Billing side: what trades actually billed this job
LEFT JOIN trade_invoice_lines til ON til.job_id = j.id
LEFT JOIN trade_invoices ti       ON ti.id = til.trade_invoice_id
                                  -- [A4] scope to make-safe lines only within the line
                                  AND (til.division = 'Make Safe' OR til.line_type = 'make safe')

-- Allocation side: what trades were assigned to this job
LEFT JOIN job_assignments ja       ON ja.job_id = j.id

WHERE j.org_id = '00000000-0000-0000-0000-000000000001' -- [A7]
  AND j.legacy  = false
  AND j.status != 'cancelled'
  AND j.type    = 'makesafe'   -- M6: remove this filter to expand to all job types
GROUP BY j.id, j.job_number, j.type;


-- ============================================================
-- 2. job_financials — widened to all job types
--
--    CHANGES FROM PARKED VERSION (20260613000001):
--      - Removed: AND j.type = 'makesafe' filter on the outer WHERE
--        (was "V1 SCOPE: remove at M6" — we move that date forward to M1
--         per CONTRACT §Skeleton co-priority ruling)
--      - Added: job_type column already present; no other column changes
--      - Added: comment noting M6 removal was the original plan; now done at M1
--      - Revenue side: unchanged (already reads all ACCREC xero_invoices by job_id)
--      - Cost side: unchanged (v_trade_charge_resolved is already job-type-agnostic)
--      - All rulings from the parked version (§2a, §2c, §2b, §2e, D-B1, D-M1,
--        D-M3, D-M4, D-M5) carry forward unchanged.
--
--    ASSUMPTION: [A8] — confirm all-job visibility is wanted at M1.
--
--    NOTE: This CREATE OR REPLACE will fail if 20260613000001 is not applied first
--    because it references v_trade_charge_resolved and v_invoice_line_completeness.
--    APPLY 20260613000001 BEFORE THIS FILE.
-- ============================================================
CREATE OR REPLACE VIEW job_financials AS
WITH rev AS (
  SELECT
    xi.job_id,
    SUM(xi.sub_total)         FILTER (WHERE xi.status IN ('AUTHORISED', 'PAID'))
                                                          AS client_invoiced_ex,
    SUM(xi.sub_total)         FILTER (WHERE xi.status = 'DRAFT')
                                                          AS draft_revenue_ex,
    SUM(xi.amount_paid / 1.1) FILTER (WHERE xi.status IN ('AUTHORISED', 'PAID'))
                                                          AS client_collected_ex
    -- amount_paid is INC-GST (measured on 473/478 PAID ACCREC rows, §2a ruling)
    -- sub_total is EX-GST; use as-is
    -- VOIDED/DELETED excluded; DRAFT not counted in client_invoiced_ex or margin
    -- [A1] [A2]
  FROM xero_invoices xi
  WHERE xi.invoice_type = 'ACCREC'
    AND xi.status NOT IN ('VOIDED', 'DELETED')
    AND xi.job_id IS NOT NULL
  GROUP BY xi.job_id
),
cost AS (
  SELECT
    r.resolved_job_id                                                       AS job_id,
    SUM(r.line_total_ex) FILTER (WHERE r.cost_lane = 'labour')             AS cost_labour_ex,
    SUM(r.line_total_ex) FILTER (WHERE r.cost_lane = 'materials')          AS cost_materials_ex,
    SUM(r.line_total_ex) FILTER (WHERE r.cost_lane = 'commission')         AS cost_commission_ex,
    SUM(r.line_total_ex) FILTER (WHERE r.cost_lane IN ('other', 'unclassified'))
                                                                            AS cost_other_ex,
    bool_or(r.cost_lane = 'unclassified')                                  AS has_unclassified,
    bool_or(NOT r.attributed_direct)                                       AS has_text_matched,
    bool_or(c.zero_line OR c.mismatch)                                     AS has_incomplete_invoice
  FROM v_trade_charge_resolved r   -- [A3] depends on parked migration being applied
  LEFT JOIN v_invoice_line_completeness c ON c.trade_invoice_id = r.trade_invoice_id
  WHERE r.resolved_job_id IS NOT NULL
  GROUP BY r.resolved_job_id
)
SELECT
  j.id                                            AS job_id,
  j.job_number,
  j.client_name,
  j.type                                          AS job_type,
  j.status,
  j.created_at,

  -- Revenue (EX-GST throughout — [A1] [A2])
  COALESCE(rev.client_invoiced_ex,  0)            AS client_invoiced_ex,
  COALESCE(rev.draft_revenue_ex,    0)            AS draft_revenue_ex,    -- visible, NOT in margin
  COALESCE(rev.client_collected_ex, 0)            AS client_collected_ex,

  -- Cost lanes (all EX-GST; v1 populates labour + other; materials/commission reserved)
  COALESCE(cost.cost_labour_ex,     0)            AS cost_labour_ex,
  COALESCE(cost.cost_materials_ex,  0)            AS cost_materials_ex,   -- reserved, M7
  COALESCE(cost.cost_commission_ex, 0)            AS cost_commission_ex,  -- reserved, Q16/M8
  0::numeric                                      AS cost_card_fees_ex,   -- reserved, stripe-surcharge-review/M8
  COALESCE(cost.cost_other_ex,      0)            AS cost_other_ex,
  0::numeric                                      AS wo_allocation_declared_ex, -- Q17 reserved; informational

  -- Flags (one vocabulary across view/panel/API — D-M4)
  CASE
    WHEN rev.client_invoiced_ex IS NULL OR rev.client_invoiced_ex = 0
      THEN 'missing_client_invoice'
    ELSE 'ok'
  END                                             AS revenue_flag,
  CASE
    WHEN cost.job_id IS NULL
      THEN 'no_labour_linked'
    WHEN COALESCE(cost.has_incomplete_invoice, false)
      THEN 'incomplete_invoice_lines'
    WHEN COALESCE(cost.has_unclassified, false)
      THEN 'unclassified_lines'
    WHEN COALESCE(cost.has_text_matched, false)
      THEN 'text_matched_lines'               -- informational; does NOT suppress margin
    ELSE 'ok'
  END                                             AS cost_flag,

  -- Margin: SUPPRESSED (NULL) unless revenue_flag='ok' AND cost trustworthy (D-B1 binding)
  -- Surfaces MUST render NULL as "-- costs incomplete: <cost_flag>" never as a number
  CASE
    WHEN COALESCE(rev.client_invoiced_ex, 0) > 0
     AND cost.job_id IS NOT NULL
     AND NOT COALESCE(cost.has_incomplete_invoice, false)
     AND NOT COALESCE(cost.has_unclassified, false)
    THEN rev.client_invoiced_ex
         - COALESCE(cost.cost_labour_ex,     0)
         - COALESCE(cost.cost_materials_ex,  0)
         - COALESCE(cost.cost_commission_ex, 0)
         - COALESCE(cost.cost_other_ex,      0)
    ELSE NULL
  END                                             AS net_margin_ex,
  CASE
    WHEN COALESCE(rev.client_invoiced_ex, 0) > 0
     AND cost.job_id IS NOT NULL
     AND NOT COALESCE(cost.has_incomplete_invoice, false)
     AND NOT COALESCE(cost.has_unclassified, false)
    THEN ROUND(
           ( ( rev.client_invoiced_ex
               - COALESCE(cost.cost_labour_ex,     0)
               - COALESCE(cost.cost_materials_ex,  0)
               - COALESCE(cost.cost_commission_ex, 0)
               - COALESCE(cost.cost_other_ex,      0) )
             / rev.client_invoiced_ex ) * 100,
           1)
    ELSE NULL
  END                                             AS margin_pct

FROM jobs j
LEFT JOIN rev  ON rev.job_id  = j.id
LEFT JOIN cost ON cost.job_id = j.id
WHERE j.org_id  = '00000000-0000-0000-0000-000000000001'  -- [A7]
  AND j.legacy  = false
  AND j.status != 'cancelled';
  -- NOTE: j.type = 'makesafe' filter REMOVED here vs the parked version.
  -- Original plan was to remove at M6; CONTRACT §Skeleton co-priority moves it to M1.
  -- [A8] Verify with Marnin that all-job visibility is wanted now.
  -- To revert to makesafe-only scope: add AND j.type = 'makesafe' here.
