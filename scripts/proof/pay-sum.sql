-- Runs after P1-01.1 through P1-01.3 merge and a new-basis ZZTEST invoice exists.
-- Reimbursement fixtures also need P1-03.1 through P1-03.3.
-- Sources: 20260325000003_timer_invoice_system.sql,
-- 20260401000001_invoice_extras.sql, 20261112090000_trade_invoice_commission_super_base.sql;
-- phase-1-5-pay-build-spec, section 2.1 (17 Nov).
-- Inputs: job_number, invoice_id, expected_gross, expected_fund, expected_net,
-- expected_gst, expected_total. All expected figures are independently hand-worked.
WITH target AS (
  SELECT id, org_id
  FROM public.jobs
  WHERE job_number = :'job_number' AND job_number LIKE 'ZZTEST%'
), invoice AS (
  SELECT i.id, i.super_basis, i.subtotal_ex, i.gross_earned, i.super_base_ex,
    i.super_amount, i.net_pay, i.gst_on, i.gst, i.total_inc
  FROM public.trade_invoices i
  JOIN target j ON j.org_id = i.org_id
  WHERE i.id = :'invoice_id'::uuid
    AND (SELECT count(*) FROM target) = 1
    AND EXISTS (SELECT 1 FROM public.trade_invoice_lines l
      WHERE l.trade_invoice_id = i.id AND l.job_id = j.id)
    -- A weekly invoice containing other jobs is outside this single-job proof.
    AND NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines l
      WHERE l.trade_invoice_id = i.id AND l.job_id IS DISTINCT FROM j.id)
), lines AS (
  SELECT l.id, l.line_type, l.line_total_ex
  FROM public.trade_invoice_lines l JOIN invoice i ON i.id = l.trade_invoice_id
), summed AS (
  SELECT count(*) AS line_count,
    count(*) FILTER (WHERE line_total_ex IS NULL OR line_total_ex < 0
      OR line_total_ex <> round(line_total_ex, 2) OR line_type IS NULL) AS invalid_lines,
    sum(line_total_ex) AS gross,
    sum(CASE WHEN line_type = 'reimbursement' THEN 0 ELSE line_total_ex END) AS base,
    sum(CASE WHEN line_type = 'reimbursement' THEN line_total_ex ELSE 0 END) AS reimbursements,
    jsonb_agg(jsonb_build_object('line_id', id, 'line_type', line_type,
      'amount_ex', line_total_ex, 'in_fund_base', line_type <> 'reimbursement') ORDER BY id) AS lines
  FROM lines
), calculated AS (
  SELECT s.*, round(base * 12 / 112, 2) AS fund,
    CASE WHEN i.gst_on THEN round(base / 10, 2) ELSE 0 END AS calculated_gst
  FROM summed s LEFT JOIN invoice i ON true
), expected AS (
  SELECT :'expected_gross'::numeric AS gross, :'expected_fund'::numeric AS fund,
    :'expected_net'::numeric AS net, :'expected_gst'::numeric AS gst,
    :'expected_total'::numeric AS total
)
SELECT CASE WHEN (SELECT count(*) FROM target) = 1 AND i.id IS NOT NULL
    AND c.line_count > 0 AND c.invalid_lines = 0
    AND i.super_basis = 'inclusive_12_112_v1' AND i.gst_on IS NOT NULL
    AND i.subtotal_ex = c.gross AND i.gross_earned = c.gross
    AND coalesce(i.super_base_ex, i.gross_earned) = c.base
    AND i.super_amount = c.fund AND i.net_pay = c.gross - c.fund
    AND i.gst = c.calculated_gst AND i.total_inc = c.gross + c.calculated_gst
    AND c.gross = e.gross AND c.fund = e.fund AND c.gross - c.fund = e.net
    AND c.calculated_gst = e.gst AND c.gross + c.calculated_gst = e.total
  THEN 'PASS' ELSE 'FAIL' END AS result,
  (SELECT count(*) FROM target) AS matched_jobs, i.id AS invoice_id,
  i.super_basis, c.line_count, c.invalid_lines, c.lines, c.reimbursements,
  jsonb_build_object('gross', i.gross_earned, 'base', i.super_base_ex,
    'fund', i.super_amount, 'net', i.net_pay, 'gst', i.gst, 'total', i.total_inc) AS stored,
  jsonb_build_object('gross', c.gross, 'base', c.base, 'fund', c.fund,
    'net', c.gross - c.fund, 'gst', c.calculated_gst,
    'total', c.gross + c.calculated_gst) AS calculated,
  jsonb_build_object('gross', e.gross, 'fund', e.fund, 'net', e.net,
    'gst', e.gst, 'total', e.total) AS hand_worked
FROM calculated c CROSS JOIN expected e
LEFT JOIN invoice i ON true;
