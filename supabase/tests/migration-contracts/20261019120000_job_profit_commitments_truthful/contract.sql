-- Contract for 20261019120000_job_profit_commitments_truthful (CFO-12).
--
-- Synthetic jobs and suppliers, no customer data. Everything rolls back. Dates
-- are fixed except one order sent two days before the run (the only case that
-- must stay inside 30 days); every other dated order is months older than any
-- run, so no assertion depends on the calendar.
--
--   CT-A  one job holding every purchase order state:
--         PO-CT-PRICED      priced open order              -> po_committed 200
--         PO-CT-ZERO        old-style order, sent, $0      -> po_ordered (no $)
--         PO-CT-D-OLD       Dispatch order, $0, first sent 2 Aug (Perth),
--                           resent 20 Sep                  -> po_ordered, dated
--                           the FIRST send, over 30 days
--         PO-CT-D-NEW       Dispatch order sent 2 days ago -> po_ordered, under 30
--         PO-CT-D-DRAFT     Dispatch order never sent      -> nothing
--         PO-CT-EMAILED     priced, invoice emailed        -> po_invoice_emailed 300
--         PO-CT-EM-PLACED   invoice emailed and its bill placed (materials
--                           fact matched to the PO)        -> nothing; fact is actual 150
--         PO-CT-D-EMAILED   Dispatch order, $0, invoice emailed
--                           -> po_invoice_emailed, no amount
--   CT-B  a job with no orders: every new count 0, invoice_emailed_ex null.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('a7c00000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'CT-A', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('a7c00000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'CT-B', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z');

INSERT INTO public.suppliers (id, name) VALUES
  ('a7c10000-0000-4000-8000-000000000001', 'CT Steel'),
  ('a7c10000-0000-4000-8000-000000000002', 'CT Timber'),
  ('a7c10000-0000-4000-8000-000000000003', 'CT Concrete'),
  ('a7c10000-0000-4000-8000-000000000004', 'CT Fixings');

INSERT INTO public.purchase_orders (id, org_id, job_id, po_number, supplier_name, supplier_id, source, status, subtotal, total, created_at, last_sent_at, invoice_received_at) VALUES
  ('a7c20000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'PO-CT-PRICED', 'CT Steel', NULL, NULL, 'sent', 200, 220, '2026-08-01T00:00:00Z', NULL, NULL),
  ('a7c20000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'PO-CT-ZERO', 'CT Steel', NULL, NULL, 'sent', 0, 0, '2026-08-01T00:00:00Z', NULL, NULL),
  ('a7c20000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'PO-CT-D-OLD', 'CT Steel', 'a7c10000-0000-4000-8000-000000000001', 'dispatch', 'sent', 0, 0, '2026-08-01T00:00:00Z', '2026-09-20T02:00:00Z', NULL),
  ('a7c20000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'PO-CT-D-NEW', 'CT Timber', 'a7c10000-0000-4000-8000-000000000002', 'dispatch', 'sent', 0, 0, now() - interval '2 days', now() - interval '2 days', NULL),
  ('a7c20000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'PO-CT-D-DRAFT', 'CT Concrete', 'a7c10000-0000-4000-8000-000000000003', 'dispatch', 'draft', 0, 0, '2026-08-01T00:00:00Z', NULL, NULL),
  ('a7c20000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'PO-CT-EMAILED', 'CT Steel', NULL, NULL, 'confirmed', 300, 330, '2026-08-01T00:00:00Z', NULL, '2026-09-01T20:00:00Z'),
  ('a7c20000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'PO-CT-EM-PLACED', 'CT Steel', NULL, NULL, 'confirmed', 150, 165, '2026-08-01T00:00:00Z', NULL, '2026-09-01T20:00:00Z'),
  ('a7c20000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'PO-CT-D-EMAILED', 'CT Fixings', 'a7c10000-0000-4000-8000-000000000004', 'dispatch', 'sent', 0, 0, '2026-08-01T00:00:00Z', '2026-08-01T02:00:00Z', '2026-08-20T02:00:00Z'),
  -- A 0 subtotal never hides a known total: priced at 1100 / 1.1 = 1000 ex.
  ('a7c20000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'PO-CT-TOTAL-ONLY', 'CT Steel', NULL, NULL, 'sent', 0, 1100, '2026-08-01T00:00:00Z', NULL, NULL);

-- PO-CT-D-OLD: first sent 1 Aug 17:00Z (2 Aug Perth), resent 20 Sep.
INSERT INTO public.job_order_emails (org_id, job_id, purchase_order_id, supplier_id, kind, status, subject, body_text, body_generated_sha, pdf_version, pdf_path, pdf_sha256, line_count, sent_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'a7c20000-0000-4000-8000-000000000003', 'a7c10000-0000-4000-8000-000000000001', 'order', 'sent', 'PO-CT-D-OLD', 'Order', 'x', 1, 'p/1.pdf', 'x', 1, '2026-08-01T17:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'a7c00000-0000-4000-8000-000000000001', 'a7c20000-0000-4000-8000-000000000003', 'a7c10000-0000-4000-8000-000000000001', 'update', 'sent', 'PO-CT-D-OLD update', 'Update', 'x', 2, 'p/2.pdf', 'x', 1, '2026-09-20T02:00:00Z');

-- PO-CT-EM-PLACED: its bill landed as a materials fact matched to the PO.
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, matched_po_id) VALUES
  ('a7c00000-0000-4000-8000-000000000001', 'CT-BILL-1', 'CT-1', 'CT Steel', 'materials', 'actual', 150, 'high', '2026-09-03', 'a7c20000-0000-4000-8000-000000000007');

-- ── Cost events ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  SELECT
    count(*) FILTER (WHERE source = 'po_committed') AS committed_n,
    sum(amount_ex) FILTER (WHERE source = 'po_committed') AS committed_ex,
    count(*) FILTER (WHERE source = 'po_committed' AND COALESCE(amount_ex, 0) = 0) AS committed_zero_n,
    count(*) FILTER (WHERE source = 'po_ordered') AS ordered_n,
    count(*) FILTER (WHERE source = 'po_ordered' AND amount_ex IS NOT NULL) AS ordered_priced_n,
    count(*) FILTER (WHERE source = 'po_invoice_emailed') AS emailed_n,
    sum(amount_ex) FILTER (WHERE source = 'po_invoice_emailed') AS emailed_ex,
    count(*) FILTER (WHERE source LIKE 'po_%' AND is_actual) AS po_actual_n,
    bool_or(document_number IN ('PO-CT-D-DRAFT', 'PO-CT-EM-PLACED')) AS has_excluded
  INTO r
  FROM public.v_job_cost_events
  WHERE job_id = 'a7c00000-0000-4000-8000-000000000001';
  IF r.committed_n <> 2 OR r.committed_ex <> 1200 THEN RAISE EXCEPTION 'cfo12 cost: committed % rows, % ex; expected 2 rows, 1200 (200 + total-only 1000)', r.committed_n, r.committed_ex; END IF;
  IF r.committed_zero_n <> 0 THEN RAISE EXCEPTION 'cfo12 cost: an order with no price is shown as $0 committed'; END IF;
  IF r.ordered_n <> 3 THEN RAISE EXCEPTION 'cfo12 cost: ordered-not-billed rows %, expected 3', r.ordered_n; END IF;
  IF r.ordered_priced_n <> 0 THEN RAISE EXCEPTION 'cfo12 cost: an ordered-not-billed row carries a dollar figure'; END IF;
  IF r.emailed_n <> 2 OR r.emailed_ex <> 300 THEN RAISE EXCEPTION 'cfo12 cost: invoice-emailed % rows, % ex; expected 2 rows, 300', r.emailed_n, r.emailed_ex; END IF;
  IF r.po_actual_n <> 0 THEN RAISE EXCEPTION 'cfo12 cost: a purchase order counted as actual'; END IF;
  IF r.has_excluded THEN RAISE EXCEPTION 'cfo12 cost: an unsent draft or a placed bill''s order is listed'; END IF;

  SELECT event_date, confidence INTO r FROM public.v_job_cost_events WHERE document_number = 'PO-CT-D-OLD';
  IF r.event_date <> '2026-08-02' OR r.confidence <> 'ordered_not_billed' THEN
    RAISE EXCEPTION 'cfo12 cost: Dispatch order dated % (%), expected its first send 2026-08-02 Perth', r.event_date, r.confidence;
  END IF;
  SELECT event_date, confidence, amount_ex INTO r FROM public.v_job_cost_events WHERE document_number = 'PO-CT-EMAILED';
  IF r.event_date <> '2026-09-02' OR r.confidence <> 'invoice_emailed' OR r.amount_ex <> 300 THEN
    RAISE EXCEPTION 'cfo12 cost: emailed order % % %, expected 2026-09-02 Perth, invoice_emailed, 300', r.event_date, r.confidence, r.amount_ex;
  END IF;
  SELECT source, amount_ex INTO r FROM public.v_job_cost_events WHERE document_number = 'PO-CT-D-EMAILED';
  IF r.source <> 'po_invoice_emailed' OR r.amount_ex IS NOT NULL THEN
    RAISE EXCEPTION 'cfo12 cost: emailed Dispatch order % %, expected po_invoice_emailed with no amount', r.source, r.amount_ex;
  END IF;
END $$;

-- ── Job summary ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'CT-A';
  IF r.committed_open_ex <> 1200 THEN RAISE EXCEPTION 'cfo12 job: committed_open_ex %, expected 1200', r.committed_open_ex; END IF;
  IF r.ordered_not_billed_count <> 3 OR r.ordered_not_billed_over_30_count <> 2 THEN
    RAISE EXCEPTION 'cfo12 job: ordered not billed % (over 30 days %), expected 3 (2)', r.ordered_not_billed_count, r.ordered_not_billed_over_30_count;
  END IF;
  IF r.invoice_emailed_count <> 2 OR r.invoice_emailed_ex <> 300 THEN
    RAISE EXCEPTION 'cfo12 job: invoice emailed % / %, expected 2 / 300', r.invoice_emailed_count, r.invoice_emailed_ex;
  END IF;
  IF r.actual_materials_ex <> 150 OR r.actual_cost_ex <> 150 THEN
    RAISE EXCEPTION 'cfo12 job: actual % / %, expected 150: an order moved actual cost', r.actual_materials_ex, r.actual_cost_ex;
  END IF;
  IF NOT ('open_purchase_orders' = ANY (r.completeness)
          AND 'ordered_not_billed' = ANY (r.completeness)
          AND 'ordered_not_billed_over_30_days' = ANY (r.completeness)
          AND 'invoice_emailed_bill_not_placed' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'cfo12 job: completeness %', r.completeness;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'CT-B';
  IF r.committed_open_ex <> 0 OR r.ordered_not_billed_count <> 0 OR r.ordered_not_billed_over_30_count <> 0
     OR r.invoice_emailed_count <> 0 OR r.invoice_emailed_ex IS NOT NULL THEN
    RAISE EXCEPTION 'cfo12 job: empty job % % % % %', r.committed_open_ex, r.ordered_not_billed_count,
      r.ordered_not_billed_over_30_count, r.invoice_emailed_count, r.invoice_emailed_ex;
  END IF;
  IF 'ordered_not_billed' = ANY (r.completeness) OR 'invoice_emailed_bill_not_placed' = ANY (r.completeness) THEN
    RAISE EXCEPTION 'cfo12 job: empty job flagged %', r.completeness;
  END IF;

  -- job_profit(uuid) still answers, with the appended columns
  SELECT * INTO r FROM public.job_profit('a7c00000-0000-4000-8000-000000000001');
  IF r.ordered_not_billed_count <> 3 THEN RAISE EXCEPTION 'cfo12 fn: job_profit() ordered %', r.ordered_not_billed_count; END IF;
END $$;

-- ── Grants unchanged ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.v_job_profit', 'SELECT') OR has_table_privilege('authenticated', 'public.v_job_cost_events', 'SELECT') THEN
    RAISE EXCEPTION 'cfo12 grants: a browser role can read the engine';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'cfo12 grants: service_role lost v_job_profit';
  END IF;
END $$;

ROLLBACK;
