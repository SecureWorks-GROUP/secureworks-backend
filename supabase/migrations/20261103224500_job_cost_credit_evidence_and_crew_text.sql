-- (Job Profit, finish-line row A4, 3 Nov 2026) Two cost-line fixes in v_job_cost_events, so that
-- variables V16 (supplier credit note) and V19 (Fencing Warehouse) pass against Bookkeeping's ledger.
--
-- 1. A supplier credit note follows Bookkeeping's evidence for the credit note itself (F4, F7b). Until now a
--    credit only ever landed on the job of the bill it was applied to in Xero, and the credit-note lines
--    Bookkeeping places on a job were never read. Now each evidenced credit-note line is its own event on the
--    ledger's job (source supplier_credit, match bookkeeping_evidence), and the share of the note the ledger
--    places is taken off the bill it was applied to (bill credit share and the credit_note path), capped at the
--    whole note, so no credit is counted twice and the part the ledger does not place stays where it was.
--    Example: Fencing Warehouse credit 10094292 (-38.18, applied to bill 10094335 on SWF-26177) moves to
--    SWF-261270, where the ledger places it.
-- 2. A bill whose line text looks like a crew-app mirror bill ('| SW - X') but has no crew record is no longer
--    dropped when Bookkeeping evidences its lines (F6a). Bills linked to a crew invoice stay out as before,
--    and the existing installer guard still refuses a line where the same person has crew-app labour on
--    that job. Example: Aydan Belcher's 24 Oct bill (789.60, no crew record) lands 840.00 of labour on
--    SWP-26195, SWP-261336, SWP-261043 and SWF-261413.
--
-- Rehearsed 3 Nov 2026 on production in rolled-back transactions (CIO helper, Claude):
--   effects (new view as a temp view, v_job_profit over it, live data 07:57Z): 31 jobs change; total job
--   cost 777,286.96 to 778,077.27 (+790.31: labour +840.00, materials -49.69); margins 355 to 355.
--   Against Bookkeeping's ledger (verify/scripts/variables_check.py on the 31 jobs): 28 move toward the
--   ledger, 21 of them onto it to the cent; SWF-26033 (correct credit lines added, job short for other
--   reasons), SWF-26889 (a 2 Nov credit placed by Bookkeeping's forward evidence, outside the checker's
--   July-October ledger) and SWF-26174 (0.01 rounding) move away.
--   SWF-26813 4,301.58 to 3,833.49 (R&R 86785 -172.73, CN-84644 -295.36); SWF-26177 +38.18; SWF-261270
--   -38.18; SWP-26195 +225.00; SWF-261334 -1,156.09 (= ledger); SWF-261410 +1,502.18.
--   The migration itself (exact file, guard, idempotent re-run, rollback): see the pull request.
-- Guard: v_job_cost_events must be the 20261103160000 definition (md5 926479b3b905dea4b087834c37438572,
-- pg_get_viewdef(..., true)); after the change it must be 7f7837be26bf12f131bd86c84ab6ea55.
-- Rollback: supabase/rollbacks/20261103224500_job_cost_credit_evidence_and_crew_text_down.sql

SET LOCAL lock_timeout = '5s';

DO $mig$
DECLARE
  v_def text;
  r1_old text := $q1o$'\| SW - [A-Z]'::text)))$q1o$;
  r1_new text := $q1n$'\| SW - [A-Z]'::text)) AND NOT (EXISTS ( SELECT 1
                   FROM v_bookkeeping_line_evidence_current e
                  WHERE e.xero_invoice_id = x.xero_invoice_id AND e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL)))$q1n$;
  r2_old text := $q2o$        ), bill_line AS ($q2o$;
  r2_new text := $q2n$        ), ledger_cn AS (
         SELECT e.xero_invoice_id AS xero_credit_note_id,
            e.xero_line_item_id,
            e.job_id,
            e.amount_ex_gst,
            n.credit_note_number,
            n.contact_name,
            n.credit_note_date,
            n.status,
            n.sub_total,
            ( SELECT l.value ->> 'AccountCode'::text
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(n.raw_json -> 'LineItems'::text) = 'array'::text THEN n.raw_json -> 'LineItems'::text
                            ELSE '[]'::jsonb
                        END) l(value)
                  WHERE (l.value ->> 'LineItemID'::text) = e.xero_line_item_id
                 LIMIT 1) AS account_code
           FROM v_bookkeeping_line_evidence_current e
             JOIN xero_supplier_credit_notes n ON n.xero_credit_note_id = e.xero_invoice_id
          WHERE e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL AND (n.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
        ), ledger_cn_note AS (
         SELECT ledger_cn.xero_credit_note_id,
            LEAST(GREATEST(- sum(ledger_cn.amount_ex_gst) / NULLIF(max(ledger_cn.sub_total), 0::numeric), 0::numeric), 1::numeric) AS share_placed
           FROM ledger_cn
          GROUP BY ledger_cn.xero_credit_note_id
        ), ledger_cn_bill AS (
         SELECT a.xero_invoice_id,
            sum(a.amount * l.share_placed) AS applied_moved
           FROM v_supplier_credit_allocations a
             JOIN ledger_cn_note l ON l.xero_credit_note_id = a.xero_credit_note_id
          WHERE a.state = 'bill_live'::text AND (a.bill_side = ANY (ARRAY['counts_it'::text, 'amount_credited'::text]))
          GROUP BY a.xero_invoice_id
        ), bill_line AS ($q2n$;
  r3_old text := $q3o$job_cost_credit_share(x.raw_json, x.total) AS credit_share$q3o$;
  r3_new text := $q3n$GREATEST(job_cost_credit_share(x.raw_json, x.total) - COALESCE(( SELECT m.applied_moved
                   FROM ledger_cn_bill m
                  WHERE m.xero_invoice_id = x.xero_invoice_id), 0::numeric) / NULLIF(x.total, 0::numeric), 0::numeric) AS credit_share$q3n$;
  r4_old text := $q4o$- job_cost_credit_note_part(s.amount_ex, a.amount, a.bill_total) AS amount_ex$q4o$;
  r4_new text := $q4n$- job_cost_credit_note_part(s.amount_ex, a.amount * (1::numeric - COALESCE(( SELECT l.share_placed
                   FROM ledger_cn_note l
                  WHERE l.xero_credit_note_id = a.xero_credit_note_id), 0::numeric)), a.bill_total) AS amount_ex$q4n$;
  r5_old text := $q5o$        ), po_base AS ($q5o$;
  r5_new text := $q5n$        ), ledger_credit AS (
         SELECT l.job_id,
            l.credit_note_date AS event_date,
                CASE
                    WHEN l.account_code = ANY (ARRAY['306'::text, '301'::text]) THEN 'labour'::text
                    WHEN l.account_code ~ '^3[0-9]{2}$'::text THEN 'materials'::text
                    ELSE 'other'::text
                END AS lane,
            COALESCE(l.account_code, 'no_account'::text) AS lane_detail,
            'supplier'::text AS party_kind,
            NULL::text AS party_id,
            COALESCE(NULLIF(btrim(l.contact_name), ''::text), 'Unnamed supplier'::text) AS party,
            l.amount_ex_gst AS amount_ex,
            'supplier_credit'::text AS source,
            ((l.xero_credit_note_id || ':'::text) || l.xero_line_item_id) || ':ledger_credit'::text AS source_id,
            l.xero_credit_note_id AS document_id,
            l.credit_note_number AS document_number,
            l.status AS document_status,
            l.status = 'PAID'::text AS paid,
            NULL::date AS paid_on,
            'high'::text AS confidence,
            true AS is_actual,
            ('Supplier credit note '::text || COALESCE(l.credit_note_number, '(no number)'::text)) || ' placed by Bookkeeping'::text AS description,
            NULL::numeric AS hours,
            l.account_code,
            NULL::text AS business_unit,
            'bookkeeping_evidence'::text AS match_method,
            false AS incomplete_invoice
           FROM ledger_cn l
        ), po_base AS ($q5n$;
  r6_old text := $q6o$UNION ALL
 SELECT po.job_id,$q6o$;
  r6_new text := $q6n$UNION ALL
 SELECT ledger_credit.job_id,
    ledger_credit.event_date,
    ledger_credit.lane,
    ledger_credit.lane_detail,
    ledger_credit.party_kind,
    ledger_credit.party_id,
    ledger_credit.party,
    ledger_credit.amount_ex,
    ledger_credit.source,
    ledger_credit.source_id,
    ledger_credit.document_id,
    ledger_credit.document_number,
    ledger_credit.document_status,
    ledger_credit.paid,
    ledger_credit.paid_on,
    ledger_credit.confidence,
    ledger_credit.is_actual,
    ledger_credit.description,
    ledger_credit.hours,
    ledger_credit.account_code,
    ledger_credit.business_unit,
    ledger_credit.match_method,
    ledger_credit.incomplete_invoice
   FROM ledger_credit
UNION ALL
 SELECT po.job_id,$q6n$;
BEGIN
  v_def := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  IF md5(v_def) = '7f7837be26bf12f131bd86c84ab6ea55' THEN
    RAISE NOTICE 'v_job_cost_events already places supplier credits by Bookkeeping''s credit-note evidence';
    RETURN;
  END IF;
  IF md5(v_def) <> '926479b3b905dea4b087834c37438572' THEN
    RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, r1_old, ''))) / length(r1_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r1 (crew-app text rule) not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, r2_old, ''))) / length(r2_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r2 (bill_line) not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, r3_old, ''))) / length(r3_old) <> 2 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r3 (credit share) not found exactly twice'; END IF;
  IF (length(v_def) - length(replace(v_def, r4_old, ''))) / length(r4_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r4 (credit_note part) not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, r5_old, ''))) / length(r5_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r5 (po_base) not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, r6_old, ''))) / length(r6_old) <> 1 THEN RAISE EXCEPTION 'v_job_cost_events: anchor r6 (po union) not found exactly once'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || replace(replace(replace(replace(replace(replace(v_def, r1_old, r1_new), r2_old, r2_new), r3_old, r3_new), r4_old, r4_new), r5_old, r5_new), r6_old, r6_new);
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '7f7837be26bf12f131bd86c84ab6ea55' THEN
    RAISE EXCEPTION 'v_job_cost_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
END
$mig$;
