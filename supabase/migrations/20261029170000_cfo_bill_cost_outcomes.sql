-- Job profit H7 (INT-12): where each supplier bill's cost counts, read from the
-- engine itself. 29 Oct 2026.
--
-- Source: draft PR #1141 ("H7 outcome: never claim a bill placement the profit
-- engine doesn't count"), stacked on #1140 and #1134, none of them on main.
-- Their outcome view re-derived the engine's rules and drifted from it twice
-- (F2, K3-OVERHEAD); #1141 patched those two cases. Main's engine has moved
-- since (20261028173000: an installer bill the AI bill reader places counts,
-- owner 28 Oct 2026), so this view carries #1141's intent forward a different
-- way: it never re-derives what counts. Whether a placement counts is read from
-- v_job_cost_events (the rows v_job_profit sums), so the outcome cannot claim a
-- placement the engine does not make, whatever the engine's rules become.
--
-- cfo_bill_cost_outcomes: one row per supplier bill (Xero ACCPAY; a trade-app
-- mirror's cost is its trade lines, so a mirror is left out except where a
-- person put an allocation row of it on a job, which is shown, never counted)
-- and job that the bill is placed on or counted on:
--   * the bill's own Xero job link (xero_invoices.job_id);
--   * an allocation row (job_materials_facts, kind actual) on that job;
--   * any job the engine counts the bill's cost on (defensive: today every
--     such job is one of the two above).
--
-- counts (per bill and job):
--   counted      v_job_cost_events has an actual row of this bill on this job
--                and the job is one v_job_profit reads (a job row, not legacy)
--   not_counted  the bill is readable and the engine counts none of it here;
--                reason names why
--   unknown      the engine counts none of it here and the reason cannot be
--                read (no stored copy of the bill, an unreadable amount, or no
--                engine rule this view knows). Unknown stays unknown, never 0.
--
-- reason: engine_reads_xero_lines, engine_reads_allocation_rows (counted);
--   job_outside_job_profit (a legacy job: Job Profit has no row for it),
--   bill_voided, labour_part_unconfirmed, installer_unconfirmed,
--   installer_not_job_related, bill_not_approved, xero_link_read_through_rows
--   (rows on another job or a split), xero_link_read_through_overhead,
--   xero_link_hidden_by_other_row (a row that is not an actual cost row, on
--   another job, stops the engine reading the Xero link: CFO to look at),
--   mirror_bill_person_placed (a person put a trade-app mirror bill on the job:
--   the engine counts a mirror only through the trade lines), (not_counted);
--   bill_copy_missing, amount_unreadable,
--   engine_reason_unknown (unknown).
--
-- bill_state (per bill, the same on each of its rows), first that applies:
--   unknown          no stored copy, no readable total, or any row unknown
--   voided           VOIDED or DELETED in Xero
--   trade_mirror     a trade-app mirror bill a person placed on a job: its cost
--                    counts through the trade app's lines, never as this bill
--   held             a "not job related" mark while the engine still counts the
--                    bill on a job (F1, JP-21: an open money rule). held_reason
--                    not_job_related_mark_on_counted_bill. Neither side is
--                    settled; a reader says nothing about where it counts.
--   not_job_related  marked not job related and counted on no job
--   overhead         the whole bill is an overhead part, counted on no job
--   not_counted      counted on no job
--   over_counted     counted on jobs, and those parts plus any overhead part
--                    are more than the bill ex GST (1200 counted on a 1000 bill,
--                    two 700 placements on one): never "in part"
--   counted_in_full  counted on jobs, and those parts plus any overhead part
--                    equal the bill ex GST to the cent
--   counted_in_part  counted on a job, and those parts plus any overhead part
--                    are less than the bill ex GST
-- The three compare as v_bill_allocation_balance balances a bill: the bill ex
-- GST rounded to the cent, less the counted parts and the overhead part, within
-- half a cent.
--
-- placed_by (descriptive only, never decides counts): xero_link, person
--   (manual_queue/manual_split with a stored actor), unrecorded (a person
--   source with a blank or 'ops_dashboard' actor), ai_reader (agent_ai), rule
--   (xero_ref_link, po_deterministic, agent_prematch), mixed.
--
-- evidence_hash (D22, JP-20, working rule "take CFO's recommendation": CFO's
-- proposal in #1134): md5 of one jsonb array whose first element is the
-- contract version. It covers the bill's status class, total ex GST, lines,
-- whether the lines are tax inclusive (LineAmountTypes: the engine reads an
-- Inclusive line as LineAmount less TaxAmount), credit applied, each row (job, counts, reason, sources, placed amount),
-- overhead and queue status. A payment does not move it: AUTHORISED and PAID
-- are one class, and amount_due, amount_paid and fully_paid_on are not read.
-- A changed total, line, credit, status class, row or overhead does. A
-- prepayment or overpayment is a payment (job_cost_credit_share leaves it out,
-- and credit not shown hashes as the 0 the engine applies).
-- No history in v1.
--
-- One rule, two scopes. cfo_bill_cost_outcomes_scoped(job) holds the whole
-- rule. With no job it is the estate, and the view is exactly that call. With
-- a job it reads only the bills placed on that job (its Xero link, or an actual
-- allocation row on it) from the first read on, so the per-bill work never
-- runs over the estate; the rows are the view's rows for those bills, byte for
-- byte (the contract proves it for every fixture job, both ways). Every scope
-- filter sits on a read keyed by the bill id, and every later step is keyed by
-- the bill, so a bill's rows never depend on another bill. The function is
-- plain SQL, STABLE, with no SET clause, so it inlines (the view's call with a
-- constant null folds the scope filter away). The engine view it reads
-- (v_job_cost_events) still builds its own shared steps over every bill; that
-- floor is the engine's, not this rule's.
--
-- Amounts here are CFO's. The Context-facing read (context_job_bill_outcomes,
-- 20261029170100) drops every one of them. Writes nothing, moves no money.
-- Contract: supabase/tests/migration-contracts/20261029170000_cfo_bill_cost_outcomes/.
-- Rollback: supabase/rollbacks/20261029170000_cfo_bill_cost_outcomes_down.sql.

CREATE OR REPLACE FUNCTION public.cfo_bill_cost_outcomes_scoped(p_job uuid)
RETURNS TABLE (
  contract_version text, subject_kind text, xero_invoice_id text, invoice_number text, contact_name text,
  bill_status text, job_id uuid, job_number text, holding_job boolean, xero_linked boolean, row_source text,
  placed_by text, counts text, reason text, bill_state text, held_reason text, overhead_part boolean,
  not_job_related_mark boolean, mirror_bill boolean, bill_counted_jobs integer, counted_ex numeric,
  placed_ex numeric, bill_ex numeric, overhead_ex numeric, credit_applied_ex numeric, evidence_hash text
)
LANGUAGE sql
STABLE
AS $fn$
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
         x.xero_invoice_id, x.invoice_number, x.contact_name, x.status, x.sub_total, x.total,
         x.line_items, x.raw_json, x.job_id
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY' AND x.xero_invoice_id IS NOT NULL
    AND (p_job IS NULL OR x.xero_invoice_id IN (SELECT s.xero_invoice_id FROM scope s))
  ORDER BY x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC, x.job_id::text COLLATE "C"
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
    END AS credit_applied_ex,
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
      -- v_bill_allocation_balance's own comparison (remainder within half a cent).
      WHEN round(b.sub_total, 2) - s.counted_gross_ex - COALESCE(q.overhead_ex, 0) < -0.005 THEN 'over_counted'
      WHEN abs(round(b.sub_total, 2) - s.counted_gross_ex - COALESCE(q.overhead_ex, 0)) <= 0.005 THEN 'counted_in_full'
      ELSE 'counted_in_part'
    END AS bill_state
  FROM row1 r
  JOIN bill_sum s ON s.xero_invoice_id = r.xero_invoice_id
  LEFT JOIN bill b ON b.xero_invoice_id = r.xero_invoice_id
  LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = r.xero_invoice_id
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
  md5(jsonb_build_array(
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
  )::text) AS evidence_hash
FROM judged j
$fn$;

REVOKE ALL ON FUNCTION public.cfo_bill_cost_outcomes_scoped(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_bill_cost_outcomes_scoped(uuid) TO service_role;
COMMENT ON FUNCTION public.cfo_bill_cost_outcomes_scoped(uuid) IS
  'Job profit H7, INT-12 (20261029170000): the one rule behind cfo_bill_cost_outcomes. With p_job null, every bill (the view is exactly this call); with a job, only the bills placed on it (its Xero link or an actual allocation row on it), read from the first step, giving the view''s rows for those bills byte for byte. Plain SQL, STABLE, no SET clause (inlinable). Read only, service role only.';

-- The estate: the rule with no job.
CREATE OR REPLACE VIEW public.cfo_bill_cost_outcomes AS
SELECT * FROM public.cfo_bill_cost_outcomes_scoped(NULL::uuid);

COMMENT ON VIEW public.cfo_bill_cost_outcomes IS
  'Job profit H7, INT-12 (20261029170000): one row per supplier bill (Xero ACCPAY; trade-app mirrors left out unless a person placed one) and job it is Xero-linked to, has an actual allocation row on, or is counted on. counts counted (v_job_cost_events has an actual row of the bill on the job and v_job_profit reads the job), not_counted (readable, engine counts none of it here; reason names why) or unknown (the reason cannot be read; never 0). Whether a placement counts is read from the engine, never re-derived. bill_state unknown, voided, trade_mirror (a trade-app mirror a person placed: shown, reason mirror_bill_person_placed, never counted), held (a not-job-related mark while the engine counts the bill: F1, JP-21, held_reason not_job_related_mark_on_counted_bill), not_job_related, overhead, not_counted, over_counted (counted parts plus overhead above the bill ex GST), counted_in_full or counted_in_part (below it), compared as v_bill_allocation_balance balances a bill. placed_by is descriptive only. evidence_hash is md5 of a fixed jsonb array led by the contract version cfo-bill-cost-outcome-v1; a payment does not move it (AUTHORISED and PAID one class; D22 working rule, CFO''s recommendation), a changed total, line, tax-inclusive flag (LineAmountTypes), credit, status class, row or overhead does. No history. Amounts are CFO''s: context_job_bill_outcomes drops them. Read only, service role only.';
REVOKE ALL ON public.cfo_bill_cost_outcomes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cfo_bill_cost_outcomes TO service_role;

-- The rule reads these tables with the caller's rights (an inlined function's
-- reads are the caller's, not the view owner's), and the service role is its
-- only caller. Some of these it may hold already (20260705000010 grants
-- job_materials_facts); stated here, SELECT only and to the service role only,
-- so a stack built from migrations alone runs it too.
GRANT SELECT ON public.xero_invoices, public.job_materials_facts, public.materials_reconciliation_queue,
  public.jobs, public.trade_invoices, public.v_job_cost_events TO service_role;
