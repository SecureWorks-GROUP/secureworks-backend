-- B4: a Dispatch order and its supplier bill link by themselves, by the owner's rule (3 Nov 2026): the bill is
-- from the order's supplier and carries (a) a supplier ref saved for that order or (b) our job number.
-- Shapes are the live ones on 3 Nov 2026: the CMI and Metroll orders on SWP-261309 (supplier records with no
-- Xero contact; CMI's saved ref 240272), Metroll Perth's bill wording, an R&R purchase order on a fence job.
-- Synthetic records only; every fixture write is rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  patio uuid := 'b4000000-0000-4000-8000-000000000001';   -- SWP-861309
  fence uuid := 'b4000000-0000-4000-8000-000000000002';   -- SWF-861410
  other uuid := 'b4000000-0000-4000-8000-000000000003';   -- SWP-861283, where a person placed one bill
  s_cmi uuid := 'b4000000-0000-4000-8000-000000000011';
  s_metroll uuid := 'b4000000-0000-4000-8000-000000000012';
  s_stratco uuid := 'b4000000-0000-4000-8000-000000000013';
  s_rr uuid := 'b4000000-0000-4000-8000-000000000014';
  o_cmi uuid := 'b4000000-0000-4000-8000-000000000021';
  o_metroll uuid := 'b4000000-0000-4000-8000-000000000022';
  o_metroll_draft uuid := 'b4000000-0000-4000-8000-000000000023';
  o_metroll_fence uuid := 'b4000000-0000-4000-8000-000000000024';
  o_metroll_fence2 uuid := 'b4000000-0000-4000-8000-000000000025';
  po_rr uuid := 'b4000000-0000-4000-8000-000000000031';
  po_rr_draft uuid := 'b4000000-0000-4000-8000-000000000032';
  before_facts text;
  before_queue text;
  before_bill_jobs text;
  got record;
  n integer;
BEGIN
  INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
    (patio, org, 'awaiting_supplier', 'patio', 'SWP-861309'),
    (fence, org, 'scheduled', 'fencing', 'SWF-861410'),
    (other, org, 'in_progress', 'patio', 'SWP-861283');
  INSERT INTO public.suppliers (id, name, xero_contact_id) VALUES
    (s_cmi, 'CMI', NULL),
    (s_metroll, 'Metroll', NULL),
    (s_stratco, 'Stratco', 'xc-stratco'),
    (s_rr, 'R&R Fencing', NULL);
  INSERT INTO public.dispatch_supplier_order_emails (id, org_id, job_id, supplier_id, supplier_name, status, subject, sent_at) VALUES
    (o_cmi, org, patio, s_cmi, 'CMI', 'sent', 'Material Order Ref SWP-861309', '2026-10-30 03:44:39+00'),
    (o_metroll, org, patio, s_metroll, 'Metroll', 'sent', 'Material Order Ref SWP-861309', '2026-10-30 03:44:53+00'),
    (o_metroll_draft, org, other, s_metroll, 'Metroll', 'discarded', 'Material Order Ref SWP-861283', NULL),
    (o_metroll_fence, org, fence, s_metroll, 'Metroll', 'sent', 'Material Order Ref SWF-861410', '2026-10-29 01:00:00+00'),
    (o_metroll_fence2, org, fence, s_metroll, 'Metroll', 'sent', 'Material Order Ref SWF-861410', '2026-10-31 01:00:00+00');
  INSERT INTO public.dispatch_v2_supplier_order_refs (org_id, order_id, job_id, supplier_key, supplier_name, ref, linked_via, created_at) VALUES
    (org, o_cmi, patio, 'cmicombinedmetalindustries', 'CMI', '240272', 'certain_match', '2026-11-02 02:23:03+00'),
    (org, o_metroll_fence2, fence, 'metrollperth', 'Metroll', 'PSI-225053', 'confirmed_guess', '2026-11-01 02:00:00+00');
  INSERT INTO public.purchase_orders (id, org_id, job_id, po_number, supplier_name, supplier_id, status, subtotal, created_at) VALUES
    (po_rr, org, fence, 'PO-298035', 'R&R Fencing', s_rr, 'confirmed', 1288.91, '2026-09-10 01:00:00+00'),
    (po_rr_draft, org, other, 'PO-683376', 'R&R Fencing', s_rr, 'draft', 0, '2026-09-10 01:00:00+00');

  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, invoice_number, status, contact_name, xero_contact_id, reference, line_items, sub_total, invoice_date, job_id) VALUES
    -- (a) CMI's own invoice number, saved for the CMI order from its reply; no job number on the bill.
    (org, 'bill-cmi', 'ACCPAY', '240272', 'AUTHORISED', 'CMI (Combined Metal Industries / CMI WA)', 'xc-cmi', NULL,
      '[{"Description": "Patio steel, 6 lengths"}]', 1830.00, '2026-11-02', NULL),
    -- (b) our job number in the line text, as Metroll Perth writes it.
    (org, 'bill-metroll', 'ACCPAY', '1059031', 'PAID', 'Metroll Perth', 'xc-metroll-perth', NULL,
      '[{"Description": "Material Order Ref SWP-861309 - Spanplus 330 surfmist roofing sheets"}]', 2442.73, '2026-11-02', NULL),
    -- Another supplier naming the same job and quoting CMI's saved ref: never linked.
    (org, 'bill-stratco', 'ACCPAY', 'S-77120', 'AUTHORISED', 'Stratco', 'xc-stratco', 'SWP-861309 240272',
      '[{"Description": "Gutter for SWP861309"}]', 410.00, '2026-11-02', NULL),
    -- A supplier whose name only looks close: never linked.
    (org, 'bill-metro', 'ACCPAY', 'MS-1001', 'AUTHORISED', 'Metro Steel Supplies', 'xc-metro', 'SWP-861309', '[]', 99.00, '2026-11-02', NULL),
    -- A person placed this Metroll bill on SWP-861283; it names SWP-861309. It links, and stays where it is.
    (org, 'bill-placed', 'ACCPAY', '1059100', 'PAID', 'Metroll Pty Ltd', 'xc-metroll-pty', 'SWP 861309', '[]', 120.00, '2026-11-03', other),
    -- Written run together, on the purchase order's fence job, from R&R: (b) links the purchase order.
    (org, 'bill-rr', 'ACCPAY', 'INV-86844', 'PAID', 'R&R FENCING', 'xc-rr', NULL,
      '[{"Description": "Fencing material SWF861410"}]', 1288.91, '2026-09-02', NULL),
    -- Two Metroll orders on the fence job and a bill naming only the job: which order is not known.
    (org, 'bill-two-orders', 'ACCPAY', '1060001', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', 'SWF-861410', '[]', 300.00, '2026-11-01', NULL),
    -- The same job number plus the second order's saved ref, written with a space: the ref picks that order.
    (org, 'bill-ref-picks', 'ACCPAY', '1060002', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', 'SWF-861410 PSI 225053', '[]', 310.00, '2026-11-02', NULL),
    -- One Metroll bill split over the patio and the fence job: it names orders on two jobs, so it links to none.
    (org, 'bill-split', 'ACCPAY', '1060004', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', 'SWP-861309 / SWF-861410', '[]', 640.00, '2026-11-02', NULL),
    -- The job's digits under another prefix (a digit twin), inside a longer number or a longer code: not our job number.
    (org, 'bill-digits', 'ACCPAY', '1060003', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', 'SWF-861309 order 18613090 code CSWP-861309', '[]', 50.00, '2026-11-02', NULL),
    -- Not issued, or voided: never a link.
    (org, 'bill-draft', 'ACCPAY', '240272', 'DRAFT', 'CMI', 'xc-cmi', NULL, '[]', 10.00, '2026-11-02', NULL),
    (org, 'bill-void', 'ACCPAY', '1059032', 'VOIDED', 'Metroll Perth', 'xc-metroll-perth', 'SWP-861309', '[]', 10.00, '2026-11-02', NULL);

  INSERT INTO public.job_materials_facts (org_id, xero_invoice_id, job_id, amount_ex_gst, assigned_by)
    VALUES (org, 'bill-placed', other, 120.00, 'office@secureworkswa.com.au');
  INSERT INTO public.materials_reconciliation_queue (org_id, xero_invoice_id, status, assigned_job_id, assigned_by)
    VALUES (org, 'bill-placed', 'assigned', other, 'office@secureworkswa.com.au');
  SELECT string_agg(f.xero_invoice_id || '@' || f.job_id || '=' || f.amount_ex_gst, ',' ORDER BY f.xero_invoice_id) INTO before_facts
    FROM public.job_materials_facts f WHERE f.org_id = org;
  SELECT string_agg(q.xero_invoice_id || '@' || q.assigned_job_id || ':' || q.status, ',' ORDER BY q.xero_invoice_id) INTO before_queue
    FROM public.materials_reconciliation_queue q WHERE q.org_id = org;
  SELECT string_agg(x.xero_invoice_id || '@' || coalesce(x.job_id::text, '-'), ',' ORDER BY x.xero_invoice_id) INTO before_bill_jobs
    FROM public.xero_invoices x WHERE x.org_id = org;

  -- The orders: sent emails and the live purchase order; a discarded email and a draft PO are not orders.
  SELECT count(*) INTO n FROM public.v_dispatch_orders WHERE job_id IN (patio, fence, other);
  IF n <> 5 OR EXISTS (SELECT 1 FROM public.v_dispatch_orders WHERE order_id IN (o_metroll_draft, po_rr_draft)) THEN
    RAISE EXCEPTION 'Dispatch orders are not the sent emails and live purchase orders: % rows', n;
  END IF;

  -- 1. A bill from another supplier never links, whatever it names (checked first: it is the guard the break proof removes).
  IF EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id IN ('bill-stratco', 'bill-metro')) THEN
    RAISE EXCEPTION 'a bill from another supplier linked to an order: %',
      (SELECT string_agg(xero_invoice_id || '->' || order_id, ', ') FROM public.v_dispatch_order_bills WHERE xero_invoice_id IN ('bill-stratco', 'bill-metro'));
  END IF;

  -- 2. A bill quoting the supplier's saved order ref links, by rule (a), to that order.
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-cmi';
  IF NOT FOUND OR got.order_id <> o_cmi OR NOT got.linked OR got.rule <> 'supplier_ref' OR got.matched_ref <> '240272'
     OR got.ref_saved_via <> 'certain_match' OR got.supplier_match <> 'supplier_name' THEN
    RAISE EXCEPTION 'a bill quoting the saved ref 240272 did not link to the CMI order by supplier_ref: %', row_to_json(got);
  END IF;
  IF (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-cmi') <> 1 THEN
    RAISE EXCEPTION 'the CMI bill names more than its one order';
  END IF;

  -- 3. A bill naming our job number, from the same supplier, links by rule (b).
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-metroll';
  IF NOT FOUND OR got.order_id <> o_metroll OR NOT got.linked OR got.rule <> 'job_number' OR got.matched_job_number <> 'SWP-861309' THEN
    RAISE EXCEPTION 'a Metroll Perth bill naming SWP-861309 did not link to the Metroll order by job_number: %', row_to_json(got);
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-digits') THEN
    RAISE EXCEPTION 'a bill naming SWF-861309, 18613090 and CSWP-861309 was read as naming SWP-861309';
  END IF;
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-rr';
  IF NOT FOUND OR got.order_kind <> 'purchase_order' OR got.order_id <> po_rr OR NOT got.linked OR got.rule <> 'job_number' THEN
    RAISE EXCEPTION 'an R&R bill naming SWF861410 did not link to the R&R purchase order: %', row_to_json(got);
  END IF;

  -- 4. An existing placement never moves: the placed bill links to the order it names, and its placement stays.
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-placed';
  IF NOT FOUND OR got.order_id <> o_metroll OR NOT got.linked OR got.rule <> 'job_number' THEN
    RAISE EXCEPTION 'a placed Metroll bill naming SWP 861309 did not link to the Metroll order: %', row_to_json(got);
  END IF;
  PERFORM count(*) FROM public.v_dispatch_order_bills;
  PERFORM count(*) FROM public.v_dispatch_orders;
  IF (SELECT string_agg(f.xero_invoice_id || '@' || f.job_id || '=' || f.amount_ex_gst, ',' ORDER BY f.xero_invoice_id)
        FROM public.job_materials_facts f WHERE f.org_id = org) IS DISTINCT FROM before_facts
     OR (SELECT string_agg(q.xero_invoice_id || '@' || q.assigned_job_id || ':' || q.status, ',' ORDER BY q.xero_invoice_id)
        FROM public.materials_reconciliation_queue q WHERE q.org_id = org) IS DISTINCT FROM before_queue
     OR (SELECT string_agg(x.xero_invoice_id || '@' || coalesce(x.job_id::text, '-'), ',' ORDER BY x.xero_invoice_id)
        FROM public.xero_invoices x WHERE x.org_id = org) IS DISTINCT FROM before_bill_jobs THEN
    RAISE EXCEPTION 'a bill placement moved';
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.v_dispatch_order_bills'::regclass) <> 'v'
     OR (SELECT relkind FROM pg_class WHERE oid = 'public.v_dispatch_orders'::regclass) <> 'v' THEN
    RAISE EXCEPTION 'the order and bill links are no longer plain views';
  END IF;

  -- 5. One bill links to one order: naming only a job with two orders from the supplier links neither,
  --    and a saved ref picks its order.
  IF EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-two-orders' AND (linked OR not_linked_reason <> 'several_orders_on_job'))
     OR (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-two-orders') <> 2 THEN
    RAISE EXCEPTION 'a bill naming a job with two Metroll orders was linked or not explained';
  END IF;
  IF (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-split' AND NOT linked AND not_linked_reason = 'several_jobs_named') <> 3
     OR EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-split' AND linked) THEN
    RAISE EXCEPTION 'a bill split over two jobs was linked or not explained';
  END IF;
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-ref-picks' AND linked;
  IF NOT FOUND OR got.order_id <> o_metroll_fence2 OR got.rule <> 'supplier_ref+job_number' OR got.matched_ref <> 'PSI-225053'
     OR (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-ref-picks' AND linked) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'bill-ref-picks' AND order_id = o_metroll_fence
                     AND NOT linked AND not_linked_reason = 'other_order_ref') THEN
    RAISE EXCEPTION 'the saved ref PSI 225053 did not pick its order: %', row_to_json(got);
  END IF;

  -- 6. A draft or voided bill is no bill yet.
  IF EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id IN ('bill-draft', 'bill-void')) THEN
    RAISE EXCEPTION 'a draft or voided bill linked';
  END IF;

  -- Only the service role reads the views.
  IF has_table_privilege('anon', 'public.v_dispatch_order_bills', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_dispatch_orders', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_dispatch_order_bills', 'SELECT') THEN
    RAISE EXCEPTION 'the Dispatch order views are not service role only';
  END IF;
END $$;
ROLLBACK;
