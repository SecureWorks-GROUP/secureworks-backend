-- Job Profit line evidence for many jobs in one read (R57, Road to done P2),
-- 2 Nov 2026.
--
-- job_profit_line_evidence(job) read v_job_cost_events once per job (about
-- 0.8 s each), and job_profit_line_evidence_score() called it for every
-- candidate job. With customer-invoice evidence loaded, about 500 jobs become
-- candidates, so the score would take minutes. This adds
-- job_profit_line_evidence_many(job_ids): the same rule r57-v1 and the same
-- output per job, computed for a set of jobs from one read of the cost view.
-- job_profit_line_evidence(job) and the score now call it. The per-job output
-- is unchanged (checked against the previous function on live data before
-- release, read_at aside).
-- Rollback: supabase/rollbacks/20261102140000_job_profit_line_evidence_many_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.job_profit_line_evidence_many(p_job_ids uuid[])
RETURNS TABLE (job_id uuid, result jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
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
  SELECT l.invoice_job_id AS job_id, 'invoice_line'::text AS kind, l.cost_source_id AS ref, l.invoice_number AS document, l.description,
         l.division, l.line_ex AS amount_ex, l.invoice_date AS line_date, 'revenue'::text AS lane,
         e.allocation, e.job_id AS ev_job_id, e.job_number AS ev_job_number, e.evidenced, e.basis, e.document_ref, e.revision
  FROM public.v_xero_lines l
  LEFT JOIN ev e ON e.xero_invoice_id = l.xero_invoice_id AND e.xero_line_item_id = l.line_item_id
  WHERE l.invoice_type = 'ACCREC' AND l.invoice_job_id IN (SELECT j.job_id FROM jobs_in j)
),
direct AS (
  SELECT c.job_id, c.source AS kind, c.source_id AS ref, c.document_number AS document, c.description,
         xl.division, c.amount_ex, c.event_date AS line_date, c.lane,
         m.allocation, m.job_id AS ev_job_id, m.job_number AS ev_job_number, m.evidenced, m.basis, m.document_ref, m.revision
  FROM cost c
  LEFT JOIN public.v_xero_lines xl ON c.source = 'supplier_bill' AND xl.cost_source_id = c.source_id
  LEFT JOIN trade_bill tb ON c.source = 'trade_line' AND tb.line_id = c.source_id
  LEFT JOIN LATERAL (
    SELECT e.* FROM ev e
    WHERE (c.source = 'supplier_bill' AND e.xero_invoice_id = xl.xero_invoice_id AND e.xero_line_item_id = xl.line_item_id)
       OR (c.source = 'trade_line' AND (e.trade_invoice_line_id::text = c.source_id
           OR (e.xero_invoice_id = tb.xero_bill_id AND e.job_id = c.job_id AND abs(coalesce(e.amount_ex_gst, 0) - c.amount_ex) <= 0.01)))
    ORDER BY (e.job_id = c.job_id) DESC NULLS LAST
    LIMIT 1
  ) m ON true
  WHERE c.source IN ('supplier_bill', 'trade_line')
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
    SELECT count(*) AS n, sum(e.amount_ex_gst) AS ex, max(e.revision) AS revision
    FROM ev e WHERE e.xero_invoice_id = c.document_id AND e.job_id = c.job_id AND e.evidenced AND e.allocation = 'job'
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
        (SELECT bool_and(d.evidenced AND d.ev_job_id = c.job_id) FROM direct d
          WHERE d.job_id = c.job_id AND d.kind = 'supplier_bill' AND split_part(d.ref, ':', 1) = c.document_id)
    END AS v
  ) ok ON true
  WHERE c.source NOT IN ('supplier_bill', 'trade_line', 'materials_fact')
),
not_carried AS (
  SELECT e.job_id, 'not_in_job_profit'::text AS kind, l.cost_source_id AS ref, l.invoice_number AS document, l.description,
         l.division, l.line_ex AS amount_ex, l.invoice_date AS line_date,
         CASE WHEN l.invoice_type = 'ACCREC' THEN 'revenue' ELSE 'cost' END AS lane,
         e.allocation, e.job_id AS ev_job_id, e.job_number AS ev_job_number, e.evidenced, e.basis, e.document_ref, e.revision
  FROM ev e
  JOIN public.v_xero_lines l ON l.xero_invoice_id = e.xero_invoice_id AND l.line_item_id = e.xero_line_item_id
  WHERE e.job_id IN (SELECT j.job_id FROM jobs_in j) AND e.allocation = 'job' AND e.evidenced
    AND NOT (l.invoice_type = 'ACCREC' AND l.invoice_job_id IS NOT DISTINCT FROM e.job_id)
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.job_id = e.job_id AND c.source = 'supplier_bill' AND c.source_id = l.cost_source_id)
    AND NOT EXISTS (SELECT 1 FROM cost c WHERE c.job_id = e.job_id AND c.source = 'materials_fact' AND c.document_id = l.xero_invoice_id)
    AND NOT EXISTS (SELECT 1 FROM cost c JOIN trade_bill tb ON tb.line_id = c.source_id
                     WHERE c.job_id = e.job_id AND c.source = 'trade_line' AND tb.xero_bill_id = l.xero_invoice_id)
),
items AS (
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
         coalesce(sum(i.amount_ex) FILTER (WHERE i.state <> 'evidenced'), 0) AS gap_ex
  FROM jobs_in j
  LEFT JOIN items i ON i.job_id = j.job_id
  GROUP BY j.job_id
)
SELECT t.job_id, jsonb_build_object(
  'job_id', t.job_id,
  'rule', 'r57-v1',
  'status', CASE WHEN t.n = 0 THEN 'no_lines'
                 WHEN t.rev_n > 0 AND t.ok = t.n THEN 'verified'
                 ELSE 'provisional' END,
  'items', t.n, 'evidenced', t.ok,
  'invoice_lines', t.rev_n, 'invoice_lines_evidenced', t.rev_ok,
  'cost_items', t.cost_n, 'cost_items_evidenced', t.cost_ok,
  'evidence_says_elsewhere', t.elsewhere, 'not_in_job_profit', t.not_carried,
  'evidenced_ex', round(t.ok_ex, 2), 'not_evidenced_ex', round(t.gap_ex, 2),
  'why_not_verified', array_remove(ARRAY[
     CASE WHEN t.n = 0 THEN 'no invoice or cost lines' END,
     CASE WHEN t.rev_n = 0 AND t.n > 0 THEN 'no customer-invoice lines' END,
     CASE WHEN t.rev_n > t.rev_ok THEN (t.rev_n - t.rev_ok) || ' customer-invoice line(s) without evidence' END,
     CASE WHEN t.cost_n > t.cost_ok THEN (t.cost_n - t.cost_ok) || ' cost item(s) without evidence for this job' END,
     CASE WHEN t.not_carried > 0 THEN t.not_carried || ' evidenced line(s) Job Profit does not carry' END], NULL),
  'lines', coalesce((
     SELECT jsonb_agg(jsonb_build_object(
       'kind', i.kind, 'ref', i.ref, 'document', i.document, 'description', left(i.description, 160),
       'division', i.division, 'lane', i.lane, 'amount_ex', round(i.amount_ex, 2), 'date', i.line_date,
       'state', i.state, 'allocation', i.allocation, 'evidence_job_number', i.ev_job_number,
       'basis', i.basis, 'document_ref', left(i.document_ref, 16), 'revision', i.revision)
       ORDER BY (i.state = 'evidenced'), i.line_date, i.ref)
     FROM items i WHERE i.job_id = t.job_id), '[]'::jsonb),
  'read_at', now())
FROM tally t;
$fn$;
COMMENT ON FUNCTION public.job_profit_line_evidence_many(uuid[]) IS
  'R57 rule r57-v1 (20261102140000): job_profit_line_evidence for a set of jobs from one read of v_job_cost_events; one row per distinct non-null job id asked for. Service role only.';
REVOKE ALL ON FUNCTION public.job_profit_line_evidence_many(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_line_evidence_many(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.job_profit_line_evidence(p_job_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
SELECT m.result FROM public.job_profit_line_evidence_many(ARRAY[p_job_id]) m;
$fn$;

CREATE OR REPLACE FUNCTION public.job_profit_line_evidence_score(p_from date DEFAULT DATE '2026-07-01', p_to date DEFAULT DATE '2026-11-01')
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
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
  SELECT x.invoice_job_id AS job_id
  FROM xl x WHERE x.invoice_type = 'ACCREC' AND x.invoice_job_id IS NOT NULL
  GROUP BY x.invoice_job_id
  HAVING bool_and(coalesce(x.evidenced, false) AND x.allocation = 'job' AND x.ev_job_id = x.invoice_job_id)
)
SELECT jsonb_build_object(
  'rule', 'r57-v1',
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
  'jobs_with_invoice_lines', (SELECT count(DISTINCT invoice_job_id) FROM xl WHERE invoice_type = 'ACCREC' AND invoice_job_id IS NOT NULL),
  'jobs_verified', (SELECT count(*) FROM public.job_profit_line_evidence_many(ARRAY(SELECT c.job_id FROM candidates c)) m
                    WHERE m.result ->> 'status' = 'verified'),
  'revisions', coalesce((SELECT jsonb_agg(jsonb_build_object('revision', r.revision, 'sha256', r.sha256, 'facts_in_file', r.facts_in_file,
                          'facts_loaded', r.rows_loaded, 'closed_at', r.closed_at) ORDER BY r.revision)
                         FROM public.bookkeeping_evidence_revisions r WHERE r.status = 'current'), '[]'::jsonb),
  'read_at', now());
$fn$;
