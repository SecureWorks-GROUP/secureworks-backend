-- B4 rules (c) and (d) (CIO decision 3 Nov 2026 09:44Z): a supplier bill also links to an order by (c) our PO
-- number on the bill or on the supplier's PDF of it, and (d) the job's site address on the supplier's PDF when
-- it matches exactly one order of that supplier. Two matches link neither; the same amount alone never links.
-- Shapes from 3 Nov 2026: R&R purchase orders on fence jobs (PO-298035 style numbers, "Fencing material" lines,
-- the 18 Enid Rd delivery line), Metroll Dispatch v2 orders on patio jobs, PDFs named after the bill number.
-- Synthetic records only; every fixture write is rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j_enid uuid := 'b4100000-0000-4000-8000-000000000001';    -- SWF-871410, 18 Enid Rd, Kalamunda
  j_hale uuid := 'b4100000-0000-4000-8000-000000000002';    -- SWF-871500, 7 Hale Way, Wanneroo
  j_smith uuid := 'b4100000-0000-4000-8000-000000000003';   -- SWP-871309, 12 Smith Street, Joondalup
  j_smith2 uuid := 'b4100000-0000-4000-8000-000000000004';  -- SWP-871311, the same site again
  j_reef uuid := 'b4100000-0000-4000-8000-000000000005';    -- SWP-871600, 45 Ocean Reef Road, Mullaloo
  s_rr uuid := 'b4100000-0000-4000-8000-000000000011';
  s_metroll uuid := 'b4100000-0000-4000-8000-000000000012';
  s_stratco uuid := 'b4100000-0000-4000-8000-000000000013';
  po_enid uuid := 'b4100000-0000-4000-8000-000000000021';
  po_hale uuid := 'b4100000-0000-4000-8000-000000000022';
  po_draft uuid := 'b4100000-0000-4000-8000-000000000023';
  o_smith uuid := 'b4100000-0000-4000-8000-000000000031';
  o_smith2 uuid := 'b4100000-0000-4000-8000-000000000032';
  o_reef uuid := 'b4100000-0000-4000-8000-000000000033';
  o_stratco uuid := 'b4100000-0000-4000-8000-000000000034';
  got record;
  n integer;
BEGIN
  INSERT INTO public.jobs (id, org_id, status, type, job_number, site_address) VALUES
    (j_enid, org, 'scheduled', 'fencing', 'SWF-871410', '18 Enid Rd, Kalamunda WA 6076'),
    (j_hale, org, 'scheduled', 'fencing', 'SWF-871500', '7 Hale Way, Wanneroo WA 6065'),
    (j_smith, org, 'awaiting_supplier', 'patio', 'SWP-871309', '12 Smith Street, Joondalup WA 6027'),
    (j_smith2, org, 'scheduled', 'patio', 'SWP-871311', '12 Smith St, Joondalup'),
    (j_reef, org, 'awaiting_supplier', 'patio', 'SWP-871600', '45 Ocean Reef Road, Mullaloo WA 6027');
  INSERT INTO public.suppliers (id, name, xero_contact_id) VALUES
    (s_rr, 'R&R Fencing', NULL), (s_metroll, 'Metroll', NULL), (s_stratco, 'Stratco', 'xc-stratco-871');
  INSERT INTO public.purchase_orders (id, org_id, job_id, po_number, supplier_name, supplier_id, status, subtotal, created_at) VALUES
    (po_enid, org, j_enid, 'PO-871001', 'R&R Fencing', s_rr, 'confirmed', 1288.91, '2026-09-10 01:00:00+00'),
    (po_hale, org, j_hale, 'PO-871002', 'R&R Fencing', s_rr, 'sent', 1570.73, '2026-09-10 01:00:00+00'),
    (po_draft, org, j_hale, 'PO-871003', 'R&R Fencing', s_rr, 'draft', 0, '2026-09-10 01:00:00+00');
  INSERT INTO public.dispatch_supplier_order_emails (id, org_id, job_id, supplier_id, supplier_name, status, subject, sent_at) VALUES
    (o_smith, org, j_smith, s_metroll, 'Metroll', 'sent', 'Material Order Ref SWP-871309', '2026-10-30 03:00:00+00'),
    (o_smith2, org, j_smith2, s_metroll, 'Metroll', 'sent', 'Material Order Ref SWP-871311', '2026-10-31 03:00:00+00'),
    (o_reef, org, j_reef, s_metroll, 'Metroll', 'sent', 'Material Order Ref SWP-871600', '2026-10-30 04:00:00+00'),
    (o_stratco, org, j_smith, s_stratco, 'Stratco', 'sent', 'Material Order Ref SWP-871309', '2026-10-30 05:00:00+00');

  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_type, invoice_number, status, contact_name, xero_contact_id, reference, line_items, sub_total, invoice_date) VALUES
    -- (c) our PO number in a line, written run together with a #.
    (org, 'c-line', 'ACCPAY', 'INV-90001', 'PAID', 'R&R FENCING', 'xc-rr', NULL, '[{"Description": "Fencing material PO#871001"}]', 1288.91, '2026-09-02'),
    -- (c) our PO number only on the supplier's PDF; the Xero lines say "Fencing material".
    (org, 'c-pdf', 'ACCPAY', 'INV-90002', 'PAID', 'R&R FENCING', 'xc-rr', NULL, '[{"Description": "Fencing material"}]', 1570.73, '2026-09-08'),
    -- (c) two of our PO numbers on one bill: neither links.
    (org, 'c-two', 'ACCPAY', 'INV-90003', 'AUTHORISED', 'R&R FENCING', 'xc-rr', 'PO-871001 PO-871002', '[]', 2859.64, '2026-09-09'),
    -- Another supplier quoting our PO number: never.
    (org, 'c-other', 'ACCPAY', 'S-90004', 'AUTHORISED', 'Stratco', 'xc-stratco-871', 'PO-871001', '[]', 50.00, '2026-09-09'),
    -- A draft purchase order is no order.
    (org, 'c-draft', 'ACCPAY', 'INV-90005', 'AUTHORISED', 'R&R FENCING', 'xc-rr', 'PO-871003', '[]', 40.00, '2026-09-09'),
    -- The PO number's digits alone are not our PO number; the same amount alone never links.
    (org, 'c-digits', 'ACCPAY', 'INV-90006', 'AUTHORISED', 'R&R FENCING', 'xc-rr', NULL, '[{"Description": "order 871001"}]', 1288.91, '2026-09-09'),
    -- Our PO number for one job and another job's number on the same bill: the job disagrees, nothing links.
    (org, 'c-disagree', 'ACCPAY', 'INV-90007', 'AUTHORISED', 'R&R FENCING', 'xc-rr', 'PO-871001 SWF-871500', '[]', 30.00, '2026-09-09'),
    -- (d) the job's site on the supplier's PDF (read by the vision reader): one Metroll order there.
    (org, 'd-one', 'ACCPAY', '1070001', 'PAID', 'Metroll Perth', 'xc-metroll-perth', NULL, '[{"Description": "Roofing sheets"}]', 2442.73, '2026-11-02'),
    -- (d) a site with two Metroll orders (two jobs at 12 Smith Street): neither links.
    (org, 'd-two', 'ACCPAY', '1070002', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', NULL, '[]', 300.00, '2026-11-02'),
    -- A PDF named for the bill whose text does not carry the bill's number is not the bill's PDF.
    (org, 'd-wrongpdf', 'ACCPAY', '1070003', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', NULL, '[]', 310.00, '2026-11-02'),
    -- A PDF we sent (our quote) carrying the bill's number, the supplier's name and the site, from a mailbox of ours
    -- named for the supplier: never the supplier's.
    (org, 'd-ours', 'ACCPAY', '1070004', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', NULL, '[]', 320.00, '2026-11-02'),
    -- A PDF that came in carrying the bill's number and the site but not the supplier's name: not the supplier's.
    (org, 'd-noname', 'ACCPAY', '1070005', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', NULL, '[]', 330.00, '2026-11-02'),
    -- (d) the job's site in the bill's own Xero line text, as R&R writes it: one R&R order there.
    (org, 'd-bill', 'ACCPAY', 'INV-90009', 'PAID', 'R&R FENCING', 'xc-rr', NULL,
      '[{"Description": "DELIVERY DATE 08/09/2026 WEDNESDAY\nGOING TO 18 ENID RD, KALAMUNDA"}, {"Description": "COLORBOND PANEL H1800MM X W2380MM"}]', 1288.91, '2026-09-09'),
    -- (d) a site in the bill's lines with two Metroll orders (two jobs at 12 Smith Street): neither links.
    (org, 'd-bill-two', 'ACCPAY', '1070010', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', NULL, '[{"Description": "Deliver to 12 Smith Street, Joondalup"}]', 340.00, '2026-11-02'),
    -- (c) our PO number on a scanned supplier PDF, read by the vision reader.
    (org, 'c-scan', 'ACCPAY', 'INV-90011', 'PAID', 'R&R FENCING', 'xc-rr', NULL, '[{"Description": "Fencing material"}]', 1570.73, '2026-09-10'),
    -- (d) a scanned supplier PDF delivering to a site with two Metroll orders: neither links.
    (org, 'd-scan-two', 'ACCPAY', '1070012', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', NULL, '[]', 350.00, '2026-11-02'),
    -- A supplier's PDF forwarded by a customer did not come from the supplier: never.
    (org, 'd-forward', 'ACCPAY', '1070013', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', NULL, '[]', 360.00, '2026-11-02'),
    -- A scan neither reader could read has no text: the bill waits.
    (org, 'd-scan-none', 'ACCPAY', '1070014', 'AUTHORISED', 'Metroll Perth', 'xc-metroll-perth', NULL, '[]', 370.00, '2026-11-02');

  -- The emails the PDFs came with: in from the supplier (Metroll's real sender is quotes@perth.metroll.com.au, filed
  -- as a customer email), except the quote we sent and the customer's forward.
  INSERT INTO public.business_events (id, job_id, event_type, source, entity_type, occurred_at, direction, payload) VALUES
    ('b4100000-0000-4000-8000-0000000000f1', j_hale, 'supplier.email_in', 'outlook-mail-capture', 'email', '2026-09-08 01:00:00+00', 'inbound', '{"subject": "Invoice INV-90002", "from": "accounts@randrfencing.com.au"}'),
    ('b4100000-0000-4000-8000-0000000000f2', j_reef, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-02 01:00:00+00', 'inbound', '{"subject": "Invoice 1070001", "from": "quotes@perth.metroll.com.au"}'),
    ('b4100000-0000-4000-8000-0000000000f3', j_smith, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-02 01:00:00+00', 'inbound', '{"subject": "Invoice 1070002", "from": "quotes@perth.metroll.com.au"}'),
    ('b4100000-0000-4000-8000-0000000000f4', j_reef, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-02 01:00:00+00', 'inbound', '{"subject": "Statement", "from": "quotes@perth.metroll.com.au"}'),
    ('b4100000-0000-4000-8000-0000000000f5', j_reef, 'client.email_out', 'outlook-mail-capture', 'email', '2026-11-02 01:00:00+00', 'outbound', '{"subject": "Your patio quote", "from": "metroll.orders@secureworkswa.com.au"}'),
    ('b4100000-0000-4000-8000-0000000000f6', j_reef, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-02 01:00:00+00', 'inbound', '{"subject": "Invoice 1070005", "from": "quotes@perth.metroll.com.au"}'),
    ('b4100000-0000-4000-8000-0000000000f7', j_hale, 'supplier.email_in', 'outlook-mail-capture', 'email', '2026-09-10 01:00:00+00', 'inbound', '{"subject": "Invoice INV-90011", "from": "accounts@randrfencing.com.au"}'),
    ('b4100000-0000-4000-8000-0000000000f8', j_smith, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-02 01:00:00+00', 'inbound', '{"subject": "Invoice 1070012", "from": "quotes@perth.metroll.com.au"}'),
    ('b4100000-0000-4000-8000-0000000000f9', j_reef, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-02 01:00:00+00', 'inbound', '{"subject": "Fwd: Metroll invoice", "from": "jane.citizen@gmail.com"}'),
    ('b4100000-0000-4000-8000-0000000000fa', j_reef, 'client.email_in', 'outlook-mail-capture', 'email', '2026-11-02 01:00:00+00', 'inbound', '{"subject": "Invoice 1070014", "from": "quotes@perth.metroll.com.au"}');
  -- The PDFs, read: text layer for c-pdf, d-two, d-wrongpdf, d-ours and d-noname; vision for d-one.
  INSERT INTO public.business_events (id, job_id, event_type, source, entity_type, occurred_at, payload) VALUES
    ('b4100000-0000-4000-8000-0000000000e1', j_hale, 'document.text', 'context_document_text', 'document', '2026-09-08 02:00:00+00',
      '{"text": "R&R FENCING TAX INVOICE\nInvoice No: INV-90002\nYour order: PO-871002\nFencing material"}'),
    ('b4100000-0000-4000-8000-0000000000e2', j_reef, 'document.vision', 'context_document_vision', 'document', '2026-11-02 02:00:00+00',
      '{"text": "Metroll Perth Tax Invoice 1070001\nDeliver to: 45 Ocean Reef Rd, Mullaloo WA 6027\nSpanplus 330"}'),
    ('b4100000-0000-4000-8000-0000000000e3', j_smith, 'document.text', 'context_document_text', 'document', '2026-11-02 02:00:00+00',
      '{"text": "Metroll Perth Tax Invoice 1070002\nDeliver to: 12 Smith Street, Joondalup WA 6027"}'),
    ('b4100000-0000-4000-8000-0000000000e4', j_reef, 'document.text', 'context_document_text', 'document', '2026-11-02 02:00:00+00',
      '{"text": "Metroll Perth statement\nDeliver to: 45 Ocean Reef Rd, Mullaloo"}'),
    ('b4100000-0000-4000-8000-0000000000e5', j_reef, 'document.text', 'context_document_text', 'document', '2026-11-02 02:00:00+00',
      '{"text": "SecureWorks Group Quote 1070004\nMetroll Spanplus 330 roof\nSite: 45 Ocean Reef Road, Mullaloo WA 6027"}'),
    ('b4100000-0000-4000-8000-0000000000e6', j_reef, 'document.text', 'context_document_text', 'document', '2026-11-02 02:00:00+00',
      '{"text": "Tax Invoice 1070005\nDeliver to: 45 Ocean Reef Rd, Mullaloo WA 6027"}'),
    ('b4100000-0000-4000-8000-0000000000e7', j_hale, 'document.text_extracted', 'context-document-vision', 'document', '2026-09-10 02:00:00+00',
      '{"text": "R&R FENCING SUPPLIES\nTAX INVOICE INV-90011\nYOUR ORDER PO-871002"}'),
    ('b4100000-0000-4000-8000-0000000000e8', j_smith, 'document.text_extracted', 'context-document-vision', 'document', '2026-11-02 02:00:00+00',
      '{"text": "METROLL PERTH TAX INVOICE 1070012\nDELIVER TO 12 SMITH ST, JOONDALUP"}'),
    ('b4100000-0000-4000-8000-0000000000e9', j_reef, 'document.text_extracted', 'context-document-text', 'document', '2026-11-02 02:00:00+00',
      '{"text": "Metroll Perth Tax Invoice 1070013\nDeliver to: 45 Ocean Reef Rd, Mullaloo WA 6027"}');
  INSERT INTO public.context_email_attachments (id, provider_message_id, attachment_key, file_name, content_type, sha256, storage_bucket, storage_path, status, business_event_id) VALUES
    ('b4100000-0000-4000-8000-0000000000a1', 'email:b4-871-1', md5('a1') || md5('a1x'), 'INV-90002.pdf', 'application/pdf', md5('s1') || md5('s1x'), 'context-email-attachments', 'b4/INV-90002.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000f1'),
    ('b4100000-0000-4000-8000-0000000000a2', 'email:b4-871-2', md5('a2') || md5('a2x'), '1070001.pdf', 'application/pdf', md5('s2') || md5('s2x'), 'context-email-attachments', 'b4/1070001.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000f2'),
    ('b4100000-0000-4000-8000-0000000000a3', 'email:b4-871-3', md5('a3') || md5('a3x'), 'Invoice 1070002.pdf', 'application/pdf', md5('s3') || md5('s3x'), 'context-email-attachments', 'b4/1070002.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000f3'),
    ('b4100000-0000-4000-8000-0000000000a4', 'email:b4-871-4', md5('a4') || md5('a4x'), '1070003.pdf', 'application/pdf', md5('s4') || md5('s4x'), 'context-email-attachments', 'b4/1070003.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000f4'),
    ('b4100000-0000-4000-8000-0000000000a5', 'email:b4-871-5', md5('a5') || md5('a5x'), 'Quote 1070004.pdf', 'application/pdf', md5('s5') || md5('s5x'), 'context-email-attachments', 'b4/1070004.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000f5'),
    ('b4100000-0000-4000-8000-0000000000a6', 'email:b4-871-6', md5('a6') || md5('a6x'), '1070005.pdf', 'application/pdf', md5('s6') || md5('s6x'), 'context-email-attachments', 'b4/1070005.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000f6'),
    ('b4100000-0000-4000-8000-0000000000a7', 'email:b4-871-7', md5('a7') || md5('a7x'), 'INV-90011.pdf', 'application/pdf', md5('s7') || md5('s7x'), 'context-email-attachments', 'b4/INV-90011.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000f7'),
    ('b4100000-0000-4000-8000-0000000000a8', 'email:b4-871-8', md5('a8') || md5('a8x'), '1070012.pdf', 'application/pdf', md5('s8') || md5('s8x'), 'context-email-attachments', 'b4/1070012.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000f8'),
    ('b4100000-0000-4000-8000-0000000000a9', 'email:b4-871-9', md5('a9') || md5('a9x'), '1070013.pdf', 'application/pdf', md5('s9') || md5('s9x'), 'context-email-attachments', 'b4/1070013.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000f9'),
    ('b4100000-0000-4000-8000-0000000000aa', 'email:b4-871-a', md5('aa') || md5('aax'), '1070014.pdf', 'application/pdf', md5('sa') || md5('sax'), 'context-email-attachments', 'b4/1070014.pdf', 'stored', 'b4100000-0000-4000-8000-0000000000fa');
  INSERT INTO public.context_document_texts (source_kind, source_id, job_id, source_fingerprint, file_kind, outcome, sha256, char_count, event_id, finished_at) VALUES
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a1', j_hale, md5('f1'), 'pdf', 'saved', md5('s1') || md5('s1x'), 80, 'b4100000-0000-4000-8000-0000000000e1', '2026-09-08 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a2', j_reef, md5('f2'), 'pdf', 'no_text_layer', NULL, NULL, NULL, '2026-11-02 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a3', j_smith, md5('f3'), 'pdf', 'saved', md5('s3') || md5('s3x'), 70, 'b4100000-0000-4000-8000-0000000000e3', '2026-11-02 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a4', j_reef, md5('f4'), 'pdf', 'saved', md5('s4') || md5('s4x'), 50, 'b4100000-0000-4000-8000-0000000000e4', '2026-11-02 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a5', j_reef, md5('f5'), 'pdf', 'saved', md5('s5') || md5('s5x'), 90, 'b4100000-0000-4000-8000-0000000000e5', '2026-11-02 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a6', j_reef, md5('f6'), 'pdf', 'saved', md5('s6') || md5('s6x'), 60, 'b4100000-0000-4000-8000-0000000000e6', '2026-11-02 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a7', j_hale, md5('f7'), 'pdf', 'no_text_layer', NULL, NULL, NULL, '2026-09-10 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a8', j_smith, md5('f8'), 'pdf', 'no_text_layer', NULL, NULL, NULL, '2026-11-02 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a9', j_reef, md5('f9'), 'pdf', 'saved', md5('s9') || md5('s9x'), 70, 'b4100000-0000-4000-8000-0000000000e9', '2026-11-02 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000aa', j_reef, md5('fa'), 'pdf', 'no_text_layer', NULL, NULL, NULL, '2026-11-02 02:00:00+00');
  INSERT INTO public.context_document_vision_reads (source_kind, source_id, job_id, source_fingerprint, file_kind, outcome, sha256, char_count, event_id, finished_at) VALUES
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a2', j_reef, md5('f2'), 'pdf', 'saved', md5('s2') || md5('s2x'), 90, 'b4100000-0000-4000-8000-0000000000e2', '2026-11-02 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a7', j_hale, md5('f7'), 'pdf', 'saved', md5('s7') || md5('s7x'), 70, 'b4100000-0000-4000-8000-0000000000e7', '2026-09-10 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000a8', j_smith, md5('f8'), 'pdf', 'saved', md5('s8') || md5('s8x'), 60, 'b4100000-0000-4000-8000-0000000000e8', '2026-11-02 02:00:00+00'),
    ('email_attachment', 'b4100000-0000-4000-8000-0000000000aa', j_reef, md5('fa'), 'pdf', 'no_text', NULL, NULL, NULL, '2026-11-02 02:00:00+00');

  -- 1. A bill matching two orders links to neither: two PO numbers, or a site with two orders (on a PDF's text
  --    layer, in the bill's own lines, or on a scan read by the vision reader).
  IF EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id IN ('c-two', 'd-two', 'd-bill-two', 'd-scan-two') AND linked) THEN
    RAISE EXCEPTION 'a bill matching two orders linked: %',
      (SELECT string_agg(xero_invoice_id || '->' || job_number || ' ' || rule, ', ') FROM public.v_dispatch_order_bills WHERE xero_invoice_id IN ('c-two', 'd-two', 'd-bill-two', 'd-scan-two') AND linked);
  END IF;
  IF (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'c-two' AND not_linked_reason = 'several_order_numbers' AND rule = 'po_number') <> 2
     OR (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'd-two' AND not_linked_reason = 'several_jobs_named' AND rule = 'site_address') <> 2
     OR (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'd-bill-two' AND not_linked_reason = 'several_jobs_named'
           AND rule = 'site_address' AND matched_in = 'bill') <> 2
     OR (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'd-scan-two' AND not_linked_reason = 'several_jobs_named'
           AND rule = 'site_address' AND matched_in = 'supplier_pdf') <> 2 THEN
    RAISE EXCEPTION 'a bill matching two orders was not explained';
  END IF;

  -- 2. (c) our PO number in the bill's own text links the purchase order.
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'c-line';
  IF NOT FOUND OR got.order_id <> po_enid OR NOT got.linked OR got.rule <> 'po_number' OR got.matched_po_number <> 'PO-871001'
     OR got.matched_in <> 'bill' THEN
    RAISE EXCEPTION 'a bill naming PO#871001 did not link to PO-871001 by po_number: %', row_to_json(got);
  END IF;

  -- 3. (c) our PO number on the supplier's PDF links, and says it was found there.
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'c-pdf';
  IF NOT FOUND OR got.order_id <> po_hale OR NOT got.linked OR got.rule <> 'po_number' OR got.matched_in <> 'supplier_pdf' THEN
    RAISE EXCEPTION 'a bill whose PDF names PO-871002 did not link to PO-871002 from the PDF: %', row_to_json(got);
  END IF;

  -- 4. (d) the job's site on the supplier's PDF links its one order of that supplier.
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'd-one';
  IF NOT FOUND OR got.order_id <> o_reef OR NOT got.linked OR got.rule <> 'site_address' OR got.matched_in <> 'supplier_pdf'
     OR got.matched_site_address IS DISTINCT FROM public.context_address_key('45 Ocean Reef Road, Mullaloo WA 6027') THEN
    RAISE EXCEPTION 'a Metroll PDF delivering to 45 Ocean Reef Rd did not link to the Mullaloo order by site_address: %', row_to_json(got);
  END IF;
  IF (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'd-one') <> 1 THEN
    RAISE EXCEPTION 'the Mullaloo bill named more than its one order';
  END IF;

  -- 5. Never: another supplier, a draft PO, the digits alone, the same amount alone, a PDF that is not the bill's,
  --    a PDF we sent, a PDF that does not name the supplier, a PDF a customer forwarded, a scan with no text.
  SELECT count(*) INTO n FROM public.v_dispatch_order_bills
   WHERE xero_invoice_id IN ('c-other', 'c-draft', 'c-digits', 'd-wrongpdf', 'd-ours', 'd-noname', 'd-forward', 'd-scan-none');
  IF n <> 0 THEN
    RAISE EXCEPTION 'a bill linked or named an order it must not: %',
      (SELECT string_agg(xero_invoice_id || '->' || job_number || ' ' || rule, ', ') FROM public.v_dispatch_order_bills
        WHERE xero_invoice_id IN ('c-other', 'c-draft', 'c-digits', 'd-wrongpdf', 'd-ours', 'd-noname', 'd-forward', 'd-scan-none'));
  END IF;

  -- 6. Our PO number for one job and another job's number: nothing links, and each row says why.
  IF EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'c-disagree' AND linked)
     OR NOT EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'c-disagree' AND order_id = po_enid AND not_linked_reason = 'job_disagrees')
     OR NOT EXISTS (SELECT 1 FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'c-disagree' AND order_id = po_hale AND not_linked_reason = 'other_order_ref') THEN
    RAISE EXCEPTION 'a bill naming PO-871001 and SWF-871500 linked or was not explained';
  END IF;

  -- 7. (d) the job's site in the bill's own lines links its one order of that supplier, found on the bill.
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'd-bill';
  IF NOT FOUND OR got.order_id <> po_enid OR NOT got.linked OR got.rule <> 'site_address' OR got.matched_in <> 'bill'
     OR got.matched_site_address IS DISTINCT FROM public.context_address_key('18 Enid Rd, Kalamunda WA 6076') THEN
    RAISE EXCEPTION 'an R&R bill going to 18 Enid Rd did not link to the Kalamunda PO by site_address: %', row_to_json(got);
  END IF;
  IF (SELECT count(*) FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'd-bill') <> 1 THEN
    RAISE EXCEPTION 'the Kalamunda bill named more than its one order';
  END IF;

  -- 8. (c) our PO number on a scan, from the vision reader's text, links and says it was found on the PDF.
  SELECT * INTO got FROM public.v_dispatch_order_bills WHERE xero_invoice_id = 'c-scan';
  IF NOT FOUND OR got.order_id <> po_hale OR NOT got.linked OR got.rule <> 'po_number' OR got.matched_in <> 'supplier_pdf' THEN
    RAISE EXCEPTION 'a scanned R&R PDF naming PO-871002 did not link to PO-871002: %', row_to_json(got);
  END IF;

  -- Only the service role reads the view.
  IF has_table_privilege('anon', 'public.v_dispatch_order_bills', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_dispatch_order_bills', 'SELECT') THEN
    RAISE EXCEPTION 'v_dispatch_order_bills is not service role only';
  END IF;
END $$;
ROLLBACK;
