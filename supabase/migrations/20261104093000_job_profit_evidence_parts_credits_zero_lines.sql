-- (Job Profit, finish-line row A2, 3 Nov 2026) The line evidence rule reads what Job Profit now carries, so a
-- finished job is Verified when Bookkeeping's ledger evidences every line with money on it.
--
-- Found by context-system verify/scripts/finish_line.py --rows A2 (a2_gaps.py, read 3 Nov 2026 14:18Z: 61 of 198
-- finished jobs Verified). Four rule gaps in job_profit_line_evidence_many, each ours, none waiting on a document:
--   1. Credit-note lines Bookkeeping places on a job (20261103224500, source_id <note>:<line>:ledger_credit) were
--      only ever checked as "a credit follows its bill", and their document is the credit note, not a bill, so none
--      could be evidenced: 33 such lines on finished jobs (SWF-261138 Fencing Warehouse 10093788 -376.36 and
--      -152.73; SWF-26033 10092846 -100.64, -44.46, -101.82). Now each is checked against Bookkeeping's evidence
--      for that credit-note line itself.
--   2. A split part of a bill line (20261104070000, source_id <bill>:<n>:part<k>) was looked up as a whole Xero
--      line and never found (SWP-261043 Ampelite W207077 line 1 part 2, 297.39). Now it is checked against
--      v_bookkeeping_line_parts_current for that part, at the part's amount; a materials fact also counts the bill's
--      evidenced parts on its job; and a part Bookkeeping places on a job that Job Profit does not carry there is
--      named (not_in_job_profit), as a whole line already is. Parts of super withheld from pay are never cost.
--   3. A supplier credit applied to a bill followed only the bill's supplier-bill lines on the job; a bill that
--      reaches the job through a materials fact left its credit with no evidence (SWF-26380 R&R INV-81735,
--      -1,976.72). Now the credit follows its bill however the bill reaches the job (bill lines or materials fact).
--   4. A $0 line carries no money but was asked for evidence: a quote's text line on a customer invoice (13 lines on
--      5 finished jobs: SWF-261060 INV-0154, INV-0155, INV-0279, INV-0280; SWF-261355; SWF-26695; SWP-26031;
--      SWP-26359), a $0 bill line, a $0 credit share. Now such a line (amount rounds to $0.00) is left out of the
--      check and counted in a new key zero_amount_lines; a job still needs a customer-invoice line with money on it
--      to be Verified. A $0 line on a crew invoice counts as no money only once that crew invoice is in Xero (has its
--      Xero bill); a $0 line on a crew invoice still waiting for acknowledgment is still asked for evidence (four
--      such invoices, SW-INV-H-260716-015 to -018, hold 28 $0 lines each across make-safe jobs).
--   job_profit_line_evidence_score: a $0 customer-invoice line no longer keeps a job out of its Verified candidates
--   (it counts with job_profit_line_evidence_many). Rule label r57-v2 becomes r57-v3. Every other key, the
--   revenue and cost reconciliation and Job Profit's own margin check are unchanged.
--
-- Guards: each function must be the definition this was written against (md5 below, pg_get_functiondef, read from
-- production 3 Nov 2026 14:35Z), or already this migration's; afterwards each must be the rehearsed definition.
-- Re-running it is a no-op.
-- Rollback: supabase/rollbacks/20261104093000_job_profit_evidence_parts_credits_zero_lines_down.sql (the exact
-- earlier definitions).
-- Rehearsed 3 Nov 2026 14:44Z on production in one rolled-back transaction (CIO helper, Claude; this exact DO block,
-- guard passed, after md5 as below): on the 198 finished jobs of the A2 read, Verified 61 to 69; 31 jobs lose
-- unevidenced lines, none gains one, none loses Verified. Newly Verified: SWF-261105, SWF-261136, SWF-261334,
-- SWF-26470, SWF-26850, SWF-26973, SWMS-26949, SWP-26941. Five checked line by line (a Claude check, not a second
-- model): SWF-261105, SWF-261334, SWF-26470, SWF-26850 and SWP-26941 each have Job Profit revenue equal to
-- Bookkeeping's revenue ledger and to Xero's live invoice sub totals, and Job Profit cost equal to Bookkeeping's
-- allocated cost lines plus our employer super, to the cent; every one of those ledger lines equals its Xero bill
-- line (Bookkeeping's Xero pull of 3 Nov 06:20Z). An earlier rehearsal (14:41Z) that also left out $0 lines on crew
-- invoices not yet in Xero gave 78; those nine make-safe jobs carry $0 lines on crew invoices still waiting
-- for acknowledgment (SW-INV-H-260716-015 to -018, SW-INV-H-260804-022 and -023) and stay unverified.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  d_many text := pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure);
  d_score text := pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure);
BEGIN
  IF md5(d_many) = 'bd4fe36c7035eb3a6e28f4be2bebafca' AND md5(d_score) = 'd869f2e39cd71685d86a473e395e751e' THEN
    RAISE NOTICE 'job_profit_line_evidence_many and _score already have 20261104093000';
    RETURN;
  END IF;
  IF md5(d_many) NOT IN ('fa520b9d6721716868c5f2048a367ae5', 'bd4fe36c7035eb3a6e28f4be2bebafca') THEN
    RAISE EXCEPTION 'job_profit_line_evidence_many is not the definition this migration was written against (md5 %)', md5(d_many);
  END IF;
  IF md5(d_score) NOT IN ('669fe32f975cb22739d8d941e8b61b52', 'd869f2e39cd71685d86a473e395e751e') THEN
    RAISE EXCEPTION 'job_profit_line_evidence_score is not the definition this migration was written against (md5 %)', md5(d_score);
  END IF;
  IF md5(d_many) = 'fa520b9d6721716868c5f2048a367ae5' THEN
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
  FROM (SELECT * FROM revenue UNION ALL SELECT * FROM direct UNION ALL SELECT * FROM materials
        UNION ALL SELECT * FROM derived UNION ALL SELECT * FROM not_carried) i
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
         count(*) FILTER (WHERE i.kind <> 'invoice_line' AND i.kind <> 'not_in_job_profit') AS cost_n,
         count(*) FILTER (WHERE i.kind <> 'invoice_line' AND i.kind <> 'not_in_job_profit' AND i.state = 'evidenced') AS cost_ok,
         count(*) FILTER (WHERE i.state = 'not_in_job_profit') AS not_carried,
         count(*) FILTER (WHERE i.state = 'evidence_says_elsewhere') AS elsewhere,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.state = 'evidenced'), 0) AS ok_ex,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.kind = 'invoice_line'), 0) AS rev_ex,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.kind <> 'invoice_line' AND i.kind <> 'not_in_job_profit'), 0) AS cost_ex,
         coalesce(sum(i.amount_ex) FILTER (WHERE i.state <> 'evidenced'), 0) AS gap_ex
  FROM jobs_in j
  LEFT JOIN items i ON i.job_id = j.job_id
  GROUP BY j.job_id
)
SELECT t.job_id, jsonb_build_object(
  'job_id', t.job_id,
  'rule', 'r57-v3',
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
     CASE WHEN t.cost_n > t.cost_ok THEN (t.cost_n - t.cost_ok) || ' cost item(s) without evidence for this job' END,
     CASE WHEN t.not_carried > 0 THEN t.not_carried || ' evidenced line(s) Job Profit does not carry' END,
     CASE WHEN jp.job_id IS NOT NULL AND abs(coalesce(jp.invoiced_ex, 0) - t.rev_ex) > 0.01
          THEN 'Job Profit counts revenue of $' || round(coalesce(jp.invoiced_ex, 0), 2) || ' but the checked invoice lines total $' || round(t.rev_ex, 2) || ' (an invoice without stored lines, or a credit, is not checked)' END,
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
  IF md5(d_score) = '669fe32f975cb22739d8d941e8b61b52' THEN
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
  'rule', 'r57-v3',
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
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) <> 'bd4fe36c7035eb3a6e28f4be2bebafca' THEN
    RAISE EXCEPTION 'job_profit_line_evidence_many after the migration is not the rehearsed definition (md5 %)',
      md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure));
  END IF;
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) <> 'd869f2e39cd71685d86a473e395e751e' THEN
    RAISE EXCEPTION 'job_profit_line_evidence_score after the migration is not the rehearsed definition (md5 %)',
      md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure));
  END IF;
END $mig$;
