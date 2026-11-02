-- INT-12 / INT-10 / TP-07: include note-side supplier credits in H7's
-- known per-bill credit and source-change witness. Reuses the existing one-side
-- rule and CFO-20 tax conversion; no placement, accounting or pay policy change.
-- Source: 20261029170000 H7, 20261030060000 credit netting, followed by
-- 20261031020000 credit/labour composition. No source writes or flag activation.
-- Payment status stays outside this financial witness (D22/JP-20). Context
-- remains amount-free. Per-bill credit is repeated, never summed across jobs.
-- No note-side sources: preserve original amount, NULL and hash byte-for-byte.
-- Apply/rollback as part of the reviewed package, before any source-view down.
-- Exact fingerprints reject unknown newer owner definitions; requalify, do not
-- bypass them. CREATE OR REPLACE preserves ownership and execution grants.
-- No BEGIN/COMMIT: the deploy script runs each migration in one transaction.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF to_regprocedure('public.cfo_bill_cost_outcomes_scoped(uuid)') IS NULL OR
    to_regclass('public.v_supplier_credit_allocations') IS NULL THEN
  RAISE EXCEPTION 'h7_credit_missing_dependency';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure)
    NOT IN ('ff29056b9f02874242f5b1f4519a128a','63ccf9830493620a7a6140750d141875') OR
    md5(pg_get_viewdef('public.v_supplier_credit_allocations'::regclass)) IS DISTINCT FROM 'e7295d413f5d207385efb0fa3541a1ee' OR
    md5(pg_get_viewdef('public.v_job_cost_events'::regclass)) IS DISTINCT FROM '92d9a2923438e6a1da601e2179ae34e3' OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.job_cost_credit_note_part(numeric,numeric,numeric)')) IS DISTINCT FROM '6a27d945efb54126e6a1f7e122e6b368' THEN
  RAISE EXCEPTION 'h7_credit_preimage_mismatch';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure AND (prosecdef OR proconfig IS NOT NULL OR provolatile<>'s')) THEN
  RAISE EXCEPTION 'h7_credit_function_contract_mismatch';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.cfo_bill_cost_outcomes_scoped(p_job uuid)
 RETURNS TABLE(contract_version text, subject_kind text, xero_invoice_id text, invoice_number text, contact_name text, bill_status text, job_id uuid, job_number text, holding_job boolean, xero_linked boolean, row_source text, placed_by text, counts text, reason text, bill_state text, held_reason text, overhead_part boolean, not_job_related_mark boolean, mirror_bill boolean, bill_counted_jobs integer, counted_ex numeric, placed_ex numeric, bill_ex numeric, overhead_ex numeric, credit_applied_ex numeric, evidence_hash text)
 LANGUAGE sql
 STABLE
AS $function$
WITH
-- The bills in scope: with a job, those placed on it; with none, every bill
-- (each filter below is then true).
scope AS (
  SELECT x.xero_invoice_id FROM public.xero_invoices x
   WHERE x.invoice_type = 'ACCPAY' AND x.job_id = p_job AND x.xero_invoice_id IS NOT NULL
  UNION
  SELECT f.xero_invoice_id FROM public.job_materials_facts f
   WHERE f.kind = 'actual' AND f.job_id = p_job AND f.xero_invoice_id IS NOT NULL
),
bill AS (
  SELECT DISTINCT ON (x.xero_invoice_id)
         x.org_id, x.xero_invoice_id, x.invoice_number, x.contact_name, x.status, x.sub_total, x.total,
         x.line_items, x.raw_json, x.job_id
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY' AND x.xero_invoice_id IS NOT NULL
    AND (p_job IS NULL OR x.xero_invoice_id IN (SELECT s.xero_invoice_id FROM scope s))
  ORDER BY x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC, x.job_id::text COLLATE "C"
),
-- The same original one-side rule as the cost engine. This is a per-bill
-- known applied-credit figure, not a sum of repeated per-job outcome fields.
-- No note-side source leaves the original amount and hash unchanged. Payments
-- and copy clocks are omitted from the witness under the existing D22 rule.
note_credit AS (
  SELECT b.xero_invoice_id,
    sum(public.job_cost_credit_note_part(b.sub_total, a.amount, b.total)) AS note_credit_ex,
    jsonb_agg(jsonb_build_array(a.org_id, a.xero_credit_note_id,
      a.allocation_n, a.allocation_id, a.credit_note_number,
      to_char(a.credit_note_date, 'YYYY-MM-DD'),
      to_char(a.allocation_date, 'YYYY-MM-DD'), a.amount)
      ORDER BY a.org_id, a.xero_credit_note_id COLLATE "C", a.allocation_n) AS note_credit_witness
  FROM bill b
  JOIN public.v_supplier_credit_allocations a
    ON a.org_id=b.org_id AND a.xero_invoice_id=b.xero_invoice_id
  WHERE a.counts_from_credit_note AND b.sub_total IS NOT NULL
  GROUP BY b.xero_invoice_id
),
-- The engine's own mirror test (v_job_cost_events.trade_mirror_bill).
mirror AS (
  SELECT DISTINCT x.xero_invoice_id
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY'
    AND (p_job IS NULL OR x.xero_invoice_id IN (SELECT s.xero_invoice_id FROM scope s))
    AND (
      EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = x.xero_invoice_id)
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li
        WHERE li.value ->> 'Description' ~ '\| SW - [A-Z]'
      )
    )
),
-- Allocation rows on a job (one per bill and job: job_materials_facts_invoice_job_uidx).
fact AS (
  SELECT f.xero_invoice_id, f.job_id,
         f.automation_source AS source,
         round(f.amount_ex_gst, 2) AS amount_ex,
         (f.amount_ex_gst IS NULL) AS amount_unreadable,
         CASE
           WHEN f.automation_source IN ('manual_queue', 'manual_split')
             THEN CASE WHEN NULLIF(btrim(f.assigned_by), '') IS NULL OR btrim(f.assigned_by) = 'ops_dashboard'
                       THEN 'unrecorded' ELSE 'person' END
           WHEN f.automation_source = 'agent_ai' THEN 'ai_reader'
           ELSE 'rule'
         END AS placed_by
  FROM public.job_materials_facts f
  WHERE f.kind = 'actual' AND f.job_id IS NOT NULL AND f.xero_invoice_id IS NOT NULL
    AND (p_job IS NULL OR f.xero_invoice_id IN (SELECT s.xero_invoice_id FROM scope s))
),
-- What stops the engine reading the bill through its Xero lines (the two NOT
-- EXISTS of v_job_cost_events.bill_line), per bill.
blocker AS (
  SELECT b.xero_invoice_id,
         EXISTS (SELECT 1 FROM public.job_materials_facts f
                  WHERE f.xero_invoice_id = b.xero_invoice_id
                    AND (f.job_id IS DISTINCT FROM b.job_id OR f.automation_source = 'manual_split')
                    AND f.kind = 'actual' AND f.job_id IS NOT NULL) AS by_rows,
         EXISTS (SELECT 1 FROM public.job_materials_facts f
                  WHERE f.xero_invoice_id = b.xero_invoice_id
                    AND (f.job_id IS DISTINCT FROM b.job_id OR f.automation_source = 'manual_split')) AS by_any_row
  FROM bill b
  WHERE b.job_id IS NOT NULL
),
-- What the engine counts, per bill and job. Supplier sources only; a credit
-- row is a credit, so gross leaves it out.
eng AS (
  SELECT e.document_id AS xero_invoice_id, e.job_id,
         bool_or(e.is_actual) AS any_actual,
         sum(e.amount_ex) FILTER (WHERE e.is_actual) AS counted_ex,
         sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.source <> 'supplier_credit') AS counted_gross_ex,
         bool_or(e.match_method = 'xero_invoices.job_id') AS via_lines,
         bool_or(e.source = 'installer_bill_unconfirmed') AS held_unconfirmed,
         bool_or(e.source = 'installer_bill_not_job_related') AS held_not_job_related
  FROM public.v_job_cost_events e
  WHERE e.party_kind = 'supplier'
    AND e.source IN ('supplier_bill', 'materials_fact', 'supplier_credit',
                     'installer_bill_unconfirmed', 'installer_bill_not_job_related')
    AND e.document_id IS NOT NULL AND e.job_id IS NOT NULL
    AND (p_job IS NULL OR e.document_id IN (SELECT s.xero_invoice_id FROM scope s))
    -- A job with no bill skips the engine read entirely (a one-time
    -- filter); it changes no row, since the IN above would keep none.
    AND (p_job IS NULL OR EXISTS (SELECT 1 FROM scope s))
  GROUP BY e.document_id, e.job_id
),
pair AS (
  SELECT xero_invoice_id, job_id FROM bill WHERE job_id IS NOT NULL
  UNION SELECT xero_invoice_id, job_id FROM fact
  UNION SELECT xero_invoice_id, job_id FROM eng
),
row0 AS (
  SELECT
    p.xero_invoice_id,
    p.job_id,
    j.job_number,
    COALESCE(lower(j.metadata ->> 'do_not_schedule') = 'true', false) AS holding_job,
    -- v_job_profit reads jobs WHERE legacy IS NOT TRUE: a legacy or missing
    -- job has no Job Profit row, so cost the engine puts there counts nowhere.
    (j.id IS NULL OR j.legacy IS TRUE) AS legacy_job,
    b.xero_invoice_id IS NOT NULL AS bill_known,
    b.invoice_number,
    b.contact_name,
    b.status AS bill_status,
    COALESCE(b.job_id = p.job_id, false) AS xero_linked,
    f.source AS row_source,
    f.amount_ex AS row_ex,
    COALESCE(f.amount_unreadable, false) AS amount_unreadable,
    CASE
      WHEN f.placed_by IS NOT NULL THEN f.placed_by
      WHEN b.job_id = p.job_id THEN 'xero_link'
    END AS placed_by,
    COALESCE(public.job_cost_installer_bill(b.line_items), false) AS installer,
    (m.xero_invoice_id IS NOT NULL) AS mirror_bill,
    COALESCE(bl.by_rows, false) AS blocked_by_rows,
    COALESCE(bl.by_any_row, false) AS blocked_by_any_row,
    COALESCE(q.overhead_ex, 0) > 0 AS has_overhead,
    COALESCE(e.any_actual, false) AS engine_counts,
    COALESCE(e.via_lines, false) AS engine_via_lines,
    COALESCE(e.held_unconfirmed, false) AS engine_held_unconfirmed,
    COALESCE(e.held_not_job_related, false) AS engine_held_not_job_related,
    e.counted_ex,
    e.counted_gross_ex
  FROM pair p
  LEFT JOIN public.jobs j ON j.id = p.job_id
  LEFT JOIN bill b ON b.xero_invoice_id = p.xero_invoice_id
  LEFT JOIN fact f ON f.xero_invoice_id = p.xero_invoice_id AND f.job_id = p.job_id
  LEFT JOIN blocker bl ON bl.xero_invoice_id = p.xero_invoice_id
  LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = p.xero_invoice_id
  LEFT JOIN eng e ON e.xero_invoice_id = p.xero_invoice_id AND e.job_id = p.job_id
  LEFT JOIN mirror m ON m.xero_invoice_id = p.xero_invoice_id
  -- A mirror is listed only where a person placed it (and never counted).
  WHERE m.xero_invoice_id IS NULL OR f.source IN ('manual_queue', 'manual_split')
),
row1 AS (
  SELECT r.*,
    CASE
      WHEN r.engine_counts AND r.legacy_job THEN 'not_counted'
      WHEN r.engine_counts THEN 'counted'
      WHEN r.mirror_bill THEN 'not_counted'
      WHEN r.amount_unreadable OR NOT r.bill_known THEN 'unknown'
      WHEN r.bill_status IN ('VOIDED', 'DELETED') THEN 'not_counted'
      WHEN r.engine_held_unconfirmed OR r.engine_held_not_job_related THEN 'not_counted'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.bill_status IS DISTINCT FROM 'AUTHORISED'
           AND r.bill_status IS DISTINCT FROM 'PAID' THEN 'not_counted'
      WHEN r.row_source IS NULL AND r.xero_linked AND (r.blocked_by_any_row OR r.has_overhead) THEN 'not_counted'
      ELSE 'unknown'
    END AS counts,
    CASE
      WHEN r.engine_counts AND r.legacy_job THEN 'job_outside_job_profit'
      WHEN r.engine_counts AND r.engine_via_lines THEN 'engine_reads_xero_lines'
      WHEN r.engine_counts THEN 'engine_reads_allocation_rows'
      WHEN r.mirror_bill THEN 'mirror_bill_person_placed'
      WHEN r.amount_unreadable THEN 'amount_unreadable'
      WHEN NOT r.bill_known THEN 'bill_copy_missing'
      WHEN r.bill_status IN ('VOIDED', 'DELETED') THEN 'bill_voided'
      WHEN r.engine_held_unconfirmed AND r.installer THEN 'installer_unconfirmed'
      WHEN r.engine_held_unconfirmed THEN 'labour_part_unconfirmed'
      WHEN r.engine_held_not_job_related THEN 'installer_not_job_related'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.bill_status IS DISTINCT FROM 'AUTHORISED'
           AND r.bill_status IS DISTINCT FROM 'PAID' THEN 'bill_not_approved'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.blocked_by_rows THEN 'xero_link_read_through_rows'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.has_overhead THEN 'xero_link_read_through_overhead'
      WHEN r.row_source IS NULL AND r.xero_linked AND r.blocked_by_any_row THEN 'xero_link_hidden_by_other_row'
      ELSE 'engine_reason_unknown'
    END AS reason
  FROM row0 r
),
-- Per bill: credit applied (known only when the stored copy shows it; never 0
-- by assumption), the rows' digest and the bill's state.
bill_sum AS (
  SELECT r.xero_invoice_id,
         count(*) FILTER (WHERE r.counts = 'counted') AS counted_jobs,
         bool_or(r.counts = 'unknown') AS any_unknown,
         sum(COALESCE(r.counted_gross_ex, 0)) FILTER (WHERE r.counts = 'counted') AS counted_gross_ex,
         jsonb_agg(jsonb_build_object(
           'job_id', r.job_id,
           'counts', r.counts,
           'reason', r.reason,
           'xero_linked', r.xero_linked,
           'source', r.row_source,
           'placed_ex', r.row_ex)
           ORDER BY r.job_id::text COLLATE "C") AS rows_digest
  FROM row1 r
  GROUP BY r.xero_invoice_id
),
judged AS (
  SELECT r.*,
    round(b.sub_total, 2) AS bill_ex,
    CASE
      WHEN b.status IN ('AUTHORISED', 'PAID') THEN 'live'
      WHEN b.status IN ('VOIDED', 'DELETED') THEN 'void'
      ELSE COALESCE(b.status, 'missing')
    END AS status_class,
    b.line_items,
    b.raw_json ->> 'LineAmountTypes' AS line_amount_types,
    CASE
      WHEN b.raw_json IS NULL OR COALESCE(b.total, 0) <= 0 OR b.sub_total IS NULL THEN NULL
      WHEN (jsonb_typeof(b.raw_json -> 'CreditNotes') = 'array'
            AND jsonb_array_length(b.raw_json -> 'CreditNotes') > 0
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b.raw_json -> 'CreditNotes') c
                             WHERE public.job_profit_num(c.value -> 'AppliedAmount') IS NULL))
        OR jsonb_typeof(b.raw_json -> 'AmountCredited') = 'number'
        THEN round(public.job_cost_credit_share(b.raw_json, b.total) * b.sub_total, 2)
      ELSE NULL
    END AS bill_credit_applied_ex,
    nc.note_credit_ex,
    nc.note_credit_witness,
    round(COALESCE(q.overhead_ex, 0), 2) AS overhead_ex,
    q.status AS queue_status,
    s.counted_jobs,
    s.rows_digest,
    CASE
      WHEN NOT r.bill_known OR b.sub_total IS NULL OR s.any_unknown THEN 'unknown'
      WHEN b.status IN ('VOIDED', 'DELETED') THEN 'voided'
      WHEN r.mirror_bill THEN 'trade_mirror'
      WHEN q.status = 'not_job_related' AND s.counted_jobs > 0 THEN 'held'
      WHEN q.status = 'not_job_related' THEN 'not_job_related'
      WHEN s.counted_jobs = 0 AND COALESCE(q.overhead_ex, 0) > 0
           AND abs(round(b.sub_total, 2) - round(q.overhead_ex, 2)) <= 0.005 THEN 'overhead'
      WHEN s.counted_jobs = 0 THEN 'not_counted'
      -- v_bill_allocation_balance's comparison (remainder within half a cent), over
      -- the counted parts only, so it can differ from that view (see the header).
      WHEN round(b.sub_total, 2) - s.counted_gross_ex - COALESCE(q.overhead_ex, 0) < -0.005 THEN 'over_counted'
      WHEN abs(round(b.sub_total, 2) - s.counted_gross_ex - COALESCE(q.overhead_ex, 0)) <= 0.005 THEN 'counted_in_full'
      ELSE 'counted_in_part'
    END AS bill_state
  FROM row1 r
  JOIN bill_sum s ON s.xero_invoice_id = r.xero_invoice_id
  LEFT JOIN bill b ON b.xero_invoice_id = r.xero_invoice_id
  LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = r.xero_invoice_id
  LEFT JOIN note_credit nc ON nc.xero_invoice_id = r.xero_invoice_id
),
credit_judged AS (
  SELECT j.*,
    CASE WHEN j.note_credit_ex IS NULL THEN j.bill_credit_applied_ex
         ELSE COALESCE(j.bill_credit_applied_ex, 0) + j.note_credit_ex END AS credit_applied_ex
  FROM judged j
)
SELECT
  'cfo-bill-cost-outcome-v1'::text AS contract_version,
  'xero_accpay'::text AS subject_kind,
  j.xero_invoice_id,
  j.invoice_number,
  j.contact_name,
  j.bill_status,
  j.job_id,
  j.job_number,
  j.holding_job,
  j.xero_linked,
  j.row_source,
  j.placed_by,
  j.counts,
  j.reason,
  j.bill_state,
  CASE WHEN j.bill_state = 'held' THEN 'not_job_related_mark_on_counted_bill' END AS held_reason,
  (j.overhead_ex > 0) AS overhead_part,
  COALESCE(j.queue_status = 'not_job_related', false) AS not_job_related_mark,
  j.mirror_bill,
  j.counted_jobs::integer AS bill_counted_jobs,
  -- CFO's amounts. Never in the Context-facing read.
  CASE WHEN j.counts = 'counted' THEN j.counted_ex END AS counted_ex,
  j.row_ex AS placed_ex,
  j.bill_ex,
  j.overhead_ex,
  j.credit_applied_ex,
  md5((jsonb_build_array(
    'cfo-bill-cost-outcome-v1',
    j.xero_invoice_id,
    j.status_class,
    j.bill_ex,
    j.line_items,
    j.line_amount_types,
    -- Credit the engine applies: none known and none shown are the same
    -- (job_cost_credit_share reads 0 for both), so a prepayment landing in
    -- AmountCredited never moves the hash.
    round(COALESCE(j.credit_applied_ex, 0), 2),
    j.rows_digest,
    j.overhead_ex,
    j.queue_status
  ) || CASE WHEN j.note_credit_witness IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(j.note_credit_witness) END)::text) AS evidence_hash
FROM credit_judged j
$function$;
DO $post$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.cfo_bill_cost_outcomes_scoped(uuid)'::regprocedure) IS DISTINCT FROM '63ccf9830493620a7a6140750d141875' THEN
  RAISE EXCEPTION 'h7_credit_postimage_mismatch';
 END IF;
END $post$;
