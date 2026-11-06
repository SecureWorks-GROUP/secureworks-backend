-- (Job Profit, finish-line row A3, 3 Nov 2026) Each division's monthly totals on Xero's accounting basis, from Job
-- Profit's own rows: a new read-only figure for the company view and the A3 check. No per-job figure changes.
--
-- CIO decision (records custodian, 3 Nov 2026 21:20Z; the A3 report put its item 2 to the CIO): the division-month
-- figure follows Xero's accounting basis, because the row asks for equality with Xero. For that figure only: a crew line
-- is dated by its posted Xero bill's date and divided by that bill line's Business Unit tracking; a materials placement
-- takes its Xero bill line's tracking; supplier and customer credit notes count on the credit note's own date and
-- tracking; employer super is not Cost of Sales; Bookkeeping's overhead and "not a job cost" lines get their own
-- per-division rows. v_job_profit, v_job_cost_events, v_job_revenue_events, weekly labour and the job card do not change.
-- The owner's open question (job division or Xero tracking on the job screen) is not decided by this.
--
-- Found by context-system verify/scripts/a3_division_months.py (production read 3 Nov 2026 21:39Z, Xero profit and loss
-- read 06:21 to 06:27Z): 22 of 60 division-month figures equal Xero; the causes that are ours came to 153,413.96 gross
-- (crew dated by work date 110,863.71; supplier credit notes 11,104.17; employer super 5,024.34; Bookkeeping's overhead
-- lines 4,170.37; customer credit notes 1,018.32; and others that are not code: a Xero read older than our copy,
-- installer bills held for a person, bank lines, two placement amounts).
--
-- Adds (read only, service role only; nothing else is changed or replaced):
--   * public.job_profit_job_division(job_number, job_type): the job's division when a row holds no Xero tracking; the
--     ops-api trackingCategoryForJob rule, extended (A3 item 8) for SWB- (SW - BUILDS) and, by the job's type, SWG-,
--     SWM- and old SW1xxx numbers (patio, fencing, decking, insurance, makesafe); NULL is "(no division)".
--   * public.v_job_profit_xero_basis_lines: one row per Job Profit row (v_job_revenue_events counted as invoiced and
--     v_job_cost_events actual rows in the labour, materials, commission and other lanes, on jobs that are not legacy:
--     exactly the rows v_job_profit adds up), restated on Xero's basis:
--       - posted_on: the Xero document the row is booked on. Invoice and bill lines: their own date. A crew line: its
--         crew invoice's posted Xero bill (AUTHORISED or PAID), else its work date (date_basis says which). A placement:
--         its bill's date. A supplier credit: the credit note's date; a credit share on a bill (Xero's amount credited)
--         is split over the bill's credit notes by the amount each applies, less what Bookkeeping's ledger already
--         placed from that note, each part rounded so the parts add up to the row to the cent. A customer credit: the
--         credit note's date when the invoice lists exactly one credit note and nothing else applied.
--       - division: the row's own Xero tracking (business_unit) where Job Profit holds it; a supplier credit takes its
--         credit note's (the note's one Business Unit, or that note line's for a credit Bookkeeping placed line by
--         line); otherwise the job's division (division_basis says which).
--       - in_figure: false only for employer super (Job Profit's own trade_employer_super and bill_employer_super rows):
--         Xero books super under Superannuation, outside Cost of Sales. Those rows stay in the view, so every job's rows
--         still add up to v_job_profit to the cent.
--     plus rows of their own (no job) for Bookkeeping's overhead and "not a job cost" lines: v_bookkeeping_line_evidence_
--     current rows evidenced to overhead or not_job_cost on a posted bill or supplier credit note line on a Cost of Sales
--     account (301, 303, 304, 305, 306, 310, 311: Xero's Cost of Sales section, 3 Nov 2026 profit and loss and trial
--     balance), the line's own amount ex GST, date and tracking, when no Job Profit row carries that line (not a line
--     split into parts, not on a crew invoice's bill, not carried line by line or by a placement of its bill).
--   * public.v_job_profit_division_months: the figure: division, month, side (revenue, cost), amount_ex, with the
--     job rows and overhead rows apart and how many lines took the job's division.
-- Not in it (named by the A3 check, not code here): bank lines (our Xero bank copy stores no line items: 958 of 958
-- July to October transactions have none, and Bookkeeping's bank ledger is not loaded); installer bills held for a
-- person (JP-12); amounts of two placements (another helper's fact refresh).
--
-- Guard: v_job_cost_events and v_job_revenue_events must be the definitions this was written against (production 3 Nov
-- 2026 21:28Z: md5 b48997c55913ce3c90e3a3c947533fd3 and 2191799f0f51ef34b5fe90879e8387cb; the registered migration-
-- contract stack's own definitions are pinned beside them), because the view reads their source_id formats. The new
-- objects must be absent or already this migration's (re-running it is a no-op); afterwards each must be the rehearsed
-- definition.
-- Rollback: supabase/rollbacks/20261104235000_job_profit_xero_basis_division_months_down.sql (drops the three new
-- objects; there is no earlier definition to restore).

DO $guard$
DECLARE
  v_cost text := md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  v_rev text := md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true));
BEGIN
  IF v_cost NOT IN ('b48997c55913ce3c90e3a3c947533fd3', 'b48997c55913ce3c90e3a3c947533fd3') THEN
    RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)', v_cost;
  END IF;
  IF v_rev NOT IN ('2191799f0f51ef34b5fe90879e8387cb', '18c6f924719d2c53ca537e8d58d7555f') THEN
    RAISE EXCEPTION 'v_job_revenue_events is not the definition this migration was written against (md5 %)', v_rev;
  END IF;
  -- Each new object is absent or already this migration's (to_regclass first: a cast of a missing name would fail).
  IF to_regprocedure('public.job_profit_job_division(text,text)') IS NOT NULL THEN
    IF md5(pg_get_functiondef(to_regprocedure('public.job_profit_job_division(text,text)'))) <> '3bbebf3fe80f23055b84bad31f9cc508' THEN
      RAISE EXCEPTION 'job_profit_job_division(text, text) exists and is not this migration''s definition (md5 %)',
        md5(pg_get_functiondef(to_regprocedure('public.job_profit_job_division(text,text)')));
    END IF;
  END IF;
  IF to_regclass('public.v_job_profit_xero_basis_lines') IS NOT NULL THEN
    IF md5(pg_get_viewdef(to_regclass('public.v_job_profit_xero_basis_lines'), true)) <> '41bb55d3783a31210cf704be0cdd6625' THEN
      RAISE EXCEPTION 'v_job_profit_xero_basis_lines exists and is not this migration''s definition (md5 %)',
        md5(pg_get_viewdef(to_regclass('public.v_job_profit_xero_basis_lines'), true));
    END IF;
  END IF;
  IF to_regclass('public.v_job_profit_division_months') IS NOT NULL THEN
    IF md5(pg_get_viewdef(to_regclass('public.v_job_profit_division_months'), true)) <> 'f4c5cfbe2047bb5f17f939e578a220a6' THEN
      RAISE EXCEPTION 'v_job_profit_division_months exists and is not this migration''s definition (md5 %)',
        md5(pg_get_viewdef(to_regclass('public.v_job_profit_division_months'), true));
    END IF;
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.job_profit_job_division(p_job_number text, p_job_type text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- A job's division (Xero Business Unit) when a row holds no Xero tracking: ops-api trackingCategoryForJob, type first,
  -- then the job number. SWB- is builds work; SWG- (general), SWM- (miscellaneous) and old SW1xxx numbers name no
  -- division, so the job's type decides. NULL is "(no division)".
  SELECT CASE
    WHEN lower(btrim(COALESCE(p_job_type, ''))) = 'repair' THEN 'SW - MAKESAFE'
    WHEN lower(btrim(COALESCE(p_job_type, ''))) IN ('roofing', 'renovation') THEN 'SW - PRIVATE ROOFING'
    WHEN COALESCE(p_job_number, '') = '' THEN NULL
    WHEN upper(p_job_number) LIKE 'SWMS-%' OR upper(p_job_number) LIKE 'AJBR%' OR upper(p_job_number) LIKE 'MS1%'
      OR upper(p_job_number) LIKE 'BWCWA%' OR upper(p_job_number) LIKE 'WB6%' THEN 'SW - MAKESAFE'
    WHEN left(upper(p_job_number), 3) = 'SWP' THEN 'SW - PATIOS'
    WHEN left(upper(p_job_number), 3) = 'SWF' THEN 'SW - FENCING'
    WHEN left(upper(p_job_number), 3) = 'SWD' THEN 'SW - DECKING'
    WHEN left(upper(p_job_number), 3) = 'SWI' THEN 'SW - INSURANCE WORK'
    WHEN upper(p_job_number) LIKE 'SWB-%' THEN 'SW - BUILDS'
    WHEN upper(p_job_number) ~ '^(SWG-|SWM-|SW[0-9])' THEN CASE lower(btrim(COALESCE(p_job_type, '')))
      WHEN 'patio' THEN 'SW - PATIOS'
      WHEN 'fencing' THEN 'SW - FENCING'
      WHEN 'decking' THEN 'SW - DECKING'
      WHEN 'insurance' THEN 'SW - INSURANCE WORK'
      WHEN 'makesafe' THEN 'SW - MAKESAFE'
    END
  END
$function$;
REVOKE ALL ON FUNCTION public.job_profit_job_division(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_job_division(text, text) TO service_role;

CREATE OR REPLACE VIEW public.v_job_profit_xero_basis_lines AS
 WITH cost_all AS MATERIALIZED (
         SELECT c.* FROM v_job_cost_events c
        ), jd AS (
         SELECT j.id, j.job_number, j.legacy, public.job_profit_job_division(j.job_number, j.type) AS division FROM jobs j
        ), bill AS (
         SELECT x.xero_invoice_id, x.invoice_number, x.invoice_date, x.line_items, x.raw_json ->> 'LineAmountTypes' AS line_amount_types
           FROM xero_invoices x
          WHERE x.invoice_type = 'ACCPAY' AND x.status IN ('AUTHORISED', 'PAID')
        ), cn AS (
         SELECT c.xero_credit_note_id, c.credit_note_number, c.credit_note_date, c.line_amount_types, c.sub_total,
            CASE WHEN jsonb_typeof(c.raw_json -> 'LineItems') = 'array' THEN c.raw_json -> 'LineItems' ELSE '[]'::jsonb END AS lines,
            public.job_cost_document_business_unit(c.raw_json -> 'LineItems') AS division
           FROM xero_supplier_credit_notes c
          WHERE c.status IN ('AUTHORISED', 'PAID')
        ), cn_placed AS (
         SELECT k.document_id AS xero_credit_note_id, - sum(k.amount_ex) AS placed_ex
           FROM cost_all k
          WHERE k.source = 'supplier_credit' AND k.source_id ~ ':ledger_credit$'
          GROUP BY k.document_id
        ), bill_cn_w AS (
         SELECT a.xero_invoice_id, a.xero_credit_note_id,
            sum(a.amount) * CASE WHEN COALESCE(cn.sub_total, 0) > 0
                                 THEN greatest(0, 1 - least(1, COALESCE(pl.placed_ex, 0) / cn.sub_total)) ELSE 1 END AS w
           FROM xero_supplier_credit_note_allocations a
           JOIN cn ON cn.xero_credit_note_id = a.xero_credit_note_id
           LEFT JOIN cn_placed pl ON pl.xero_credit_note_id = a.xero_credit_note_id
          WHERE NOT COALESCE(a.is_deleted, false) AND COALESCE(a.amount, 0) > 0
          GROUP BY a.xero_invoice_id, a.xero_credit_note_id, cn.sub_total, pl.placed_ex
        ), bill_cn AS (
         SELECT w.xero_invoice_id, w.xero_credit_note_id,
            COALESCE(sum(w.w) OVER (PARTITION BY w.xero_invoice_id ORDER BY w.xero_credit_note_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
              / sum(w.w) OVER (PARTITION BY w.xero_invoice_id) AS cum_from,
            sum(w.w) OVER (PARTITION BY w.xero_invoice_id ORDER BY w.xero_credit_note_id ROWS UNBOUNDED PRECEDING)
              / sum(w.w) OVER (PARTITION BY w.xero_invoice_id) AS cum_to
           FROM bill_cn_w w
          WHERE w.w > 0
        ), cost_rows AS (
         SELECT c.*, jd.job_number, jd.division AS job_division,
            CASE
              WHEN c.source IN ('trade_line', 'trade_employer_super') THEN 'crew'
              WHEN c.source = 'supplier_credit' AND c.source_id ~ ':credit_note:' THEN 'credit_note'
              WHEN c.source = 'supplier_credit' AND c.source_id ~ ':ledger_credit$' THEN 'ledger_credit'
              WHEN c.source = 'supplier_credit' THEN 'bill_credit'
              ELSE 'bill'
            END AS tie
           FROM cost_all c
           JOIN jd ON jd.id = c.job_id
          WHERE c.is_actual AND c.lane IN ('labour', 'materials', 'commission', 'other') AND NOT COALESCE(jd.legacy, false)
        ), cost_tied AS (
         SELECT r.job_id, r.event_date, r.lane, r.source, r.source_id, r.document_id, r.document_number, r.account_code,
            r.business_unit, r.job_number, r.job_division, r.tie,
            CASE WHEN bc.xero_invoice_id IS NULL THEN r.amount_ex
                 ELSE round(r.amount_ex * bc.cum_to, 2) - round(r.amount_ex * bc.cum_from, 2) END AS amount_ex,
            CASE r.tie
              WHEN 'crew' THEN cb.xero_invoice_id
              WHEN 'credit_note' THEN cnn.xero_credit_note_id
              WHEN 'ledger_credit' THEN cnl.xero_credit_note_id
              WHEN 'bill_credit' THEN cnb.xero_credit_note_id
              ELSE b.xero_invoice_id
            END AS xero_document_id,
            CASE r.tie
              WHEN 'crew' THEN cb.invoice_number
              WHEN 'credit_note' THEN cnn.credit_note_number
              WHEN 'ledger_credit' THEN cnl.credit_note_number
              WHEN 'bill_credit' THEN cnb.credit_note_number
              ELSE b.invoice_number
            END AS xero_document_number,
            CASE r.tie
              WHEN 'crew' THEN cb.invoice_date
              WHEN 'credit_note' THEN cnn.credit_note_date
              WHEN 'ledger_credit' THEN cnl.credit_note_date
              WHEN 'bill_credit' THEN cnb.credit_note_date
              ELSE b.invoice_date
            END AS xero_date,
            CASE r.tie
              WHEN 'credit_note' THEN cnn.division
              WHEN 'ledger_credit' THEN public.job_cost_line_business_unit(cll.value)
              WHEN 'bill_credit' THEN cnb.division
            END AS xero_credit_division
           FROM cost_rows r
             LEFT JOIN trade_invoices ti ON r.tie = 'crew' AND ti.id::text = r.document_id
             LEFT JOIN bill cb ON cb.xero_invoice_id = ti.xero_bill_id
             LEFT JOIN cn cnn ON r.tie = 'credit_note' AND cnn.xero_credit_note_id = substring(r.source_id FROM ':credit_note:([0-9A-Fa-f-]{36})')
             LEFT JOIN cn cnl ON r.tie = 'ledger_credit' AND cnl.xero_credit_note_id = r.document_id
             LEFT JOIN LATERAL (SELECT li.value FROM jsonb_array_elements(cnl.lines) li(value)
                                 WHERE li.value ->> 'LineItemID' = split_part(r.source_id, ':', 2) LIMIT 1) cll ON r.tie = 'ledger_credit'
             LEFT JOIN bill_cn bc ON r.tie = 'bill_credit' AND bc.xero_invoice_id = r.document_id
             LEFT JOIN cn cnb ON cnb.xero_credit_note_id = bc.xero_credit_note_id
             LEFT JOIN bill b ON r.tie = 'bill' AND b.xero_invoice_id = r.document_id
        ), rev_rows AS (
         SELECT e.*, jd.job_number, jd.division AS job_division
           FROM v_job_revenue_events e
           JOIN jd ON jd.id = e.job_id
          WHERE e.counts_as_invoiced AND NOT COALESCE(jd.legacy, false)
        ), inv_cn AS (
         SELECT x.xero_invoice_id, count(DISTINCT n.value ->> 'CreditNoteID') AS notes, min(n.value ->> 'CreditNoteID') AS credit_note_id,
            min(n.value ->> 'CreditNoteNumber') AS credit_note_number, min(left(n.value ->> 'DateString', 10))::date AS credit_note_date,
            jsonb_array_length(CASE WHEN jsonb_typeof(x.raw_json -> 'Prepayments') = 'array' THEN x.raw_json -> 'Prepayments' ELSE '[]'::jsonb END)
              + jsonb_array_length(CASE WHEN jsonb_typeof(x.raw_json -> 'Overpayments') = 'array' THEN x.raw_json -> 'Overpayments' ELSE '[]'::jsonb END) AS other_applied
           FROM xero_invoices x
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.raw_json -> 'CreditNotes') = 'array' THEN x.raw_json -> 'CreditNotes' ELSE '[]'::jsonb END) n(value)
          WHERE x.invoice_type = 'ACCREC' AND x.xero_invoice_id IN (SELECT rr.document_id FROM rev_rows rr WHERE rr.kind = 'credit_applied')
          GROUP BY x.xero_invoice_id, x.raw_json
        ), oh_ev AS (
         SELECT e.xero_invoice_id, e.xero_line_item_id, e.allocation, e.revision
           FROM v_bookkeeping_line_evidence_current e
          WHERE e.allocation IN ('overhead', 'not_job_cost') AND e.evidenced
            AND NOT EXISTS (SELECT 1 FROM v_bookkeeping_line_parts_current p
                             WHERE p.xero_invoice_id = e.xero_invoice_id AND p.xero_line_item_id = e.xero_line_item_id)
        ), oh_bill AS (
         SELECT e.allocation, e.revision, b.xero_invoice_id, b.invoice_number, b.invoice_date, li.n, li.value AS line,
            round(CASE WHEN b.line_amount_types = 'Inclusive'
                       THEN COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0) - COALESCE(public.job_profit_num(li.value -> 'TaxAmount'), 0)
                       ELSE COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0) END, 2) AS amount_ex
           FROM oh_ev e
           JOIN bill b ON b.xero_invoice_id = e.xero_invoice_id
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(b.line_items) = 'array' THEN b.line_items ELSE '[]'::jsonb END) WITH ORDINALITY li(value, n)
          WHERE li.value ->> 'LineItemID' = e.xero_line_item_id
            AND (li.value ->> 'AccountCode') IN ('301', '303', '304', '305', '306', '310', '311')
            AND NOT EXISTS (SELECT 1 FROM trade_invoices t WHERE t.xero_bill_id = b.xero_invoice_id)
            AND NOT EXISTS (SELECT 1 FROM cost_all c
                             WHERE c.document_id = b.xero_invoice_id
                               AND (c.source_id = b.xero_invoice_id || ':' || li.n
                                    OR c.source_id LIKE b.xero_invoice_id || ':' || li.n || ':%'
                                    OR c.source_id NOT LIKE b.xero_invoice_id || ':%'))
        ), oh_cn AS (
         SELECT e.allocation, e.revision, c.xero_credit_note_id, c.credit_note_number, c.credit_note_date, li.n, li.value AS line,
            round(CASE WHEN c.line_amount_types = 'Inclusive'
                       THEN COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0) - COALESCE(public.job_profit_num(li.value -> 'TaxAmount'), 0)
                       ELSE COALESCE(public.job_profit_num(li.value -> 'LineAmount'), 0) END, 2) AS amount_ex
           FROM oh_ev e
           JOIN cn c ON c.xero_credit_note_id = e.xero_invoice_id
           CROSS JOIN LATERAL jsonb_array_elements(c.lines) WITH ORDINALITY li(value, n)
          WHERE li.value ->> 'LineItemID' = e.xero_line_item_id
            AND (li.value ->> 'AccountCode') IN ('301', '303', '304', '305', '306', '310', '311')
            AND NOT EXISTS (SELECT 1 FROM cost_all k
                             WHERE k.document_id = c.xero_credit_note_id AND k.source_id LIKE c.xero_credit_note_id || ':' || e.xero_line_item_id || ':%')
        )
 SELECT 'revenue'::text AS side,
    COALESCE(r.business_unit, r.job_division) AS division,
    CASE WHEN r.kind = 'credit_applied' AND ic.notes = 1 AND ic.other_applied = 0 THEN ic.credit_note_date ELSE r.invoice_date END AS posted_on,
    r.amount_ex,
    true AS in_figure,
    NULL::text AS not_in_figure_reason,
    r.job_id,
    r.job_number,
    r.kind,
    r.source_id,
    r.document_id,
    r.document_number,
    CASE WHEN r.kind = 'credit_applied' AND ic.notes = 1 AND ic.other_applied = 0 THEN ic.credit_note_id ELSE r.document_id END AS xero_document_id,
    CASE WHEN r.kind = 'credit_applied' AND ic.notes = 1 AND ic.other_applied = 0 THEN ic.credit_note_number ELSE r.document_number END AS xero_document_number,
    CASE WHEN r.kind = 'credit_applied' AND ic.notes = 1 AND ic.other_applied = 0 THEN 'credit_note_date'
         WHEN r.kind = 'credit_applied' THEN 'invoice_date_credit_not_one_note'
         ELSE 'invoice_date' END AS date_basis,
    CASE WHEN r.business_unit IS NOT NULL THEN 'xero_tracking' ELSE 'job' END AS division_basis,
    r.invoice_date AS job_profit_date,
    r.job_division,
    r.account_code
   FROM rev_rows r
     LEFT JOIN inv_cn ic ON r.kind = 'credit_applied' AND ic.xero_invoice_id = r.document_id
UNION ALL
 SELECT 'cost'::text AS side,
    CASE WHEN t.tie IN ('credit_note', 'ledger_credit', 'bill_credit') THEN COALESCE(t.xero_credit_division, t.business_unit, t.job_division)
         ELSE COALESCE(t.business_unit, t.job_division) END AS division,
    COALESCE(t.xero_date, t.event_date) AS posted_on,
    t.amount_ex,
    t.source NOT IN ('trade_employer_super', 'bill_employer_super') AS in_figure,
    CASE WHEN t.source IN ('trade_employer_super', 'bill_employer_super') THEN 'employer_super_not_cost_of_sales' END AS not_in_figure_reason,
    t.job_id,
    t.job_number,
    t.source AS kind,
    t.source_id,
    t.document_id,
    t.document_number,
    COALESCE(t.xero_document_id, CASE WHEN t.tie IN ('bill', 'bill_credit') THEN t.document_id END) AS xero_document_id,
    COALESCE(t.xero_document_number, CASE WHEN t.tie IN ('bill', 'bill_credit') THEN t.document_number END) AS xero_document_number,
    CASE
      WHEN t.tie = 'crew' AND t.xero_date IS NOT NULL THEN 'crew_bill_date'
      WHEN t.tie = 'crew' THEN 'work_date_no_posted_bill'
      WHEN t.tie IN ('credit_note', 'ledger_credit', 'bill_credit') AND t.xero_date IS NOT NULL THEN 'credit_note_date'
      WHEN t.tie = 'bill_credit' THEN 'bill_date_no_credit_note'
      WHEN t.xero_date IS NOT NULL THEN 'bill_date'
      ELSE 'job_profit_date'
    END AS date_basis,
    CASE
      WHEN t.tie IN ('credit_note', 'ledger_credit', 'bill_credit') AND t.xero_credit_division IS NOT NULL THEN 'xero_credit_note_tracking'
      WHEN t.business_unit IS NOT NULL THEN 'xero_tracking'
      ELSE 'job'
    END AS division_basis,
    t.event_date AS job_profit_date,
    t.job_division,
    t.account_code
   FROM cost_tied t
UNION ALL
 SELECT 'cost'::text, public.job_cost_line_business_unit(o.line), o.invoice_date, o.amount_ex, true, NULL::text,
    NULL::uuid, NULL::text, o.allocation, o.xero_invoice_id || ':' || o.n, o.xero_invoice_id, o.invoice_number,
    o.xero_invoice_id, o.invoice_number, 'bill_date', CASE WHEN public.job_cost_line_business_unit(o.line) IS NOT NULL THEN 'xero_tracking' ELSE 'none' END,
    o.invoice_date, NULL::text, o.line ->> 'AccountCode'
   FROM oh_bill o
UNION ALL
 SELECT 'cost'::text, public.job_cost_line_business_unit(o.line), o.credit_note_date, - o.amount_ex, true, NULL::text,
    NULL::uuid, NULL::text, o.allocation, o.xero_credit_note_id || ':' || (o.line ->> 'LineItemID') || ':ledger_overhead', o.xero_credit_note_id, o.credit_note_number,
    o.xero_credit_note_id, o.credit_note_number, 'credit_note_date', CASE WHEN public.job_cost_line_business_unit(o.line) IS NOT NULL THEN 'xero_tracking' ELSE 'none' END,
    o.credit_note_date, NULL::text, o.line ->> 'AccountCode'
   FROM oh_cn o;

CREATE OR REPLACE VIEW public.v_job_profit_division_months AS
 SELECT l.division,
    date_trunc('month', l.posted_on::timestamp)::date AS month,
    l.side,
    sum(l.amount_ex) AS amount_ex,
    sum(l.amount_ex) FILTER (WHERE l.job_id IS NOT NULL) AS job_rows_ex,
    sum(l.amount_ex) FILTER (WHERE l.job_id IS NULL) AS overhead_rows_ex,
    count(*) AS lines,
    count(*) FILTER (WHERE l.division_basis = 'job') AS lines_division_from_job
   FROM public.v_job_profit_xero_basis_lines l
  WHERE l.in_figure
  GROUP BY l.division, (date_trunc('month', l.posted_on::timestamp)::date), l.side;

COMMENT ON VIEW public.v_job_profit_xero_basis_lines IS 'Job Profit rows restated on Xero''s accounting basis for division-month totals (finish line A3; CIO decision 3 Nov 2026): Xero document date, Xero tracking, employer super outside the figure (in_figure false), plus Bookkeeping''s overhead and not-a-job-cost Cost of Sales lines as rows with no job. Every job''s rows add up to v_job_profit. Read only, service role only.';
COMMENT ON VIEW public.v_job_profit_division_months IS 'Division x month totals on Xero''s accounting basis (rows of v_job_profit_xero_basis_lines in the figure). division NULL is "(no division)". Read only, service role only.';
REVOKE ALL ON public.v_job_profit_xero_basis_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_job_profit_division_months FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_job_profit_xero_basis_lines TO service_role;
GRANT SELECT ON public.v_job_profit_division_months TO service_role;

DO $after$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public.job_profit_job_division(text,text)'))) <> '3bbebf3fe80f23055b84bad31f9cc508' THEN
    RAISE EXCEPTION 'job_profit_job_division is not the rehearsed definition (md5 %)', md5(pg_get_functiondef(to_regprocedure('public.job_profit_job_division(text,text)')));
  END IF;
  IF md5(pg_get_viewdef('public.v_job_profit_xero_basis_lines'::regclass, true)) <> '41bb55d3783a31210cf704be0cdd6625' THEN
    RAISE EXCEPTION 'v_job_profit_xero_basis_lines is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit_xero_basis_lines'::regclass, true));
  END IF;
  IF md5(pg_get_viewdef('public.v_job_profit_division_months'::regclass, true)) <> 'f4c5cfbe2047bb5f17f939e578a220a6' THEN
    RAISE EXCEPTION 'v_job_profit_division_months is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit_division_months'::regclass, true));
  END IF;
END $after$;
