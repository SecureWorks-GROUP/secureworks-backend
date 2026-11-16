-- Contract for 20261116080000_context_job_evidence_for_bills: the shared bill evidence read names a
-- job only on strong evidence, never a holding job, never on a tie, and never for a draft bill.
-- The mail lane counts the supplier's own mail only when it carries this bill's number and no other
-- of the supplier's bills, and never a statement.

-- 1. The number helpers.
DO $c$
BEGIN
 IF public.context_job_evidence_number_key('INV-0012345') IS DISTINCT FROM '12345' THEN
  RAISE EXCEPTION 'job evidence: leading zeros must not count (%)', public.context_job_evidence_number_key('INV-0012345');
 END IF;
 IF public.context_job_evidence_number_key('2026-123456/2') IS DISTINCT FROM '123456-2' THEN
  RAISE EXCEPTION 'job evidence: a year is dropped and a suffix kept (%)', public.context_job_evidence_number_key('2026-123456/2');
 END IF;
 IF public.context_job_evidence_number_key('INV-1234') IS NOT NULL THEN
  RAISE EXCEPTION 'job evidence: a number under five digits is too short';
 END IF;
 IF NOT public.context_job_evidence_is_statement('Statement of account for October')
    OR public.context_job_evidence_is_statement('Tax invoice 123456') THEN
  RAISE EXCEPTION 'job evidence: statement words misread';
 END IF;
 IF has_function_privilege('anon', 'public.context_job_evidence_for_bills(text[],boolean)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_job_evidence_for_bills(text[],boolean)', 'EXECUTE') THEN
  RAISE EXCEPTION 'job evidence: the read must be the service role''s only';
 END IF;
END $c$;

-- 2. The read, on rolled-back fixtures (triggers off so no ladder moves a fixture row).
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO public.jobs (id, org_id, status, type, job_number, site_address, site_suburb, metadata) VALUES
 ('e1000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-990001', '12 Fixture Street', 'Testville', '{}'),
 ('e1000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-990002', '40 Other Road', 'Elsewhere', '{}'),
 ('e1000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'SWF-HOLD99', NULL, NULL, '{"do_not_schedule":"true"}');

INSERT INTO public.suppliers (id, name, email, xero_contact_id) VALUES
 ('e2000000-0000-4000-8000-000000000001', 'Fixture Steel', 'orders@fixturesteel.example', 'xc-fixture-steel');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, xero_contact_id, contact_name, invoice_date, reference, line_items) VALUES
 ('00000000-0000-0000-0000-000000000001', 'ev-job', 'FS-100001', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', 'SWF-990001', '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-tie', 'FS-100006', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', 'SWF-990001 SWF-990002', '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-hold', 'FS-100007', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', 'SWF-HOLD99', '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-draft', 'FS-100008', 'ACCPAY', 'DRAFT', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', 'SWF-990001', '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-mail', 'FS-100002', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', NULL, '[{"Description":"Steel posts"}]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-sib', 'FS-100003', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', NULL, '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-att', 'FS-100004', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', NULL, '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-stmt', 'FS-100005', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', NULL, '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-sales', 'INV-100009', 'ACCREC', 'AUTHORISED', NULL, 'A customer', '2026-10-01', 'SWF-990001', '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-our-inv', 'INV-555555', 'ACCREC', 'AUTHORISED', NULL, 'A customer', '2026-09-01', NULL, '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-quotes-inv', 'FS-100011', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', 'INV-555555', '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-sfx', '777777', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', NULL, '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-sfx1', '777777-1', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', NULL, '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-xref', 'FS-100012', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', NULL, '[{"Description":"Item 238780 steel posts"}]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-ref', 'FS-100013', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', 'Order 238781', '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-conf', 'FS-100014', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', 'SWF-990001', '[{"Description":"Delivered to 40 Other Road Elsewhere"}]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-po', 'FS-100015', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', 'PO-1000001', '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-po-digits', 'FS-100016', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', '4455667', '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-site', 'FS-100017', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', NULL, '[{"Description":"Deliver to 12 Fixture Street Testville"}]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-thread', 'FS-100010', 'ACCPAY', 'AUTHORISED', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', NULL, '[]'),
 ('00000000-0000-0000-0000-000000000001', 'ev-nostatus', 'FS-100018', 'ACCPAY', '', 'xc-fixture-steel', 'Fixture Steel', '2026-10-01', 'SWF-990001', '[]');
UPDATE public.xero_invoices SET job_id = 'e1000000-0000-4000-8000-00000000000a' WHERE xero_invoice_id = 'ev-our-inv';

INSERT INTO public.purchase_orders (job_id, po_number, supplier_name) VALUES
 ('e1000000-0000-4000-8000-00000000000b', 'PO-1000001', 'Fixture Steel'),
 ('e1000000-0000-4000-8000-00000000000a', '4455667', 'Another Supplier');

INSERT INTO public.dispatch_v2_supplier_order_refs (org_id, job_id, ref, linked_via, supplier_key, supplier_name) VALUES
 ('00000000-0000-0000-0000-000000000001', 'e1000000-0000-4000-8000-00000000000b', '238780', 'certain_match', 'anothersupplier', 'Another Supplier'),
 ('00000000-0000-0000-0000-000000000001', 'e1000000-0000-4000-8000-00000000000b', '238781', 'certain_match', 'fixturesteel', 'Fixture Steel');

INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, payload, occurred_at, match_method) VALUES
 -- This bill's number alone, placed on job B: evidence for ev-mail.
 ('e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000b', 'supplier.email_in', 'outlook', 'email', 'inbound',
  '{"email":"orders@fixturesteel.example","subject":"Invoice FS-100002","body":"Please find our invoice attached."}', '2026-10-02T02:00:00Z', 'ladder_ref'),
 -- Two of the supplier's bills, placed on job A: no evidence for either.
 ('e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-00000000000a', 'supplier.email_in', 'outlook', 'email', 'inbound',
  '{"email":"orders@fixturesteel.example","subject":"Invoices FS-100002 and FS-100003","body":"Both attached."}', '2026-10-02T03:00:00Z', 'ladder_ref'),
 -- No number in the body; one attachment carries ev-att's number (its text on job A), one carries a sibling bill.
 ('e3000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-00000000000a', 'supplier.email_in', 'outlook', 'email', 'inbound',
  '{"email":"orders@fixturesteel.example","subject":"Invoices","body":"Attached."}', '2026-10-02T04:00:00Z', 'ladder_ref'),
 ('e3000000-0000-4000-8000-0000000000d1', 'e1000000-0000-4000-8000-00000000000a', 'document.text_extracted', 'context-document-text', 'document', 'inbound',
  '{"text":"Tax invoice FS-100004 for steel"}', '2026-10-02T04:01:00Z', NULL),
 ('e3000000-0000-4000-8000-0000000000d2', 'e1000000-0000-4000-8000-00000000000a', 'document.text_extracted', 'context-document-text', 'document', 'inbound',
  '{"text":"Tax invoice FS-100003 for steel"}', '2026-10-02T04:01:00Z', NULL),
 -- A statement naming ev-stmt's number: never evidence.
 ('e3000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-00000000000b', 'supplier.email_in', 'outlook', 'email', 'inbound',
  '{"email":"orders@fixturesteel.example","subject":"Statement of account","body":"FS-100005 is outstanding."}', '2026-10-02T05:00:00Z', 'ladder_ref'),
 -- Sibling suffix: 777777-1 is another bill; a mail carrying it alone is no evidence for 777777.
 ('e3000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-00000000000b', 'supplier.email_in', 'outlook', 'email', 'inbound',
  '{"email":"orders@fixturesteel.example","subject":"Invoice 777777-1","body":"Attached."}', '2026-10-02T06:00:00Z', 'ladder_ref'),
 -- This bill's number alone, but the mail sits on job A only by its thread: no evidence.
 ('e3000000-0000-4000-8000-000000000006', 'e1000000-0000-4000-8000-00000000000a', 'supplier.email_in', 'outlook', 'email', 'inbound',
  '{"email":"orders@fixturesteel.example","subject":"Invoice FS-100010","body":"Attached."}', '2026-10-02T07:00:00Z', 'contact_id');

INSERT INTO public.context_email_attachments (id, provider_message_id, attachment_key, business_event_id, status) VALUES
 ('e4000000-0000-4000-8000-000000000001', 'email:fixture-3', repeat('a', 64), 'e3000000-0000-4000-8000-000000000003', 'skipped_kind'),
 ('e4000000-0000-4000-8000-000000000002', 'email:fixture-3', repeat('b', 64), 'e3000000-0000-4000-8000-000000000003', 'skipped_kind');

INSERT INTO public.context_document_texts (source_kind, source_id, job_id, source_fingerprint, file_kind, outcome, sha256, event_id, finished_at) VALUES
 ('email_attachment', 'e4000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a', repeat('1', 32), 'pdf', 'saved', repeat('c', 64), 'e3000000-0000-4000-8000-0000000000d1', now()),
 ('email_attachment', 'e4000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-00000000000a', repeat('2', 32), 'pdf', 'saved', repeat('d', 64), 'e3000000-0000-4000-8000-0000000000d2', now());

SET LOCAL session_replication_role = origin;

CREATE TEMP TABLE ev_result ON COMMIT DROP AS
 SELECT * FROM public.context_job_evidence_for_bills(
  ARRAY['ev-job','ev-tie','ev-hold','ev-draft','ev-mail','ev-att','ev-stmt','ev-sales','ev-missing',
        'ev-quotes-inv','ev-sfx','ev-xref','ev-ref','ev-conf','ev-po','ev-po-digits','ev-site','ev-thread','ev-nostatus']);
CREATE TEMP TABLE ev_blind ON COMMIT DROP AS
 SELECT * FROM public.context_job_evidence_for_bills(ARRAY['ev-job'], true);

DO $c$
DECLARE r record;
BEGIN
 IF EXISTS (SELECT 1 FROM ev_result WHERE job_id = 'e1000000-0000-4000-8000-00000000000c'
            OR strong::text LIKE '%e1000000-0000-4000-8000-00000000000c%') THEN
  RAISE EXCEPTION 'job evidence: a holding job was named';
 END IF;
 IF (SELECT count(*) FROM ev_result) <> 19 THEN
  RAISE EXCEPTION 'job evidence: one row per bill asked, got %', (SELECT count(*) FROM ev_result);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-job';
 IF r.decision IS DISTINCT FROM 'named' OR r.job_number IS DISTINCT FROM 'SWF-990001' OR r.strong::text NOT LIKE '%"lane": "job_number"%' THEN
  RAISE EXCEPTION 'job evidence: the job number on a bill names its job (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-tie';
 IF r.decision <> 'not_named' OR r.reason <> 'strong_evidence_conflict' OR jsonb_array_length(r.strong) <> 2 THEN
  RAISE EXCEPTION 'job evidence: two jobs with equal evidence are listed, never named (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-hold';
 IF r.decision <> 'not_named' OR r.reason <> 'no_strong_evidence' THEN
  RAISE EXCEPTION 'job evidence: a holding job was named (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-draft';
 IF r.decision <> 'not_named' OR r.reason <> 'bill_draft' OR r.job_id IS NOT NULL THEN
  RAISE EXCEPTION 'job evidence: a draft bill is never named (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-mail';
 IF r.decision <> 'named' OR r.job_number <> 'SWF-990002' THEN
  RAISE EXCEPTION 'job evidence: the supplier''s mail carrying this bill alone names its job (%)', row_to_json(r);
 END IF;
 IF r.strong::text LIKE '%e1000000-0000-4000-8000-00000000000a%' THEN
  RAISE EXCEPTION 'job evidence: a mail carrying two bills must not be evidence (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-att';
 IF r.decision <> 'named' OR r.job_number <> 'SWF-990001' THEN
  RAISE EXCEPTION 'job evidence: an attachment carrying this bill counts on its own job (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-stmt';
 IF r.decision <> 'not_named' OR r.strong <> '[]'::jsonb THEN
  RAISE EXCEPTION 'job evidence: a statement is never evidence (%)', row_to_json(r);
 END IF;
 IF r.weak = '[]'::jsonb THEN
  RAISE EXCEPTION 'job evidence: the supplier''s mail on a job is still listed as weak evidence (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-sales';
 IF r.decision <> 'not_found' OR r.reason <> 'not_a_supplier_bill' THEN
  RAISE EXCEPTION 'job evidence: a sales invoice is not a supplier bill (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-missing';
 IF r.decision <> 'not_found' THEN
  RAISE EXCEPTION 'job evidence: an unknown bill is not found (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-quotes-inv';
 IF r.decision <> 'not_named' OR r.strong <> '[]'::jsonb THEN
  RAISE EXCEPTION 'job evidence: our own sales invoice number on a supplier bill is no evidence (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-sfx';
 IF r.decision <> 'not_named' THEN
  RAISE EXCEPTION 'job evidence: a sibling bill''s suffixed number is not this bill''s (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-xref';
 IF r.decision <> 'not_named' OR r.strong <> '[]'::jsonb THEN
  RAISE EXCEPTION 'job evidence: another supplier''s order reference is no evidence (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-ref';
 IF r.decision IS DISTINCT FROM 'named' OR r.job_number IS DISTINCT FROM 'SWF-990002' OR r.strong::text NOT LIKE '%dispatch_order_ref%' THEN
  RAISE EXCEPTION 'job evidence: this supplier''s own order reference names its job (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-conf';
 IF r.decision <> 'not_named' OR r.reason <> 'strong_evidence_conflict' THEN
  RAISE EXCEPTION 'job evidence: strong evidence for two jobs is a conflict, never a name (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-po';
 IF r.decision IS DISTINCT FROM 'named' OR r.job_number IS DISTINCT FROM 'SWF-990002' OR r.strong::text NOT LIKE '%purchase_order%'
    OR r.strong::text LIKE '%"lane": "job_number"%' THEN
  RAISE EXCEPTION 'job evidence: our purchase order names its job, once (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-po-digits';
 IF r.decision <> 'not_named' OR r.strong <> '[]'::jsonb THEN
  RAISE EXCEPTION 'job evidence: a digits-only order number to another supplier is no evidence (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-site';
 IF r.decision IS DISTINCT FROM 'named' OR r.job_number IS DISTINCT FROM 'SWF-990001' OR r.strong::text NOT LIKE '%site_address%' THEN
  RAISE EXCEPTION 'job evidence: a site address with its suburb names its job (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-thread';
 IF r.decision <> 'not_named' OR r.strong <> '[]'::jsonb THEN
  RAISE EXCEPTION 'job evidence: a mail placed only by its thread is no evidence (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_result WHERE xero_invoice_id = 'ev-nostatus';
 IF r.decision <> 'not_named' OR r.reason <> 'bill_status_unknown' THEN
  RAISE EXCEPTION 'job evidence: a bill with no status is never named (%)', row_to_json(r);
 END IF;
 SELECT * INTO r FROM ev_blind;
 IF r.decision <> 'not_named' OR NOT (r.notes ? 'blind') THEN
  RAISE EXCEPTION 'job evidence: blind mode leaves out the bill''s own words (%)', row_to_json(r);
 END IF;
 IF EXISTS (SELECT 1 FROM ev_result WHERE policy IS DISTINCT FROM 'job-evidence-v1') THEN
  RAISE EXCEPTION 'job evidence: every row names its policy';
 END IF;
END $c$;
ROLLBACK;
