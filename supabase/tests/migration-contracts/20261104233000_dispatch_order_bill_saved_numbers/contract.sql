-- B4 rules (e) and (f) (3 Nov 2026): (e) the supplier's own bill number written on our purchase order links that
-- bill to it; (f) our job number in the words of the emails that carry the supplier's PDF of the bill links it to
-- that job's order of that supplier. Two matches link neither; the same amount alone never links.
-- Shapes from 3 Nov 2026: R&R purchase orders made after the bill by operations with "R&R INV-86846" in the
-- reference, Lysaght's "quote KEW/231967 received" in a PO's notes, Metroll's "Quote# 1059031" with 1059031.pdf (a
-- scan no reader can read) forwarded by admin@ to finance@ with "Job Number: SWP-261309".
-- Synthetic records only; every fixture write is rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j_bower uuid := 'b4200000-0000-4000-8000-000000000001';   -- SWF-872271
  j_king uuid := 'b4200000-0000-4000-8000-000000000002';    -- SWF-872168
  j_hurst uuid := 'b4200000-0000-4000-8000-000000000003';   -- SWF-872017
  j_kin uuid := 'b4200000-0000-4000-8000-000000000004';     -- SWP-872309
  j_two uuid := 'b4200000-0000-4000-8000-000000000005';     -- SWP-872311 (two Metroll orders)
  j_other uuid := 'b4200000-0000-4000-8000-000000000006';   -- SWP-872600
  s_rr uuid := 'b4200000-0000-4000-8000-000000000011';
  s_lys uuid := 'b4200000-0000-4000-8000-000000000012';
  s_met uuid := 'b4200000-0000-4000-8000-000000000013';
  s_cmi uuid := 'b4200000-0000-4000-8000-000000000014';
  po_bower uuid := 'b4200000-0000-4000-8000-000000000021';
  po_king uuid := 'b4200000-0000-4000-8000-000000000022';
  po_hurst uuid := 'b4200000-0000-4000-8000-000000000023';
  po_dup1 uuid := 'b4200000-0000-4000-8000-000000000024';
  po_dup2 uuid := 'b4200000-0000-4000-8000-000000000025';
  po_draft uuid := 'b4200000-0000-4000-8000-000000000026';
  po_met uuid := 'b4200000-0000-4000-8000-000000000027';
  o_kin uuid := 'b4200000-0000-4000-8000-000000000031';
  o_cmi uuid := 'b4200000-0000-4000-8000-000000000032';
  o_two1 uuid := 'b4200000-0000-4000-8000-000000000033';
  o_two2 uuid := 'b4200000-0000-4000-8000-000000000034';
  o_other uuid := 'b4200000-0000-4000-8000-000000000035';
  got record;
  n integer;
BEGIN
  INSERT INTO public.jobs (id, org_id, status, type, job_number, site_address) VALUES
    (j_bower, org, 'archived', 'fencing', 'SWF-872271', '3/14 Bower St, Scarborough WA 6019'),
    (j_king, org, 'archived', 'fencing', 'SWF-872168', '14 King Edward St, South Perth WA 6151'),
    (j_hurst, org, 'archived', 'fencing', 'SWF-872017', '26 Hurst Trail, Clarkson WA 6030'),
    (j_kin, org, 'awaiting_supplier', 'patio', 'SWP-872309', '4 Kinglassie Cir, Kinross WA 6028'),
    (j_two, org, 'scheduled', 'patio', 'SWP-872311', '9 Two Orders Way, Wanneroo WA 6065'),
    (j_other, org, 'scheduled', 'patio', 'SWP-872600', '45 Ocean Reef Road, Mullaloo WA 6027');
  INSERT INTO public.suppliers (id, name, xero_contact_id) VALUES
    (s_rr, 'R&R Fencing', NULL), (s_lys, 'Lysaght', NULL), (s_met, 'Metroll', NULL), (s_cmi, 'CMI', NULL);
  INSERT INTO public.purchase_orders (id, org_id, job_id, po_number, supplier_name, supplier_id, status, subtotal, created_at, reference, notes) VALUES
    (po_bower, org, j_bower, 'PO-872460', 'R&R Fencing', s_rr, 'confirmed', 1058, '2026-09-10 23:34:00+00', 'R&R INV-96846',
     'SWF-872271. Ordered by email from admin@ 1 Sep 2026. R&R invoice INV-96846 $1,163.80 inc GST due 15 Oct 2026. PO record created after the fact by OPERATIONS 11 Sep.'),
    (po_king, org, j_king, 'PO-872382', 'R&R Fencing', s_rr, 'confirmed', 1570.73, '2026-09-10 23:35:00+00', 'R&R INV-97293',
     'SWF-872168. Separate B&D Metals invoice for the slat infill steel is unpaid.'),
    (po_hurst, org, j_hurst, 'PO-872017', 'Lysaght', s_lys, 'billed', 617.64, '2026-04-02 08:32:00+00', 'SWF-872017 Clarkson',
     E'[2026-04-02] PO emailed to Lysaght.\n[2026-04-07] Lysaght quote KEW/931967 received via email. Products verified against PO. Total $679.56 inc GST.'),
    -- Two orders carrying one bill number: neither links.
    (po_dup1, org, j_bower, 'PO-872901', 'R&R Fencing', s_rr, 'confirmed', 10, '2026-09-11 00:00:00+00', 'R&R INV-97900', NULL),
    (po_dup2, org, j_king, 'PO-872902', 'R&R Fencing', s_rr, 'confirmed', 10, '2026-09-11 00:00:00+00', NULL, 'see R&R INV-97900'),
    -- A draft purchase order is no order.
    (po_draft, org, j_king, 'PO-872903', 'R&R Fencing', s_rr, 'draft', 0, '2026-09-11 00:00:00+00', 'R&R INV-97901', NULL),
    -- Digits-only numbers: a quote number of 6 or more digits is read; an amount ($ or decimals) or a 5-digit number never.
    (po_met, org, j_other, 'PO-872904', 'Metroll', s_met, 'confirmed', 10, '2026-10-20 00:00:00+00', 'Metroll quote 1072001',
     'Paid $1072002 on card; ref 72003; total 1072006.50');
  INSERT INTO public.dispatch_supplier_order_emails (id, org_id, job_id, supplier_id, supplier_name, status, subject, sent_at, sent_to_emails) VALUES
    (o_kin, org, j_kin, s_met, 'Metroll', 'sent', 'Material Order Ref SWP-872309', '2026-10-30 03:44:00+00', ARRAY['orders@perth.metroll.com.au']),
    (o_cmi, org, j_kin, s_cmi, 'CMI', 'sent', 'Material Order Ref SWP-872309', '2026-10-30 03:44:00+00', ARRAY['kris@cmiwa.com.au']),
    (o_two1, org, j_two, s_met, 'Metroll', 'sent', 'Material Order Ref SWP-872311', '2026-10-30 04:00:00+00', ARRAY['orders@perth.metroll.com.au']),
    (o_two2, org, j_two, s_met, 'Metroll', 'sent', 'Material Order Ref SWP-872311', '2026-10-31 04:00:00+00', ARRAY['orders@perth.metroll.com.au']),
    (o_other, org, j_other, s_met, 'Metroll', 'sent', 'Material Order Ref SWP-872600', '2026-10-30 05:00:00+00', ARRAY['orders@perth.metroll.com.au']);

  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, invoice_number, status, contact_name, xero_contact_id, reference, line_items, sub_total, invoice_date) VALUES
    -- (e) the bill's number in the PO's reference and notes: links, found on our order.
    (org, 'e-ref', 'ACCPAY', 'INV-96846', 'PAID', 'R&R FENCING', 'xc-rr', NULL, '[{"Description": "Fencing material"}]', 1058, '2026-09-02'),
    -- (e) a delivery-fee bill numbered INV-96846a is another bill: never the PO's.
    (org, 'e-suffix', 'ACCPAY', 'INV-96846a', 'PAID', 'R&R FENCING', 'xc-rr', NULL, '[{"Description": "Delivery fee"}]', 10.92, '2026-09-10'),
    -- (e) the bill's number only in the PO's reference.
    (org, 'e-ref2', 'ACCPAY', 'INV-97293', 'PAID', 'R&R FENCING', 'xc-rr', NULL, '[{"Description": "Fencing Material"}]', 1570.73, '2026-09-08'),
    -- (e) written with a slash in the notes ("KEW/931967"); the bill number carries words after it.
    (org, 'e-notes', 'ACCPAY', 'KEW931967 - Receipt DC', 'PAID', 'Lysaght', 'xc-lys', NULL, '[{"Description": "NEETA INFILL SHEET"}]', 618.14, '2026-04-07'),
    -- Another Lysaght bill on no order record: nothing.
    (org, 'e-none', 'ACCPAY', 'KEW929040 - Receipt DC - Project Required', 'PAID', 'Lysaght', 'xc-lys', NULL, '[{"Description": "NEETA INFILL SHEET DOMAIN"}]', 423.99, '2026-03-06'),
    -- (e) one bill number on two purchase orders: neither links.
    (org, 'e-two', 'ACCPAY', 'INV-97900', 'PAID', 'R&R FENCING', 'xc-rr', NULL, '[]', 10, '2026-09-11'),
    -- (e) the number on a draft PO only: no order.
    (org, 'e-draft', 'ACCPAY', 'INV-97901', 'PAID', 'R&R FENCING', 'xc-rr', NULL, '[]', 10, '2026-09-11'),
    -- (e) another supplier's bill with that number: never.
    (org, 'e-other', 'ACCPAY', 'INV-96846', 'PAID', 'Stratco', 'xc-stratco', NULL, '[]', 1058, '2026-09-02'),
    -- (e) the PO names the bill but the bill names another job: the job disagrees, nothing links.
    (org, 'e-disagree', 'ACCPAY', 'INV-97293', 'AUTHORISED', 'R&R FENCING', 'xc-rr', 'SWF-872271', '[]', 5, '2026-09-12'),
    -- (e) digits only: a 7-digit quote number links; a dollar amount, a 5-digit number and a decimal amount never.
    (org, 'e-digits', 'ACCPAY', '1072001', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[]', 100, '2026-10-21'),
    (org, 'e-amount', 'ACCPAY', '1072002', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[]', 100, '2026-10-21'),
    (org, 'e-short', 'ACCPAY', '72003', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[]', 100, '2026-10-21'),
    (org, 'e-decimal', 'ACCPAY', '1072006', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[]', 100, '2026-10-21'),
    -- (f) Metroll's quote PDF, forwarded by us naming the job: links the job's Metroll order, found on the PDF email.
    (org, 'f-one', 'ACCPAY', '1079031', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[{"Description": "Quotation from Metroll Perth for SecureWorks Group"}]', 2442.73, '2026-11-02'),
    -- (f) the emails name two job numbers: the rule does not apply.
    (org, 'f-twojobs', 'ACCPAY', '1079032', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[]', 200, '2026-11-02'),
    -- (f) the PDF came from a domain this order was not sent to: never.
    (org, 'f-domain', 'ACCPAY', '1079033', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[]', 300, '2026-11-02'),
    -- (f) only a customer's forward names the job: a customer's words are never read.
    (org, 'f-customer', 'ACCPAY', '1079034', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[]', 400, '2026-11-02'),
    -- (f) the supplier's PDF file name does not carry the bill's number: not the bill's PDF.
    (org, 'f-filename', 'ACCPAY', '1079035', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[]', 500, '2026-11-02'),
    -- (f) the job has two Metroll orders: neither links.
    (org, 'f-twoorders', 'ACCPAY', '1079036', 'PAID', 'Metroll Perth', 'xc-met', NULL, '[]', 600, '2026-11-02'),
    -- (b) unchanged: our job number on the bill still links and still says job_number found on the bill.
    (org, 'b-bill', 'ACCPAY', 'PSI-226698', 'AUTHORISED', 'CMI (Combined Metal Industries / CMI WA)', 'xc-cmi', NULL,
      '[{"Description": "PSI-226698 SWP-872309 Patio tube (pickup)"}]', 564.21, '2026-10-29');

  INSERT INTO public.business_events (id, job_id, event_type, source, entity_type, occurred_at, direction, payload) VALUES
    -- f-one: Metroll's email (no job number; "Ref SWP872309" written run together) and our forward to finance@.
    ('b4200000-0000-4000-8000-0000000000f1', j_kin, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-01 21:27:00+00', 'inbound',
      '{"subject": "Quote# 1079031", "from": "quotes@perth.metroll.com.au", "body": "Please find attached quote. Ref SWP872309"}'),
    ('b4200000-0000-4000-8000-0000000000f2', j_kin, 'staff.email_internal', 'outlook-mail-capture', 'email', '2026-11-02 03:12:00+00', 'internal',
      '{"subject": "Fw: Quote# 1079031", "from": "admin@secureworkswa.com.au", "body": "Hi Esther, can you please help me make payment for this?\nType: Patio\nJob Number: SWP-872309\nAddress: 4 Kinglassie Cir, Kinross WA 6028"}'),
    -- f-twojobs: our forward names SWP-872309 and SWP-872600.
    ('b4200000-0000-4000-8000-0000000000f3', j_kin, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-01 21:30:00+00', 'inbound',
      '{"subject": "Quote# 1079032", "from": "quotes@perth.metroll.com.au", "body": "Quote attached"}'),
    ('b4200000-0000-4000-8000-0000000000f4', j_kin, 'staff.email_internal', 'outlook-mail-capture', 'email', '2026-11-02 03:20:00+00', 'internal',
      '{"subject": "Fw: Quote# 1079032", "from": "admin@secureworkswa.com.au", "body": "Pay this for SWP-872309 and SWP-872600"}'),
    -- f-domain: the PDF came from another domain; our forward names the job.
    ('b4200000-0000-4000-8000-0000000000f5', j_kin, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-01 21:40:00+00', 'inbound',
      '{"subject": "Quote# 1079033", "from": "quotes@metroll-quotes.example.com", "body": "Quote attached"}'),
    ('b4200000-0000-4000-8000-0000000000f6', j_kin, 'staff.email_internal', 'outlook-mail-capture', 'email', '2026-11-02 03:30:00+00', 'internal',
      '{"subject": "Fw: Quote# 1079033", "from": "admin@secureworkswa.com.au", "body": "Job Number: SWP-872309"}'),
    -- f-customer: Metroll's email without a job number, and a customer's forward that names it.
    ('b4200000-0000-4000-8000-0000000000f7', j_kin, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-01 21:50:00+00', 'inbound',
      '{"subject": "Quote# 1079034", "from": "quotes@perth.metroll.com.au", "body": "Quote attached"}'),
    ('b4200000-0000-4000-8000-0000000000f8', j_kin, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-02 04:00:00+00', 'inbound',
      '{"subject": "Fwd: Metroll quote for SWP-872309", "from": "aaron.citizen@gmail.com", "body": "Is this for my job SWP-872309?"}'),
    -- f-filename: Metroll's PDF named fax01684219.pdf; our forward names the job.
    ('b4200000-0000-4000-8000-0000000000f9', j_kin, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-03 01:57:00+00', 'inbound',
      '{"subject": "Metroll confirmation SO#1079035", "from": "orders@perth.metroll.com.au", "body": ""}'),
    ('b4200000-0000-4000-8000-0000000000fa', j_kin, 'staff.email_internal', 'outlook-mail-capture', 'email', '2026-11-03 02:00:00+00', 'internal',
      '{"subject": "Fw: Metroll confirmation SO#1079035", "from": "admin@secureworkswa.com.au", "body": "Job Number: SWP-872309"}'),
    -- f-twoorders: our forward names SWP-872311, which has two Metroll orders.
    ('b4200000-0000-4000-8000-0000000000fb', j_two, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-01 22:00:00+00', 'inbound',
      '{"subject": "Quote# 1079036", "from": "quotes@perth.metroll.com.au", "body": "Quote attached"}'),
    ('b4200000-0000-4000-8000-0000000000fc', j_two, 'staff.email_internal', 'outlook-mail-capture', 'email', '2026-11-02 04:10:00+00', 'internal',
      '{"subject": "Fw: Quote# 1079036", "from": "admin@secureworkswa.com.au", "body": "Job Number: SWP-872311"}');
  INSERT INTO public.context_email_attachments (id, provider_message_id, attachment_key, file_name, content_type, sha256, storage_bucket, storage_path, status, business_event_id) VALUES
    ('b4200000-0000-4000-8000-0000000000a1', 'email:b4-872-1', md5('b1') || md5('b1x'), '1079031.pdf', 'application/pdf', md5('p1') || md5('p1x'), 'context-email-attachments', 'b4/1.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000f1'),
    ('b4200000-0000-4000-8000-0000000000a2', 'email:b4-872-2', md5('b2') || md5('b2x'), '1079031.pdf', 'application/pdf', md5('p1') || md5('p1x'), 'context-email-attachments', 'b4/2.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000f2'),
    ('b4200000-0000-4000-8000-0000000000a3', 'email:b4-872-3', md5('b3') || md5('b3x'), '1079032.pdf', 'application/pdf', md5('p3') || md5('p3x'), 'context-email-attachments', 'b4/3.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000f3'),
    ('b4200000-0000-4000-8000-0000000000a4', 'email:b4-872-4', md5('b4') || md5('b4x'), '1079032.pdf', 'application/pdf', md5('p3') || md5('p3x'), 'context-email-attachments', 'b4/4.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000f4'),
    ('b4200000-0000-4000-8000-0000000000a5', 'email:b4-872-5', md5('b5') || md5('b5x'), '1079033.pdf', 'application/pdf', md5('p5') || md5('p5x'), 'context-email-attachments', 'b4/5.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000f5'),
    ('b4200000-0000-4000-8000-0000000000a6', 'email:b4-872-6', md5('b6') || md5('b6x'), '1079033.pdf', 'application/pdf', md5('p5') || md5('p5x'), 'context-email-attachments', 'b4/6.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000f6'),
    ('b4200000-0000-4000-8000-0000000000a7', 'email:b4-872-7', md5('b7') || md5('b7x'), '1079034.pdf', 'application/pdf', md5('p7') || md5('p7x'), 'context-email-attachments', 'b4/7.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000f7'),
    ('b4200000-0000-4000-8000-0000000000a8', 'email:b4-872-8', md5('b8') || md5('b8x'), '1079034.pdf', 'application/pdf', md5('p7') || md5('p7x'), 'context-email-attachments', 'b4/8.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000f8'),
    ('b4200000-0000-4000-8000-0000000000a9', 'email:b4-872-9', md5('b9') || md5('b9x'), 'fax01684219.pdf', 'application/pdf', md5('p9') || md5('p9x'), 'context-email-attachments', 'b4/9.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000f9'),
    ('b4200000-0000-4000-8000-0000000000aa', 'email:b4-872-a', md5('ba') || md5('bax'), 'fax01684219.pdf', 'application/pdf', md5('p9') || md5('p9x'), 'context-email-attachments', 'b4/a.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000fa'),
    ('b4200000-0000-4000-8000-0000000000ab', 'email:b4-872-b', md5('bb') || md5('bbx'), '1079036.pdf', 'application/pdf', md5('pb') || md5('pbx'), 'context-email-attachments', 'b4/b.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000fb'),
    ('b4200000-0000-4000-8000-0000000000ac', 'email:b4-872-c', md5('bc') || md5('bcx'), '1079036.pdf', 'application/pdf', md5('pb') || md5('pbx'), 'context-email-attachments', 'b4/c.pdf', 'stored', 'b4200000-0000-4000-8000-0000000000fc');

  -- 1. (e) the bill's number on our purchase order links it there: in the reference and notes, in the reference
  --    only, and written with a slash in the notes.
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'e-ref';
  IF NOT FOUND OR got.order_id <> po_bower OR NOT got.linked OR got.rule <> 'bill_number' OR got.matched_in <> 'order'
     OR got.matched_job_number IS NOT NULL OR got.matched_po_number IS NOT NULL THEN
    RAISE EXCEPTION 'R&R INV-96846 did not link to PO-872460 by bill_number: %', row_to_json(got);
  END IF;
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'e-ref2' AND order_id = po_king;
  IF NOT FOUND OR NOT got.linked OR got.rule <> 'bill_number' OR got.matched_in <> 'order' THEN
    RAISE EXCEPTION 'R&R INV-97293 did not link to PO-872382 by bill_number: %', row_to_json(got);
  END IF;
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'e-notes';
  IF NOT FOUND OR got.order_id <> po_hurst OR NOT got.linked OR got.rule <> 'bill_number' OR got.matched_in <> 'order' THEN
    RAISE EXCEPTION 'Lysaght KEW931967 did not link to PO-872017 from "KEW/931967" in its notes: %', row_to_json(got);
  END IF;

  -- 2. (e) never: a suffixed bill number, a bill on no order record, a draft PO, another supplier, a dollar
  --    amount, a 5-digit number, a decimal amount.
  SELECT count(*) INTO n FROM public.v_dispatch_order_bills
   WHERE xero_invoice_id IN ('e-suffix', 'e-none', 'e-draft', 'e-other', 'e-amount', 'e-short', 'e-decimal');
  IF n <> 0 THEN
    RAISE EXCEPTION 'a bill named an order by (e) it must not: %',
      (SELECT string_agg(xero_invoice_id || '->' || job_number || ' ' || rule, ', ') FROM public.v_dispatch_order_bills
        WHERE xero_invoice_id IN ('e-suffix', 'e-none', 'e-draft', 'e-other', 'e-amount', 'e-short', 'e-decimal'));
  END IF;
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'e-digits';
  IF NOT FOUND OR got.order_id <> po_met OR NOT got.linked OR got.rule <> 'bill_number' THEN
    RAISE EXCEPTION 'Metroll 1072001 did not link to PO-872904 from "Metroll quote 1072001": %', row_to_json(got);
  END IF;

  -- 3. (e) one bill number on two purchase orders links neither; a PO naming the bill while the bill names another
  --    job links nothing.
  IF (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'e-two' AND NOT linked
        AND not_linked_reason = 'several_order_numbers' AND rule = 'bill_number') <> 2
     OR EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'e-two' AND linked) THEN
    RAISE EXCEPTION 'one bill number on two POs was linked or not explained';
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'e-disagree' AND linked)
     OR NOT EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'e-disagree' AND order_id = po_king
                     AND not_linked_reason = 'job_disagrees' AND rule = 'bill_number') THEN
    RAISE EXCEPTION 'a bill whose number is on PO-872382 but which names SWF-872271 linked or was not explained';
  END IF;

  -- 4. (f) our job number on the email that carries the supplier's PDF links the job's order of that supplier, and
  --    only that one (the CMI order on the same job is another supplier).
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'f-one';
  IF NOT FOUND OR got.order_id <> o_kin OR NOT got.linked OR got.rule <> 'job_number' OR got.matched_in <> 'pdf_email'
     OR got.matched_job_number <> 'SWP-872309' THEN
    RAISE EXCEPTION 'Metroll 1079031 forwarded with Job Number: SWP-872309 did not link to its Metroll order: %', row_to_json(got);
  END IF;
  IF (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'f-one') <> 1 THEN
    RAISE EXCEPTION 'Metroll 1079031 named more than its one order';
  END IF;

  -- 5. (f) never: two job numbers in the words, a PDF from another domain, a customer's words, a PDF whose file name
  --    does not carry the bill's number.
  SELECT count(*) INTO n FROM public.v_dispatch_order_bills WHERE xero_invoice_id IN ('f-twojobs', 'f-domain', 'f-customer', 'f-filename');
  IF n <> 0 THEN
    RAISE EXCEPTION 'a bill named an order by (f) it must not: %',
      (SELECT string_agg(xero_invoice_id || '->' || job_number || ' ' || rule, ', ') FROM public.v_dispatch_order_bills
        WHERE xero_invoice_id IN ('f-twojobs', 'f-domain', 'f-customer', 'f-filename'));
  END IF;

  -- 6. (f) a job with two orders of that supplier: neither links, and each row says why.
  IF (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'f-twoorders' AND NOT linked
        AND not_linked_reason = 'several_orders_on_job' AND rule = 'job_number' AND matched_in = 'pdf_email') <> 2 THEN
    RAISE EXCEPTION 'a PDF email naming a job with two Metroll orders linked or was not explained';
  END IF;

  -- 7. (b) is unchanged: our job number on the bill links, found on the bill.
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'b-bill';
  IF NOT FOUND OR got.order_id <> o_cmi OR NOT got.linked OR got.rule <> 'job_number' OR got.matched_in <> 'bill' THEN
    RAISE EXCEPTION 'CMI PSI-226698 naming SWP-872309 no longer links by job_number on the bill: %', row_to_json(got);
  END IF;

  -- No placement moved: the view writes nothing.
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id LIKE 'e-%' OR xero_invoice_id LIKE 'f-%')
     OR EXISTS (SELECT 1 FROM public.materials_reconciliation_queue WHERE xero_invoice_id LIKE 'e-%' OR xero_invoice_id LIKE 'f-%')
     OR EXISTS (SELECT 1 FROM public.xero_invoices WHERE (xero_invoice_id LIKE 'e-%' OR xero_invoice_id LIKE 'f-%') AND job_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a bill placement appeared';
  END IF;

  -- Only the service role reads the view.
  IF has_table_privilege('anon', 'public.v_dispatch_order_bills', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_dispatch_order_bills', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_dispatch_order_bills', 'SELECT') THEN
    RAISE EXCEPTION 'v_dispatch_order_bills is not service role only';
  END IF;
END $$;
ROLLBACK;
