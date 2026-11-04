-- (Job Profit, finish-line row A2, 3 Nov 2026) A credit follows the document it was applied to, in the line evidence
-- rule and in the Xero project check, so two kinds of gap that were ours to fix leave the finished-job read.
--
-- Found by context-system verify/scripts/finish_line.py --rows A2 (a2_gaps.py, read 3 Nov 2026 19:23Z: 69 of 198
-- finished jobs Verified; of the other 129, 88 had a gap that was ours or named no document). Two of those gap kinds
-- are rules in this database, each with no outside document to wait on:
--   1. revenue_credit_not_checked (SW1346, SWF-26813). Job Profit nets a credit applied in Xero to a customer invoice
--      from revenue (v_job_revenue_events credit_applied: CN-1365, 559.90 inc GST, on INV-1075; CN-1548, 0.18 inc, on
--      INV-1466), but job_profit_line_evidence_many checked invoice lines only, so revenue never reconciled and the job
--      could not read Verified. Now (rule r57-v4) such a credit is an item of its own that follows its invoice, as a
--      supplier credit follows its bill: evidenced when every line with money on that invoice is evidenced to the job;
--      it counts with revenue, never with cost, and a credit on an invoice that is not evidenced is named
--      ("credit(s) applied in Xero to an invoice not evidenced to this job"). Bookkeeping's revenue ledger lists
--      invoices only, never customer credit notes, so no ledger row could ever evidence the credit itself.
--   2. job_xero_project_credit_one_side (SWF-26614, SWF-26831). v_job_profit withholds a margin when the job's Xero
--      project holds more than the cost lines (project_exceeds_line_costs, a check figure: M4). A Xero project holds a
--      credited bill at its full amount, while the cost lines net the supplier credit, so a credit alone tripped the
--      check: SWF-26614 project 4,131.56 = cost lines 4,057.92 + credit 73.64; SWF-26831 project 2,077.81 = 1,995.99
--      + credit note 84701 81.82, both to the cent. The check now compares the project with the cost lines before
--      supplier credits. Actual cost, profit and every other flag still read the cost lines net of credits.
-- Not changed (reported, not built): the check still counts our employer super on crew lines, which no Xero project
-- holds, so the project is compared with a figure that is higher by that super.
-- job_profit_line_evidence_score: only its rule label moves (r57-v3 to r57-v4); it counts Verified jobs through
-- job_profit_line_evidence_many, so it counts the same rule.
--
-- Guards: each object must be the definition this was written against (md5 below: pg_get_functiondef, and
-- pg_get_viewdef(..., true) in UTC; read from production 3 Nov 2026 19:4xZ, newest applied migration 20261104175000),
-- or already this migration's; every replaced fragment of v_job_profit must be there exactly once; afterwards each
-- object must be the rehearsed definition. Re-running it is a no-op. CREATE OR REPLACE keeps every grant;
-- v_job_profit's columns do not change.
-- Rollback: supabase/rollbacks/20261104200500_job_profit_credits_follow_their_documents_down.sql (the exact earlier
-- definitions).
-- Rehearsed 3 Nov 2026 19:56-19:59Z on production in one transaction ended by RAISE EXCEPTION (nothing kept; CIO
-- helper, Claude; this file's SQL twice, its rollback twice): md5 before v_job_profit ac6290ae, many bd4fe36c, score
-- d869f2e3; after 1ac286e9, b9114d87, 26beb477; after the rollback the before md5s again. Of 2,008 job rows, actual
-- cost (778,402.17) and invoiced (2,105,963.68) did not move; margins shown 354 to 357; Xero project flags 118 to 113.
-- Five jobs moved, each only off the project flag: SWF-261280 (margin 36.9%), SWF-261527 (54.7%) and SWF-26614
-- (39.7%) now show their margin; SWF-261600 is held for no crew labour line and SWF-26831 for materials below the
-- quote, as their next check says. Finished jobs (the A2 read, 198): Verified 69 to 70 (SWF-26813); SW1346's credit
-- is now evidenced (its other gaps stand).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- v_job_profit's text carries a timestamp, which prints in the session's time zone; the md5 guards are taken in UTC.
SET LOCAL TimeZone = 'UTC';

-- 1. The line evidence rule (r57-v4): a credit applied in Xero to a customer invoice follows its invoice.
DO $mig$
DECLARE
  d_many text := pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure);
  d_score text := pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure);
BEGIN
  IF md5(d_many) = 'b9114d87ccc74b6171bbb51d92be69b4' AND md5(d_score) = '26beb477a6461e70160c39b493f98c7f' THEN
    RAISE NOTICE 'job_profit_line_evidence_many and _score already have 20261104200500';
    RETURN;
  END IF;
  IF md5(d_many) NOT IN ('bd4fe36c7035eb3a6e28f4be2bebafca', 'b9114d87ccc74b6171bbb51d92be69b4') THEN
    RAISE EXCEPTION 'job_profit_line_evidence_many is not the definition this migration was written against (md5 %)', md5(d_many);
  END IF;
  IF md5(d_score) NOT IN ('d869f2e39cd71685d86a473e395e751e', '26beb477a6461e70160c39b493f98c7f') THEN
    RAISE EXCEPTION 'job_profit_line_evidence_score is not the definition this migration was written against (md5 %)', md5(d_score);
  END IF;
  IF md5(d_many) = 'bd4fe36c7035eb3a6e28f4be2bebafca' THEN
    EXECUTE $def$CREATE OR REPLACE FUNCTION public.job_profit_line_evidence_many(p_job_ids uuid[])
 RETURNS TABLE(job_id uuid, result jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH jobs_in AS (
  SELECT DISTINCT u AS job_id FROM unnest(p_job_ids) u WHERE u IS NOT NULL
),
ev AS (
  SELECT * FROM public.v_bookkeeping_line_evidence_current
),
cost AS (
  SELECT c.job_id, c.source, c.source_id, c.document_id, c.document_number, c.description, c.amount_ex, c.event_date, c.lane
  FROM public.v_job_cost_events c
  WHERE c.job_id IN (SELECT j.job_id FROM jobs_in j) AND c.is_actual
),
trade_bill AS (
  SELECT til.id::text AS line_id, ti.xero_bill_id
  FROM public.trade_invoice_lines til
  JOIN public.trade_invoices ti ON ti.id = til.trade_invoice_id
  WHERE til.id::text IN (SELECT split_part(source_id, ':', 1) FROM cost WHERE source IN ('trade_line', 'trade_employer_super'))
),
revenue AS (
  SELECT COALESCE(l.invoice_job_id, CASE WHEN e.allocation = 'job' AND e.evidenced THEN e.job_id END) AS job_id, 'invoice_line'::text AS kind, l.cost_source_id AS ref, l.invoice_number AS document, l.description,
         l.division, l.line_ex AS amount_ex, l.invoice_date AS line_date, 'revenue'::text AS lane,
         e.allocation, e.job_id AS ev_job_id, e.job_number AS ev_job_number, e.evidenced, e.basis, e.document_ref, e.revision
  FROM public.v_xero_lines l
  LEFT JOIN ev e ON e.xero_invoice_id = l.xero_invoice_id AND e.xero_line_item_id = l.line_item_id
  WHERE l.invoice_type = 'ACCREC'
    AND COALESCE(l.invoice_job_id, CASE WHEN e.allocation = 'job' AND e.evidenced THEN e.job_id END) IN (SELECT j.job_id FROM jobs_in j)
),
rev_credit AS (
  -- a credit applied in Xero to a customer invoice (credit note, overpayment or prepayment: v_job_revenue_events
  -- credit_applied) follows its invoice, as a supplier credit follows its bill: evidenced when every line with money
  -- on that invoice is evidenced to this job
  SELECT e.job_id, e.kind, e.source_id AS ref, e.document_number AS document, e.description,
         NULL::text AS division, e.amount_ex, e.invoice_date AS line_date, 'revenue'::text AS lane,
         CASE WHEN ok.v THEN 'job' END AS allocation, CASE WHEN ok.v THEN e.job_id END AS ev_job_id,
         NULL::text AS ev_job_number, coalesce(ok.v, false) AS evidenced, 'follows its invoice'::text AS basis,
         NULL::text AS document_ref, NULL::text AS revision
  FROM public.v_job_revenue_events e
  LEFT JOIN LATERAL (
    SELECT bool_and(r.evidenced AND r.allocation = 'job' AND r.ev_job_id = e.job_id) AS v
    FROM revenue r
    WHERE r.job_id = e.job_id AND split_part(r.ref, ':', 1) = e.document_id AND round(r.amount_ex, 2) <> 0
  ) ok ON true
  WHERE e.kind = 'credit_applied' AND e.counts_as_invoiced AND e.job_id IN (SELECT j.job_id FROM jobs_in j)
),
direct AS (
  -- a split part of a bill line (source_id <bill>:<n>:part<k>) is checked against Bookkeeping's part evidence for
  -- that part, at the part's amount; a credit-note line Bookkeeping places (source_id <note>:<line>:ledger_credit)
  -- against Bookkeeping's evidence for that credit-note line
  SELECT c.job_id, c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         xl.division, c.amount_ex, c.event_date AS line_date, c.lane,
         coalesce(pe.allocation, m.allocation) AS allocation, coalesce(pe.job_id, m.job_id) AS ev_job_id,
         coalesce(pe.job_number, m.job_number) AS ev_job_number,
         CASE WHEN pe.part IS NOT NULL THEN pe.evidenced AND abs(pe.amount_ex_gst - c.amount_ex) <= 0.01 ELSE m.evidenced END AS evidenced,
         coalesce(pe.basis, m.basis) AS basis, coalesce(pe.document_ref, m.document_ref) AS document_ref,
         coalesce(pe.revision, m.revision) AS revision
  FROM cost c
  LEFT JOIN public.v_xero_lines xl ON c.source = 'supplier_bill' AND xl.cost_source_id = regexp_replace(c.source_id, ':part[0-9]+$', '')
  LEFT JOIN trade_bill tb ON c.source = 'trade_line' AND tb.line_id = c.source_id
  LEFT JOIN LATERAL (
    SELECT e.* FROM ev e
    WHERE (c.source = 'supplier_bill' AND c.source_id !~ ':part[0-9]+$' AND e.xero_invoice_id = xl.xero_invoice_id AND e.xero_line_item_id = xl.line_item_id)
       OR (c.source = 'trade_line' AND (e.trade_invoice_line_id::text = c.source_id
           OR (e.xero_invoice_id = tb.xero_bill_id AND e.job_id = c.job_id AND abs(coalesce(e.amount_ex_gst, 0) - c.amount_ex) <= 0.01)))
       OR (c.source = 'supplier_credit' AND c.source_id LIKE '%:ledger_credit'
           AND e.xero_invoice_id = split_part(c.source_id, ':', 1) AND e.xero_line_item_id = split_part(c.source_id, ':', 2))
    ORDER BY (e.job_id = c.job_id) DESC NULLS LAST
    LIMIT 1
  ) m ON true
  LEFT JOIN LATERAL (
    SELECT p.part, p.allocation, p.job_id, p.job_number, p.evidenced, p.basis, p.document_ref, p.revision, p.amount_ex_gst
    FROM public.v_bookkeeping_line_parts_current p
    WHERE c.source = 'supplier_bill' AND c.source_id ~ ':part[0-9]+$'
      AND p.xero_invoice_id = xl.xero_invoice_id AND p.xero_line_item_id = xl.line_item_id
      AND p.part = substring(c.source_id FROM ':part([0-9]+)$')::integer
    LIMIT 1
  ) pe ON true
  WHERE c.source IN ('supplier_bill', 'trade_line')
     OR (c.source = 'supplier_credit' AND c.source_id LIKE '%:ledger_credit')
),
materials AS (
  SELECT c.job_id, c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         NULL::text AS division, c.amount_ex, c.event_date AS line_date, c.lane,
         CASE WHEN s.n > 0 THEN 'job' END AS allocation,
         CASE WHEN s.n > 0 THEN c.job_id END AS ev_job_id, NULL::text AS ev_job_number,
         coalesce(s.n > 0 AND abs(s.ex - c.amount_ex) <= 1.00, false) AS evidenced,
         CASE WHEN s.n > 0 THEN s.n || ' evidenced bill line(s), $' || round(s.ex, 2) END AS basis,
         NULL::text AS document_ref, s.revision
  FROM cost c
  LEFT JOIN LATERAL (
    SELECT count(*) AS n, sum(x.ex) AS ex, max(x.revision) AS revision
    FROM (SELECT e.amount_ex_gst AS ex, e.revision FROM ev e
           WHERE e.xero_invoice_id = c.document_id AND e.job_id = c.job_id AND e.evidenced AND e.allocation = 'job'
          UNION ALL
          SELECT p.amount_ex_gst, p.revision FROM public.v_bookkeeping_line_parts_current p
           WHERE p.xero_invoice_id = c.document_id AND p.job_id = c.job_id AND p.evidenced AND p.allocation = 'job'
             AND NOT p.super_withheld) x
  ) s ON true
  WHERE c.source = 'materials_fact'
),
derived AS (
  SELECT c.job_id, c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         NULL::text AS division, c.amount_ex, c.event_date AS line_date, c.lane,
         CASE WHEN ok.v THEN 'job' END AS allocation, CASE WHEN ok.v THEN c.job_id END AS ev_job_id,
         NULL::text AS ev_job_number, coalesce(ok.v, false) AS evidenced,
         CASE c.source WHEN 'trade_employer_super' THEN 'follows its crew line' ELSE 'follows its bill' END AS basis,
         NULL::text AS document_ref, NULL::text AS revision
  FROM cost c
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN c.source = 'trade_employer_super' THEN
        (SELECT bool_and(d.evidenced AND d.ev_job_id = c.job_id) FROM direct d
          WHERE d.job_id = c.job_id AND d.kind = 'trade_line' AND d.ref = split_part(c.source_id, ':', 1))
      ELSE
        (SELECT bool_and(b.evidenced AND b.ev_job_id = c.job_id) FROM (
           SELECT d.evidenced, d.ev_job_id FROM direct d
            WHERE d.job_id = c.job_id AND d.kind = 'supplier_bill' AND split_part(d.ref, ':', 1) = c.document_id
           UNION ALL
           SELECT mt.evidenced, mt.ev_job_id FROM materials mt
             JOIN cost cf ON cf.job_id = mt.job_id AND cf.source = 'materials_fact' AND cf.source_id = mt.ref
            WHERE mt.job_id = c.job_id AND cf.document_id = c.document_id) b)
    END AS v
  ) ok ON true
  WHERE c.source NOT IN ('supplier_bill', 'trade_line', 'materials_fact')
    AND NOT (c.source = 'supplier_credit' AND c.source_id LIKE '%:ledger_credit')
),
not_carried AS (
  SELECT e.job_id, 'not_in_job_profit'::text AS kind, l.cost_source_id AS ref, l.invoice_number AS document, l.description,
         l.division, l.line_ex AS amount_ex, l.invoice_date AS line_date,
         CASE WHEN l.invoice_type = 'ACCREC' THEN 'revenue' ELSE 'cost' END AS lane,
         e.allocation, e.job_id AS ev_job_id, e.job_number AS ev_job_number, e.evidenced, e.basis, e.document_ref, e.revision
  FROM ev e
  JOIN public.v_xero_lines l ON l.xero_invoice_id = e.xero_invoice_id AND l.line_item_id = e.xero_line_item_id
  WHERE e.job_id IN (SELECT j.job_id FROM jobs_in j) AND e.allocation = 'job' AND e.evidenced
    AND NOT (l.invoice_type = 'ACCREC' AND COALESCE(l.invoice_job_id, e.job_id) IS NOT DISTINCT FROM e.job_id)
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.job_id = e.job_id AND c.source = 'supplier_bill' AND c.source_id = l.cost_source_id)
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.job_id = e.job_id AND c.source = 'materials_fact' AND c.document_id = l.xero_invoice_id)
    AND NOT EXISTS (SELECT 1 FROM cost c JOIN trade_bill tb ON tb.line_id = c.source_id
                     WHERE c.job_id = e.job_id AND c.source = 'trade_line' AND tb.xero_bill_id = l.xero_invoice_id)
  UNION ALL
  SELECT p.job_id, 'not_in_job_profit'::text, l.cost_source_id || ':part' || p.part, l.invoice_number, l.description,
         l.division, p.amount_ex_gst, l.invoice_date, 'cost'::text,
         p.allocation, p.job_id, p.job_number, p.evidenced, p.basis, p.document_ref, p.revision
  FROM public.v_bookkeeping_line_parts_current p
  JOIN public.v_xero_lines l ON l.xero_invoice_id = p.xero_invoice_id AND l.line_item_id = p.xero_line_item_id
  WHERE p.job_id IN (SELECT j.job_id FROM jobs_in j) AND p.allocation = 'job' AND p.evidenced AND NOT p.super_withheld
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.job_id = p.job_id AND c.source = 'supplier_bill'
                     AND c.source_id IN (l.cost_source_id, l.cost_source_id || ':part' || p.part))
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.job_id = p.job_id AND c.source = 'materials_fact' AND c.document_id = l.xero_invoice_id)
    AND NOT EXISTS (SELECT 1 FROM cost c JOIN trade_bill tb ON tb.line_id = c.source_id
                     WHERE c.job_id = p.job_id AND c.source = 'trade_line' AND tb.xero_bill_id = l.xero_invoice_id)
),
items_all AS (
  SELECT i.*,
    CASE
      WHEN i.kind = 'not_in_job_profit' THEN 'not_in_job_profit'
      WHEN i.evidenced AND i.allocation = 'job' AND i.ev_job_id = i.job_id THEN 'evidenced'
      WHEN i.evidenced AND (i.allocation <> 'job' OR i.ev_job_id IS DISTINCT FROM i.job_id) THEN 'evidence_says_elsewhere'
      ELSE 'no_evidence'
    END AS state
  FROM (SELECT * FROM revenue UNION ALL SELECT * FROM rev_credit UNION ALL SELECT * FROM direct
        UNION ALL SELECT * FROM materials UNION ALL SELECT * FROM derived UNION ALL SELECT * FROM not_carried) i
),
items_zero AS (
  -- a $0 line carries no money (a quote's text line on an invoice, a $0 bill line, a $0 credit share, a $0 line on a
  -- crew invoice already in Xero): it is not asked for evidence. A $0 line on a crew invoice not yet in Xero still is.
  SELECT i.*, coalesce(round(i.amount_ex, 2) = 0 AND (i.kind <> 'trade_line' OR EXISTS (
           SELECT 1 FROM trade_bill tb WHERE tb.line_id = i.ref AND tb.xero_bill_id IS NOT NULL)), false) AS zero_line
  FROM items_all i
),
items AS (
  SELECT * FROM items_zero WHERE NOT zero_line
),
zero AS (
  SELECT z.job_id, count(*) AS n FROM items_zero z WHERE z.zero_line GROUP BY z.job_id
),
jp AS (
  -- Job Profit's own check: a profit it withholds cannot be verified
  SELECT p.job_id, p.margin_ok, p.cost_flag, p.invoiced_ex, p.actual_cost_ex
  FROM public.v_job_profit p
  WHERE p.job_id IN (SELECT j.job_id FROM jobs_in j)
),
tally AS (
  SELECT j.job_id,
         count(i.kind) AS n,
         count(*) FILTER (WHERE i.state = 'evidenced') AS ok,
         count(*) FILTER (WHERE i.kind = 'invoice_line') AS rev_n,
         count(*) FILTER (WHERE i.kind = 'invoice_line' AND i.state = 'evidenced') AS rev_ok,
         count(*) FILTER (WHERE i.kind = 'credit_applied') AS cred_n,
         count(*) FILTER (WHERE i.kind = 'credit_applied' AND i.state = 'evidenced') AS cred_ok,
         count(*) FILTER (WHERE i.kind NOT IN ('invoice_line', 'credit_applied', 'not_in_job_profit')) AS cost_n,
         count(*) FILTER (WHERE i.kind NOT IN ('invoice_line', 'credit_applied', 'not_in_job_profit') AND i.state = 'evidenced') AS cost_ok,
         count(*) FILTER (WHERE i.state = 'not_in_job_profit') AS not_carried,
         count(*) FILTER (WHERE i.state = 'evidence_says_elsewhere') AS elsewhere,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.state = 'evidenced'), 0) AS ok_ex,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.kind IN ('invoice_line', 'credit_applied')), 0) AS rev_ex,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.kind NOT IN ('invoice_line', 'credit_applied', 'not_in_job_profit')), 0) AS cost_ex,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.state <> 'evidenced'), 0) AS gap_ex
  FROM jobs_in j
  LEFT JOIN items i ON i.job_id = j.job_id
  GROUP BY j.job_id
)
SELECT t.job_id, jsonb_build_object(
  'job_id', t.job_id,
  'rule', 'r57-v4',
  'status', CASE WHEN t.n = 0 THEN 'no_lines'
                 WHEN t.rev_n > 0 AND t.ok = t.n AND coalesce(jp.margin_ok, false)
                      AND abs(coalesce(jp.invoiced_ex, 0) - t.rev_ex) <= 0.01
                      AND abs(coalesce(jp.actual_cost_ex, 0) - t.cost_ex) <= 0.01 THEN 'verified'
                 ELSE 'provisional' END,
  'items', t.n, 'evidenced', t.ok,
  'invoice_lines', t.rev_n, 'invoice_lines_evidenced', t.rev_ok,
  'cost_items', t.cost_n, 'cost_items_evidenced', t.cost_ok,
  'evidence_says_elsewhere', t.elsewhere, 'not_in_job_profit', t.not_carried,
  'evidenced_ex', round(t.ok_ex, 2), 'not_evidenced_ex', round(t.gap_ex, 2),
  'zero_amount_lines', coalesce(z.n, 0),
  'why_not_verified', array_remove(ARRAY[
     CASE WHEN t.n = 0 THEN 'no invoice or cost lines' END,
     CASE WHEN t.rev_n = 0 AND t.n > 0 THEN 'no customer-invoice lines' END,
     CASE WHEN t.rev_n > t.rev_ok THEN (t.rev_n - t.rev_ok) || ' customer-invoice line(s) without evidence' END,
     CASE WHEN t.cred_n > t.cred_ok THEN (t.cred_n - t.cred_ok) || ' credit(s) applied in Xero to an invoice not evidenced to this job' END,
     CASE WHEN t.cost_n > t.cost_ok THEN (t.cost_n - t.cost_ok) || ' cost item(s) without evidence for this job' END,
     CASE WHEN t.not_carried > 0 THEN t.not_carried || ' evidenced line(s) Job Profit does not carry' END,
     CASE WHEN jp.job_id IS NOT NULL AND abs(coalesce(jp.invoiced_ex, 0) - t.rev_ex) > 0.01
          THEN 'Job Profit counts revenue of $' || round(coalesce(jp.invoiced_ex, 0), 2) || ' but the checked invoice lines total $' || round(t.rev_ex, 2) || ' (an invoice without stored lines is not checked)' END,
     CASE WHEN jp.job_id IS NOT NULL AND abs(coalesce(jp.actual_cost_ex, 0) - t.cost_ex) > 0.01
          THEN 'Job Profit counts cost of $' || round(coalesce(jp.actual_cost_ex, 0), 2) || ' but the checked cost items total $' || round(t.cost_ex, 2) END,
     CASE WHEN t.n > 0 AND NOT coalesce(jp.margin_ok, false)
          THEN 'Job Profit withholds this job''s profit (' || coalesce(jp.cost_flag, 'job not in Job Profit') || ')' END], NULL),
  'reconciles', jsonb_build_object(
     'revenue_job_profit', round(coalesce(jp.invoiced_ex, 0), 2), 'revenue_checked', round(t.rev_ex, 2),
     'cost_job_profit', round(coalesce(jp.actual_cost_ex, 0), 2), 'cost_checked', round(t.cost_ex, 2),
     'ok', jp.job_id IS NOT NULL AND abs(coalesce(jp.invoiced_ex, 0) - t.rev_ex) <= 0.01 AND abs(coalesce(jp.actual_cost_ex, 0) - t.cost_ex) <= 0.01),
  'profit_check', CASE WHEN jp.job_id IS NULL THEN 'not_in_job_profit' WHEN jp.margin_ok THEN 'ok' ELSE coalesce(jp.cost_flag, 'withheld') END,
  'lines', coalesce((
     SELECT jsonb_agg(jsonb_build_object(
       'kind', i.kind, 'ref', i.ref, 'document', i.document, 'description', left(i.description, 160),
       'division', i.division, 'lane', i.lane, 'amount_ex', round(i.amount_ex, 2), 'date', i.line_date,
       'state', i.state, 'allocation', i.allocation, 'evidence_job_number', i.ev_job_number,
       'basis', i.basis, 'document_ref', left(i.document_ref, 16), 'revision', i.revision)
       ORDER BY (i.state = 'evidenced'), i.line_date, i.ref)
     FROM items i WHERE i.job_id = t.job_id), '[]'::jsonb),
  'read_at', now())
FROM tally t
LEFT JOIN jp ON jp.job_id = t.job_id
LEFT JOIN zero z ON z.job_id = t.job_id;
$function$
$def$;
  END IF;
  IF md5(d_score) = 'd869f2e39cd71685d86a473e395e751e' THEN
    EXECUTE $def$CREATE OR REPLACE FUNCTION public.job_profit_line_evidence_score(p_from date DEFAULT '2026-07-01'::date, p_to date DEFAULT '2026-11-01'::date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH xl AS (
  SELECT l.*, e.allocation, e.evidenced, e.job_id AS ev_job_id
  FROM public.v_xero_lines l
  LEFT JOIN public.v_bookkeeping_line_evidence_current e
    ON e.xero_invoice_id = l.xero_invoice_id AND e.xero_line_item_id = l.line_item_id
  WHERE l.invoice_date >= p_from AND l.invoice_date < p_to
),
candidates AS MATERIALIZED (
  -- only a job whose every customer-invoice line in the window is evidenced can be verified;
  -- MATERIALIZED so the per-job check below is never pushed under the GROUP BY
  SELECT COALESCE(x.invoice_job_id, CASE WHEN x.evidenced AND x.allocation = 'job' THEN x.ev_job_id END) AS job_id
  FROM xl x WHERE x.invoice_type = 'ACCREC'
    AND COALESCE(x.invoice_job_id, CASE WHEN x.evidenced AND x.allocation = 'job' THEN x.ev_job_id END) IS NOT NULL
  GROUP BY 1
  HAVING bool_and(coalesce(round(x.line_ex, 2) = 0, false)
                  OR (coalesce(x.evidenced, false) AND x.allocation = 'job' AND x.ev_job_id = COALESCE(x.invoice_job_id, x.ev_job_id)))
)
SELECT jsonb_build_object(
  'rule', 'r57-v4',
  'from', p_from, 'to_before', p_to,
  'invoice_lines', (SELECT jsonb_build_object('lines', count(*), 'ex', round(coalesce(sum(line_ex), 0), 2),
                     'evidenced', count(*) FILTER (WHERE evidenced), 'evidenced_ex', round(coalesce(sum(line_ex) FILTER (WHERE evidenced), 0), 2))
                    FROM xl WHERE invoice_type = 'ACCREC'),
  'cost_lines', (SELECT jsonb_build_object('lines', count(*), 'ex', round(coalesce(sum(line_ex), 0), 2),
                  'evidenced', count(*) FILTER (WHERE evidenced), 'evidenced_ex', round(coalesce(sum(line_ex) FILTER (WHERE evidenced), 0), 2),
                  'to_job', count(*) FILTER (WHERE evidenced AND allocation = 'job'),
                  'to_overhead', count(*) FILTER (WHERE evidenced AND allocation = 'overhead'),
                  'not_job_cost', count(*) FILTER (WHERE evidenced AND allocation = 'not_job_cost'))
                 FROM xl WHERE invoice_type = 'ACCPAY'),
  'invoices_without_stored_lines', (SELECT jsonb_build_object(
      'accrec', count(*) FILTER (WHERE x.invoice_type = 'ACCREC'),
      'accrec_ex', round(coalesce(sum(x.sub_total) FILTER (WHERE x.invoice_type = 'ACCREC'), 0), 2),
      'accpay', count(*) FILTER (WHERE x.invoice_type = 'ACCPAY'),
      'accpay_ex', round(coalesce(sum(x.sub_total) FILTER (WHERE x.invoice_type = 'ACCPAY'), 0), 2))
    FROM public.xero_invoices x
    WHERE x.invoice_type IN ('ACCREC', 'ACCPAY') AND x.status IN ('AUTHORISED', 'SUBMITTED', 'PAID')
      AND x.invoice_date >= p_from AND x.invoice_date < p_to
      AND coalesce(jsonb_typeof(x.line_items), 'null') <> 'array'),
  'jobs_with_invoice_lines', (SELECT count(DISTINCT COALESCE(invoice_job_id, CASE WHEN evidenced AND allocation = 'job' THEN ev_job_id END)) FROM xl
                              WHERE invoice_type = 'ACCREC' AND COALESCE(invoice_job_id, CASE WHEN evidenced AND allocation = 'job' THEN ev_job_id END) IS NOT NULL),
  'jobs_verified', (SELECT count(*) FROM public.job_profit_line_evidence_many(ARRAY(SELECT c.job_id FROM candidates c)) m
                    WHERE m.result ->> 'status' = 'verified'),
  'revisions', coalesce((SELECT jsonb_agg(jsonb_build_object('revision', r.revision, 'sha256', r.sha256, 'facts_in_file', r.facts_in_file,
                          'facts_loaded', r.rows_loaded, 'closed_at', r.closed_at) ORDER BY r.revision)
                         FROM public.bookkeeping_evidence_revisions r WHERE r.status = 'current'), '[]'::jsonb),
  'read_at', now());
$function$
$def$;
  END IF;
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) <> 'b9114d87ccc74b6171bbb51d92be69b4'
     OR md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) <> '26beb477a6461e70160c39b493f98c7f' THEN
    RAISE EXCEPTION 'job_profit_line_evidence_many or _score after the change is not the rehearsed definition (md5 %, %)',
      md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)),
      md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure));
  END IF;
END
$mig$;

-- 2. v_job_profit: the Xero project check compares the project with the cost lines before supplier credits.
--    Only the check moves: actual cost, profit and every other flag read the same cost lines as before.
DO $mig$
DECLARE
  v_def text;
  v_before constant text := 'ac6290aedfe4477b40a6235a7e71d45e';
  v_after constant text := '1ac286e983426f43c67f94fd84268e07';
  v_cost_old constant text := $f$sum(e.amount_ex) FILTER (WHERE e.source = 'po_invoice_emailed'::text) AS invoice_emailed_ex,$f$;
  v_cost_new constant text := $f$sum(e.amount_ex) FILTER (WHERE e.source = 'po_invoice_emailed'::text) AS invoice_emailed_ex,
            sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.source = 'supplier_credit'::text) AS supplier_credits_ex,$f$;
  v_base_old constant text := $f$COALESCE(cost.other_ex, 0::numeric) AS line_other_ex,$f$;
  v_base_new constant text := $f$COALESCE(cost.other_ex, 0::numeric) AS line_other_ex,
            COALESCE(cost.supplier_credits_ex, 0::numeric) AS line_supplier_credits_ex,$f$;
  v_check_old constant text := $f$(b.line_labour_ex + b.line_materials_ex + b.line_commission_ex + b.line_other_ex) < (b.xero_project_expenses_ex - GREATEST(5::numeric, 0.01 * b.xero_project_expenses_ex)) AS project_exceeds_line_costs$f$;
  v_check_new constant text := $f$(b.line_labour_ex + b.line_materials_ex + b.line_commission_ex + b.line_other_ex - b.line_supplier_credits_ex) < (b.xero_project_expenses_ex - GREATEST(5::numeric, 0.01 * b.xero_project_expenses_ex)) AS project_exceeds_line_costs$f$;
BEGIN
  v_def := pg_get_viewdef('public.v_job_profit'::regclass, true);
  IF md5(v_def) = v_after THEN
    RAISE NOTICE 'v_job_profit already compares the Xero project with the cost lines before supplier credits';
    RETURN;
  END IF;
  IF md5(v_def) <> v_before THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_cost_old, ''))) / length(v_cost_old) <> 1
     OR (length(v_def) - length(replace(v_def, v_base_old, ''))) / length(v_base_old) <> 1
     OR (length(v_def) - length(replace(v_def, v_check_old, ''))) / length(v_check_old) <> 1 THEN
    RAISE EXCEPTION 'v_job_profit: a replaced fragment is not there exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS '
    || replace(replace(replace(v_def, v_cost_old, v_cost_new), v_base_old, v_base_new), v_check_old, v_check_new);
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> v_after THEN
    RAISE EXCEPTION 'v_job_profit after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END
$mig$;
