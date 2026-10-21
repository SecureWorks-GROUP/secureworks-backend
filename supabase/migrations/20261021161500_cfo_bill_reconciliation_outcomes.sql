-- Job profit H7: one read of each supplier bill's reconciliation outcome, for
-- Context (CEO handover map H7, 21 Oct 2026). Stacks on 20261020181800 (PR 1107).
--
-- Context's decision store (20261020140000) records what a person decided
-- about one message or invoice. CFO's outcome is about a supplier bill (Xero
-- ACCPAY) and the rows that place it on jobs. CIO answered the H7 proposal
-- (relayed 21 Oct 14:11Z): a CFO-owned read-only view, separate from
-- person-authored message decisions; a fixed encoding plus contract version in
-- its change hash; no history in v1 (CFO owns any later history). This is that
-- view. It writes nothing and moves no money.
--
-- cfo_bill_reconciliation_outcomes: one row per non-mirror ACCPAY bill that is
-- linked to a job in Xero, has allocation rows, or has a Bills to place queue
-- row. Trade-app mirror bills (trade claims) are left out: they are the trade
-- claim interface (TC), not supplier bills.
--
-- state (first that applies):
--   unknown              no stored copy of the bill, a status that is not live
--                        or voided (draft, submitted), or no readable total
--   voided               VOIDED or DELETED in Xero; rows left on it must go
--   confirmed_overhead   a person marked it not job related, or put the whole
--                        bill to overhead
--   unplaced             no row and no Xero job link (waiting in the queue)
--   installer_unconfirmed  installer bill (306/301) with a part no person made
--                        (JP-12)
--   unbalanced           parts plus overhead differ from the bill ex GST
--   placed_unconfirmed   balanced, but a part was placed by a machine
--                        (xero_ref_link, po_deterministic, agent_prematch, or
--                        the bill's own Xero job link with no row)
--   confirmed            balanced, every part placed by a person
-- Only confirmed and confirmed_overhead are a confirmed reconciliation.
-- unplaced is an addition to the H7 proposal's states: a bill nobody has placed
-- is not unreadable, so it is named instead of being called unknown.
--
-- evidence_hash: md5 of one jsonb array (fixed key order, every amount rounded
-- to 2 places) whose first element is the contract version. It covers the
-- bill's status class, total ex GST, lines, credit applied, parts, overhead and
-- queue status. CFO PROPOSAL, open for CIO to overturn: a payment does not move
-- the hash (AUTHORISED and PAID are one class, and amount_due is not read);
-- a changed total, line, credit, status class, part or overhead does. This
-- matches Context's own invoice hash (20261020160000, PR 1106).
--
-- A credit applied in Xero is known only when the stored copy shows it
-- (credit notes with readable amounts, or AmountCredited); otherwise
-- credit_applied_ex is null, never 0.
--
-- JP-15 (what a person's placement does to a bill Xero already placed) is not
-- decided here: such a bill reads installer_unconfirmed or placed_unconfirmed
-- until it is.
--
-- Contract: supabase/tests/migration-contracts/20261021161500_cfo_bill_reconciliation_outcomes/.
-- Rollback: supabase/rollbacks/20261021161500_cfo_bill_reconciliation_outcomes_down.sql.

CREATE OR REPLACE VIEW public.cfo_bill_reconciliation_outcomes AS
WITH bill AS (
  SELECT DISTINCT ON (x.xero_invoice_id)
         x.xero_invoice_id, x.invoice_number, x.status, x.sub_total, x.total, x.line_items, x.raw_json, x.job_id
  FROM public.xero_invoices x
  WHERE x.invoice_type = 'ACCPAY'
  ORDER BY x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC
),
mirror AS (
  SELECT b.xero_invoice_id
  FROM bill b
  WHERE EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = b.xero_invoice_id)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.line_items) = 'array' THEN b.line_items ELSE '[]'::jsonb END) li
       WHERE li.value ->> 'Description' ~ '\| SW - [A-Z]'
     )
),
fact AS (
  SELECT f.xero_invoice_id,
         jsonb_agg(jsonb_build_object(
           'job_id', f.job_id,
           'amount_ex_gst', round(f.amount_ex_gst, 2),
           'lane', f.lane,
           'placed_by', CASE WHEN f.automation_source IN ('manual_queue', 'manual_split') THEN 'person' ELSE 'machine' END,
           'automation_source', f.automation_source)
           ORDER BY f.job_id::text COLLATE "C", f.automation_source COLLATE "C") AS parts,
         sum(round(f.amount_ex_gst, 2)) AS parts_ex,
         bool_and(f.automation_source IN ('manual_queue', 'manual_split')) AS all_person,
         bool_or(f.amount_ex_gst IS NULL) AS amount_unreadable,
         min(f.assigned_by) FILTER (WHERE f.automation_source IN ('manual_queue', 'manual_split')) AS fact_by_min,
         max(f.assigned_by) FILTER (WHERE f.automation_source IN ('manual_queue', 'manual_split')) AS fact_by_max,
         max(f.updated_at) AS fact_at
  FROM public.job_materials_facts f
  WHERE f.kind = 'actual' AND f.job_id IS NOT NULL
  GROUP BY f.xero_invoice_id
),
universe AS (
  SELECT xero_invoice_id FROM bill WHERE job_id IS NOT NULL
  UNION SELECT xero_invoice_id FROM fact
  UNION SELECT xero_invoice_id FROM public.materials_reconciliation_queue
),
base AS (
  SELECT
    u.xero_invoice_id,
    b.invoice_number,
    b.status AS bill_status,
    (b.xero_invoice_id IS NOT NULL) AS bill_known,
    CASE
      WHEN b.status IN ('AUTHORISED', 'PAID') THEN 'live'
      WHEN b.status IN ('VOIDED', 'DELETED') THEN 'void'
      ELSE COALESCE(b.status, 'missing')
    END AS status_class,
    round(b.sub_total, 2) AS bill_ex,
    b.line_items,
    COALESCE(public.job_cost_installer_bill(b.line_items), false) AS installer,
    -- Credit is known only when the stored copy shows it; 0 is never assumed.
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
    CASE
      WHEN f.xero_invoice_id IS NOT NULL THEN f.parts
      WHEN b.job_id IS NOT NULL AND b.status IN ('AUTHORISED', 'PAID') THEN
        jsonb_build_array(jsonb_build_object(
          'job_id', b.job_id,
          'amount_ex_gst', round(b.sub_total, 2),
          'lane', NULL,
          'placed_by', 'machine',
          'automation_source', 'xero_job_link'))
      ELSE '[]'::jsonb
    END AS parts,
    CASE
      WHEN f.xero_invoice_id IS NOT NULL THEN f.parts_ex
      WHEN b.job_id IS NOT NULL AND b.status IN ('AUTHORISED', 'PAID') THEN round(b.sub_total, 2)
      ELSE 0
    END AS parts_ex,
    CASE
      WHEN f.xero_invoice_id IS NOT NULL THEN f.all_person
      WHEN b.job_id IS NOT NULL AND b.status IN ('AUTHORISED', 'PAID') THEN false
    END AS all_person,
    COALESCE(f.amount_unreadable, false) AS amount_unreadable,
    round(COALESCE(q.overhead_ex, 0), 2) AS overhead_ex,
    q.status AS queue_status,
    q.assigned_by AS queue_by,
    q.assigned_at AS queue_at,
    f.fact_by_min, f.fact_by_max, f.fact_at
  FROM universe u
  LEFT JOIN bill b ON b.xero_invoice_id = u.xero_invoice_id
  LEFT JOIN fact f ON f.xero_invoice_id = u.xero_invoice_id
  LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = u.xero_invoice_id
  WHERE NOT EXISTS (SELECT 1 FROM mirror m WHERE m.xero_invoice_id = u.xero_invoice_id)
),
judged AS (
  SELECT
    b.*,
    b.bill_ex - b.parts_ex - b.overhead_ex AS remainder_ex,
    CASE
      WHEN NOT b.bill_known THEN 'unknown'
      WHEN b.status_class = 'void' THEN 'voided'
      WHEN b.status_class <> 'live' THEN 'unknown'
      WHEN b.bill_ex IS NULL OR b.amount_unreadable THEN 'unknown'
      WHEN jsonb_array_length(b.parts) = 0
           AND (b.queue_status = 'not_job_related'
                OR (b.overhead_ex > 0 AND abs(b.bill_ex - b.overhead_ex) <= 0.005)) THEN 'confirmed_overhead'
      WHEN jsonb_array_length(b.parts) = 0 THEN 'unplaced'
      WHEN b.installer AND NOT COALESCE(b.all_person, false) THEN 'installer_unconfirmed'
      WHEN abs(b.bill_ex - b.parts_ex - b.overhead_ex) > 0.005 THEN 'unbalanced'
      WHEN NOT COALESCE(b.all_person, false) THEN 'placed_unconfirmed'
      ELSE 'confirmed'
    END AS state
  FROM base b
)
SELECT
  'cfo-recon-outcome-v1'::text AS contract_version,
  'xero_accpay'::text AS subject_kind,
  j.xero_invoice_id,
  j.invoice_number,
  j.bill_status,
  j.state,
  (j.state IN ('confirmed', 'confirmed_overhead')) AS confirmed,
  j.parts,
  j.overhead_ex,
  CASE WHEN j.bill_ex IS NULL THEN NULL ELSE j.remainder_ex END AS remainder_ex,
  j.bill_ex,
  j.credit_applied_ex,
  -- Who made the deciding rows, as their writer stored it. Null unless confirmed.
  CASE WHEN j.state IN ('confirmed', 'confirmed_overhead') THEN
    COALESCE(CASE WHEN j.queue_status IN ('assigned', 'split', 'not_job_related') THEN j.queue_by END,
             CASE WHEN j.fact_by_min = j.fact_by_max THEN j.fact_by_min END)
  END AS decided_by,
  CASE WHEN j.state IN ('confirmed', 'confirmed_overhead') THEN
    COALESCE(CASE WHEN j.queue_status IN ('assigned', 'split', 'not_job_related') THEN j.queue_at END, j.fact_at)
  END AS decided_at,
  md5(jsonb_build_array(
    'cfo-recon-outcome-v1',
    j.xero_invoice_id,
    j.status_class,
    j.bill_ex,
    j.line_items,
    j.credit_applied_ex,
    j.parts,
    j.overhead_ex,
    j.queue_status
  )::text) AS evidence_hash
FROM judged j;

COMMENT ON VIEW public.cfo_bill_reconciliation_outcomes IS
  'Job profit H7 (20261021161500): one row per non-mirror supplier bill (Xero ACCPAY) linked to a job, with allocation rows, or in Bills to place, for Context to read. state unknown, voided, confirmed_overhead, unplaced, installer_unconfirmed, unbalanced, placed_unconfirmed or confirmed; only confirmed and confirmed_overhead are a confirmed reconciliation. parts lists each job part with placed_by person or machine (the bill''s own Xero job link with no row is machine, source xero_job_link). evidence_hash is md5 of a fixed jsonb array led by the contract version cfo-recon-outcome-v1; a payment does not move it (CFO proposal, CIO may overturn), a changed total, line, credit, status class, part or overhead does. credit_applied_ex is null when the stored copy does not show credit. No history. Read only, service role only.';
REVOKE ALL ON public.cfo_bill_reconciliation_outcomes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cfo_bill_reconciliation_outcomes TO service_role;
