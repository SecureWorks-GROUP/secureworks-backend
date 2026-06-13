-- ============================================================
-- MIGRATION: job_financials views
-- Timestamp: 20260613000001
-- Branch: m1-job-financials-view
-- Status: STAGED — DO NOT APPLY until Marnin approves at the M1 gate
-- PR message: "Migration STAGED - apply + deploy = Marnin gate; financial source of truth, review carefully"
--
-- Design ref: coding/work/missions/job-profitability-foundation-2026-06-12/evidence/job-pnl-design-2026-06-12.md
-- Adversarial review: evidence/pnl-design-adversarial-review-2026-06-12.md
-- Validated against live DB 2026-06-13 (project kevgrhcjxspbxgovpmfl)
-- Evidence: evidence/m1-build-2026-06-13.md
--
-- V1 SCOPE: makesafe jobs only (j.type = 'makesafe').
-- M6 expansion = remove that one filter; add quoted columns per §2a basis ruling.
--
-- APPLY ORDER (all idempotent CREATE OR REPLACE):
--   1. v_invoice_line_completeness   — zero-line / mismatch detector
--   2. v_trade_charge_resolved       — canonical cost resolver (P&L + audit share ONE definition)
--   3. job_financials                — main P&L view (makesafe v1)
--   4. v_makesafe_charge_ledger      — per-line audit ledger (reads resolver)
--   5. v_job_double_charge           — double-charge detector (reads ledger)
-- ============================================================


-- ============================================================
-- 1. v_invoice_line_completeness
--    Catches zero-line invoices ($9,400.10 class) and header/line mismatches.
--    Feeds the has_incomplete_invoice flag in job_financials.
-- ============================================================
CREATE OR REPLACE VIEW v_invoice_line_completeness AS
SELECT
  ti.id                                          AS trade_invoice_id,
  ti.user_id,
  ti.week_start,
  ti.subtotal_ex,
  COALESCE(SUM(til.line_total_ex), 0)            AS lines_total_ex,
  COUNT(til.id)                                  AS line_count,
  (COUNT(til.id) = 0)                            AS zero_line,
  (ABS(COALESCE(ti.subtotal_ex, 0) - COALESCE(SUM(til.line_total_ex), 0)) > 0.01) AS mismatch
FROM trade_invoices ti
LEFT JOIN trade_invoice_lines til ON til.trade_invoice_id = ti.id
GROUP BY ti.id, ti.user_id, ti.week_start, ti.subtotal_ex;


-- ============================================================
-- 2. v_trade_charge_resolved
--    THE canonical trade-charge source. Both the P&L view and all audit views
--    read THIS — one cost definition, no drift.
--
--    Resolver rule (§2c): COALESCE(til.job_id, job_number-matched jobs.id).
--    job_number is unique (0 duplicates measured 2026-06-12) — safe join key.
--
--    Cost-lane taxonomy (§2b — D-B3 fix):
--      labour      = line_type IN ('labour','fencing','patio','make safe','general labour')
--      materials   = line_type = 'materials'                          [reserved v1]
--      commission  = line_type = 'commission'                         [reserved Q16]
--      other       = line_type IN ('travel','equipment','other')
--      unclassified = anything else → raises flag, never silently labour
--
--    Q17 NOTE: when wo_allocation_id column lands on trade_invoice_lines, add as
--    the FIRST CASE branch: WHEN til.wo_allocation_id IS NOT NULL THEN 'wo_declared'
--    That lane is informational only and excluded from all cost aggregates (§6 ruling).
--
--    VALIDATED 2026-06-13:
--      direct_job_id=2, resolved_via_job_number=43, unresolvable=88
--      0 of resolved rows touch a makesafe job (confirmed — M0 fills going forward)
-- ============================================================
CREATE OR REPLACE VIEW v_trade_charge_resolved AS
SELECT
  til.id                                AS line_id,
  COALESCE(til.job_id, jn.id)           AS resolved_job_id,
  (til.job_id IS NOT NULL)              AS attributed_direct,
  ti.id                                 AS trade_invoice_id,
  ti.user_id,
  ti.week_start,
  ti.status                             AS invoice_status,
  ti.xero_bill_id,
  til.line_type,
  til.description,
  til.total_hours,
  til.hourly_rate,
  til.line_total_ex,
  til.line_date,
  til.division,
  CASE
    -- Q17 forward hook (when wo_allocation_id column lands, prepend):
    --   WHEN til.wo_allocation_id IS NOT NULL THEN 'wo_declared'
    WHEN til.line_type IN ('labour', 'fencing', 'patio', 'make safe', 'general labour')
      THEN 'labour'
    WHEN til.line_type = 'materials'
      THEN 'materials'
    WHEN til.line_type = 'commission'
      THEN 'commission'
    WHEN til.line_type IN ('travel', 'equipment', 'other')
      THEN 'other'
    ELSE 'unclassified'
  END AS cost_lane
FROM trade_invoice_lines til
JOIN  trade_invoices ti ON ti.id = til.trade_invoice_id
LEFT JOIN jobs jn
  ON  jn.job_number = til.job_number
  AND til.job_id IS NULL;   -- only use text-match when direct FK absent


-- ============================================================
-- 3. job_financials (main P&L view, v1 — makesafe only)
--
--    Revenue rulings (§2a / D-M1 / D-M5):
--      client_invoiced_ex  = sub_total (EX — use as-is)
--      client_collected_ex = amount_paid / 1.1  (measured INC-GST 473/478)
--      draft_revenue_ex    = DRAFT ACCREC sub_total (visible, NOT in margin)
--      VOIDED/DELETED excluded; cancelled jobs excluded; DRAFT not in margin
--
--    Margin suppression rule (§2e / D-B1 — binding for ALL surfaces):
--      net_margin_ex and margin_pct are NULL unless:
--        revenue_flag = 'ok'  AND
--        cost_flag IN ('ok', 'text_matched_lines')
--      Renders as "— costs incomplete" on any surface when NULL.
--
--    ACCPAY exclusion (§5c / D-M3):
--      This view reads trade_invoice_lines only, never ACCPAY xero_invoices rows.
--      Any ACCPAY-as-cost path elsewhere MUST exclude:
--        xero_invoices.xero_invoice_id NOT IN
--          (SELECT xero_bill_id FROM trade_invoices WHERE xero_bill_id IS NOT NULL)
--
--    No quoted column in v1 — pricing_json is {} on all 126 makesafes.
--    Returns at M6 (all-jobs expansion) per §2a basis ruling.
--
--    VALIDATED 2026-06-13 on SWMS-26529 / SWMS-26503 / SWMS-26462:
--      revenue_flag='ok', cost_flag='no_labour_linked',
--      net_margin_ex=NULL, margin_pct=NULL — suppression confirmed working.
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
    -- amount_paid measured INC-GST (473/478 paid ACCREC) → /1.1 per §2a ruling
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
  FROM v_trade_charge_resolved r
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

  -- Revenue (EX-GST throughout — no quoted column in v1, pricing_json={} on all makesafes)
  COALESCE(rev.client_invoiced_ex,  0)            AS client_invoiced_ex,
  COALESCE(rev.draft_revenue_ex,    0)            AS draft_revenue_ex,    -- visible, NOT in margin
  COALESCE(rev.client_collected_ex, 0)            AS client_collected_ex,

  -- Cost lanes (all EX-GST; lanes present from day one per Q27; v1 populates labour + other)
  COALESCE(cost.cost_labour_ex,     0)            AS cost_labour_ex,
  COALESCE(cost.cost_materials_ex,  0)            AS cost_materials_ex,   -- reserved, M7
  COALESCE(cost.cost_commission_ex, 0)            AS cost_commission_ex,  -- reserved, Q16/M8
  0::numeric                                      AS cost_card_fees_ex,   -- reserved, stripe-surcharge-review/M8
  COALESCE(cost.cost_other_ex,      0)            AS cost_other_ex,
  0::numeric                                      AS wo_allocation_declared_ex, -- Q17 reserved; informational, NEVER a cost lane

  -- Flags (one vocabulary — identical meaning in view + panel + API, D-M4)
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
  -- Surfaces MUST render NULL as "— costs incomplete: <cost_flag>" — never as a number
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
WHERE j.org_id  = '00000000-0000-0000-0000-000000000001'
  AND j.legacy  = false
  AND j.status != 'cancelled'     -- D-M5: 12 cancelled makesafes excluded
  AND j.type    = 'makesafe';     -- V1 SCOPE: remove at M6 to expand to all jobs


-- ============================================================
-- 4. v_makesafe_charge_ledger
--    Per-line audit ledger for make-safe jobs.
--    Reads v_trade_charge_resolved — same cost definition as job_financials (Dim 7).
--    Corrected from draft: 'SWMS-%' pattern (not 'SWM-%'), canonical resolver,
--    no OR-join fanout, no LEFT-JOIN-defeating WHERE.
-- ============================================================
CREATE OR REPLACE VIEW v_makesafe_charge_ledger AS
SELECT
  j.job_number,
  j.client_name,
  u.name                       AS trade_name,
  r.week_start,
  r.xero_bill_id,
  r.cost_lane,
  r.line_total_ex,
  r.total_hours,
  r.line_date,
  r.attributed_direct
FROM v_trade_charge_resolved r
JOIN jobs  j ON j.id = r.resolved_job_id
JOIN users u ON u.id = r.user_id
WHERE j.type = 'makesafe'
   OR j.job_number ILIKE 'SWMS-%';


-- ============================================================
-- 5. v_job_double_charge
--    Double-charge detector: same trade charged labour on the same job
--    across multiple weeks. Reads v_makesafe_charge_ledger.
-- ============================================================
CREATE OR REPLACE VIEW v_job_double_charge AS
SELECT
  job_number,
  trade_name,
  COUNT(DISTINCT week_start)   AS weeks_charged,
  SUM(line_total_ex)           AS total_charged
FROM v_makesafe_charge_ledger
WHERE cost_lane = 'labour'
GROUP BY job_number, trade_name
HAVING COUNT(DISTINCT week_start) > 1;


-- ============================================================
-- READ ACTION: get_job_financials(p_job_id text)
--
--   Called by ops-api action 'job_financials' (M3).
--   Returns the full job_financials row for a single job plus
--   the line-level cost detail from v_trade_charge_resolved.
--
--   Usage: SELECT * FROM get_job_financials('uuid-here');
--
--   NOTE: This is a SQL function (STABLE, SECURITY DEFINER) so the
--   ops-api edge function can call it without RLS blocking — consistent
--   with how all other read actions work in this codebase.
--   The function reads only job_financials + v_trade_charge_resolved
--   (both read-only views). No writes.
-- ============================================================
CREATE OR REPLACE FUNCTION get_job_financials(p_job_id uuid)
RETURNS TABLE (
  -- job_financials columns
  job_id                    uuid,
  job_number                text,
  client_name               text,
  job_type                  text,
  status                    text,
  created_at                timestamptz,
  client_invoiced_ex        numeric,
  draft_revenue_ex          numeric,
  client_collected_ex       numeric,
  cost_labour_ex            numeric,
  cost_materials_ex         numeric,
  cost_commission_ex        numeric,
  cost_card_fees_ex         numeric,
  cost_other_ex             numeric,
  wo_allocation_declared_ex numeric,
  revenue_flag              text,
  cost_flag                 text,
  net_margin_ex             numeric,
  margin_pct                numeric,
  -- line-level detail (from v_trade_charge_resolved)
  lines                     jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    jf.job_id,
    jf.job_number,
    jf.client_name,
    jf.job_type,
    jf.status,
    jf.created_at,
    jf.client_invoiced_ex,
    jf.draft_revenue_ex,
    jf.client_collected_ex,
    jf.cost_labour_ex,
    jf.cost_materials_ex,
    jf.cost_commission_ex,
    jf.cost_card_fees_ex,
    jf.cost_other_ex,
    jf.wo_allocation_declared_ex,
    jf.revenue_flag,
    jf.cost_flag,
    jf.net_margin_ex,
    jf.margin_pct,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'line_id',         r.line_id,
            'trade_invoice_id',r.trade_invoice_id,
            'user_id',         r.user_id,
            'week_start',      r.week_start,
            'cost_lane',       r.cost_lane,
            'line_type',       r.line_type,
            'description',     r.description,
            'total_hours',     r.total_hours,
            'hourly_rate',     r.hourly_rate,
            'line_total_ex',   r.line_total_ex,
            'line_date',       r.line_date,
            'attributed_direct', r.attributed_direct
          )
          ORDER BY r.line_date, r.week_start
        )
        FROM v_trade_charge_resolved r
        WHERE r.resolved_job_id = p_job_id
      ),
      '[]'::jsonb
    ) AS lines
  FROM job_financials jf
  WHERE jf.job_id = p_job_id;
$$;
