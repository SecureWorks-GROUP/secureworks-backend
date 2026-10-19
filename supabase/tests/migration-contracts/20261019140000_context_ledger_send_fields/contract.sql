-- Contract for 20261019140000_context_ledger_send_fields.
-- The packet contract reapplies 20261018120000 after its own checks, which
-- puts the record-link function back. Reapply this migration only while that
-- preimage is live, so a break proof that keeps the comment is not undone.
-- Shape checks still pass when the link function is an empty stand-in.

SELECT (md5(p.prosrc) = '5a42fd730f88c3ac302d4a72605b5439') AS lsf_reapply
FROM pg_proc p
WHERE p.oid = to_regprocedure('public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)');
\gset
\if :lsf_reapply
\ir ../../../migrations/20261019140000_context_ledger_send_fields.sql
\endif

DO $shape$
DECLARE
 f text;
 live text;
 note text;
 money jsonb;
 n int := 0;
BEGIN
 FOREACH f IN ARRAY ARRAY[
  'public.context_ledger_record_email(text)',
  'public.context_ledger_record_contact(text)',
  'public.context_ledger_record_xero_date(text)',
  'public.context_ledger_record_invoice_money(text,text,text,numeric,numeric,numeric,jsonb)'] LOOP
  IF to_regprocedure(f) IS NULL THEN
   RAISE EXCEPTION 'ledger send fields shape: % missing', f;
  END IF;
  IF coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE 'Send recipient fields (20261019140000)%' THEN
   RAISE EXCEPTION 'ledger send fields shape: % comment', f;
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE')
   OR has_function_privilege('anon', f, 'EXECUTE')
   OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'ledger send fields shape: % privileges', f;
  END IF;
  n := n + 3;
 END LOOP;
 note := coalesce(obj_description(to_regprocedure('public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)'), 'pg_proc'), '');
 IF note NOT LIKE 'Ledger packet records (20261018120000)%'
  OR note NOT LIKE '%Send recipient fields (20261019140000)%' THEN
  RAISE EXCEPTION 'ledger send fields shape: record links comment';
 END IF;
 IF (SELECT p.proconfig FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)'))::text
    NOT LIKE '%search_path%public%pg_temp%'
  OR NOT (SELECT p.prosecdef FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)')) THEN
  RAISE EXCEPTION 'ledger send fields shape: record links definer';
 END IF;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)');
 IF live IS DISTINCT FROM '4d99c79138a3b9de41b2957145addeb2' THEN
  RAISE EXCEPTION 'ledger send fields shape: packet md5 %', live;
 END IF;
 IF public.context_ledger_record_email('client') IS NOT NULL
  OR public.context_ledger_record_email('client@example.test') IS DISTINCT FROM 'client@example.test'
  OR public.context_ledger_record_email('  Client@Example.Test  ') IS DISTINCT FROM 'Client@Example.Test' THEN
  RAISE EXCEPTION 'ledger send fields shape: email helper';
 END IF;
 IF public.context_ledger_record_contact('ghl-1') IS DISTINCT FROM 'ghl-1'
  OR public.context_ledger_record_contact('a@b.c') IS NOT NULL THEN
  RAISE EXCEPTION 'ledger send fields shape: contact helper';
 END IF;
 IF public.context_ledger_record_invoice_money(NULL, NULL, NULL, NULL, NULL, NULL, NULL) IS DISTINCT FROM '{}'::jsonb THEN
  RAISE EXCEPTION 'ledger send fields shape: empty money';
 END IF;
 money := public.context_ledger_record_invoice_money(NULL, NULL, NULL, NULL, NULL, 0, NULL);
 IF money->>'owing' IS DISTINCT FROM '0.00' OR (money ? 'amount_due') OR (money ? 'paid') THEN
  RAISE EXCEPTION 'ledger send fields shape: owing zero %', money;
 END IF;
 n := n + 8;
 RAISE NOTICE 'ledger send fields shape checks: %', n;
END $shape$;

BEGIN;
SET LOCAL session_replication_role = replica;
-- The contract fixture's email_events is built by earlier setups and has no
-- sender column. Production sender is still text not null; writers set it.
ALTER TABLE public.email_events ADD COLUMN IF NOT EXISTS sender text;

CREATE FUNCTION pg_temp.lsf_assert(p_ok boolean, p_why text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger send fields contract: %', p_why; END IF;
END $$;

CREATE FUNCTION pg_temp.lsf_ev(p_id uuid, p_payload jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id,
  payload, metadata, occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step,
  attribution_confidence, attributed_at, match_method)
 VALUES (p_id, '19f00000-0000-4000-8000-000000000001', 'client.sms_in', 'ledger_contract', 'sms', 'inbound', 'lsf-ct',
  'lsf:' || p_id::text,
  jsonb_build_object('body', 'Please send the paperwork.') || coalesce(p_payload, '{}'::jsonb),
  '{"written_as":"service_role"}',
  '2026-10-01 00:01Z', '2026-10-01 00:01Z', '2026-10-01 00:01Z', '2026-10-01 00:01Z', 'direct', 1, 1,
  '2026-10-01 00:01Z', 'direct_job_id');
END $$;

CREATE FUNCTION pg_temp.lsf_one(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT l.records->0
 FROM public.context_ledger_evidence_record_links(
  '19f00000-0000-4000-8000-000000000001', '2026-10-18 00:00Z',
  jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', p_id::text))) l
$$;

INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
VALUES ('19f00000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'scheduled', 'fencing', 'SWF-LSF19F1',
 'Robin Ledger', 'client@example.test', 'ghl-customer-1', 'Testville', '{}', '2026-09-01 00:00Z');

INSERT INTO public.email_events (id, job_id, email_type, recipient, sender, subject, status, sent_at, created_at, metadata) VALUES
 ('19f00000-0000-4000-8000-000000000401', '19f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"quote_number":"Q-19","contact_id":"ghl-customer-1"}'),
 ('19f00000-0000-4000-8000-000000000402', '19f00000-0000-4000-8000-000000000001', 'quote', 'client',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-19"}'),
 ('19f00000-0000-4000-8000-000000000403', '19f00000-0000-4000-8000-000000000001', 'quote', '19f00000-0000-4000-8000-000000000099',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-19"}'),
 ('19f00000-0000-4000-8000-000000000404', '19f00000-0000-4000-8000-000000000001', 'quote', '0400000000',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-19"}'),
 ('19f00000-0000-4000-8000-000000000405', '19f00000-0000-4000-8000-000000000001', 'quote', 'a@b.test, c@d.test',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-19"}'),
 ('19f00000-0000-4000-8000-000000000406', '19f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"quote_number":"Q-19","several_recipients":true,"contact_id":"ghl-customer-1"}'),
 ('19f00000-0000-4000-8000-000000000407', '19f00000-0000-4000-8000-000000000001', 'quote', 'Client@Example.Test',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-19"}');

INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at) VALUES
 ('19f00000-0000-4000-8000-000000000501', '19f00000-0000-4000-8000-000000000001', 'invoice.emailed',
  '{"to":"client@example.test","contact_id":"ghl-customer-1","invoice_number":"INV-19"}', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000502', '19f00000-0000-4000-8000-000000000001', 'quote_sent',
  '{"to":"client@example.test","sent_to":"client@example.test","contact_id":"ghl-customer-1","quote_number":"Q-19"}', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000503', '19f00000-0000-4000-8000-000000000001', 'invoice.emailed',
  '{"to":"client","invoice_number":"INV-19"}', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000511', '19f00000-0000-4000-8000-000000000001', 'quote_sent',
  '{"document_id":"19f00000-0000-4000-8000-000000000311","sent_to":"client@example.test","to":"other@example.test"}', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000512', '19f00000-0000-4000-8000-000000000001', 'invoice.emailed',
  '{"document_id":"19f00000-0000-4000-8000-000000000312","to":"client@example.test"}', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000516', '19f00000-0000-4000-8000-000000000001', 'quote_sent',
  '{"document_id":"19f00000-0000-4000-8000-000000000316","to":"other@example.test","sent_to":"client@example.test"}', '2026-10-01 00:00Z');

INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at) VALUES
 ('19f00000-0000-4000-8000-000000000311', '19f00000-0000-4000-8000-000000000001', 'quote', 'Q-19', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000312', '19f00000-0000-4000-8000-000000000001', 'quote', 'INV-19', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000313', '19f00000-0000-4000-8000-000000000001', 'quote', 'Q-191', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000314', '19f00000-0000-4000-8000-000000000001', 'quote', 'Q-192', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000315', '19f00000-0000-4000-8000-000000000001', 'quote', 'Q-193', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000316', '19f00000-0000-4000-8000-000000000001', 'quote', 'Q-194', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
 ('19f00000-0000-4000-8000-000000000317', '19f00000-0000-4000-8000-000000000001', 'quote', 'Q-195', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z');

INSERT INTO public.email_events (id, job_id, email_type, recipient, sender, subject, status, sent_at, created_at, metadata) VALUES
 ('19f00000-0000-4000-8000-000000000411', '19f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test',
  'orders@secureworks.test', 'Your paperwork', 'delivered', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"document_id":"19f00000-0000-4000-8000-000000000311"}'),
 ('19f00000-0000-4000-8000-000000000413', '19f00000-0000-4000-8000-000000000001', 'quote', 'a@example.test',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"document_id":"19f00000-0000-4000-8000-000000000313"}'),
 ('19f00000-0000-4000-8000-000000000414', '19f00000-0000-4000-8000-000000000001', 'quote', 'b@example.test',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"document_id":"19f00000-0000-4000-8000-000000000313"}'),
 ('19f00000-0000-4000-8000-000000000415', '19f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test',
  'orders@secureworks.test', 'Your paperwork', 'bounced', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"document_id":"19f00000-0000-4000-8000-000000000314"}'),
 ('19f00000-0000-4000-8000-000000000416', '19f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test',
  'orders@secureworks.test', 'Your paperwork', 'bounced', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"document_id":"19f00000-0000-4000-8000-000000000315"}'),
 ('19f00000-0000-4000-8000-000000000417', '19f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test',
  'orders@secureworks.test', 'Your paperwork', 'failed', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"document_id":"19f00000-0000-4000-8000-000000000315"}'),
 ('19f00000-0000-4000-8000-000000000418', '19f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test',
  'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"document_id":"19f00000-0000-4000-8000-000000000317","several_recipients":true}');

INSERT INTO public.xero_invoices (id, org_id, job_id, xero_invoice_id, contact_name, invoice_number, invoice_type, status,
 total, fully_paid_on, created_at, line_items) VALUES
 ('19f00000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-0000000000aa', '19f00000-0000-4000-8000-000000000001',
  'xero-lsf-201', 'Payer Bare', 'INV-19', 'ACCREC', 'PAID', 165, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('19f00000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000aa', '19f00000-0000-4000-8000-000000000001',
  'xero-lsf-bill-101', 'Bare Metals', NULL, 'ACCPAY', 'PAID', 90, '2026-10-01', '2026-10-01 00:00Z', '[]');

INSERT INTO public.xero_invoices (id, org_id, job_id, xero_invoice_id, contact_name, invoice_number, invoice_type, status,
 total, amount_paid, amount_due, fully_paid_on, created_at, line_items, raw_json) VALUES
 ('19f00000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-0000000000aa', '19f00000-0000-4000-8000-000000000001',
  'xero-lsf-202', 'Acme Supplies', 'INV-202', 'ACCREC', 'PAID', 165, 40.00, 0, '2026-10-02', '2026-10-01 00:00Z', '[]',
  '{"Payments":[{"Date":"2026-10-02T00:00:00","Amount":40.00},{"Date":"/Date(1727740800000)/","Amount":0},{"Date":"not-a-date","Amount":"nope"}],"CreditNotes":[{"CreditNoteNumber":"CN-9","Date":"2026-10-03","AppliedAmount":5.50}],"Overpayments":[{"CreditNoteNumber":"OP-1","Date":"2026-10-04","AppliedAmount":1.00}],"Prepayments":[{"Date":"2026-10-05","Amount":2.00}]}'),
 ('19f00000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-0000000000aa', '19f00000-0000-4000-8000-000000000001',
  'xero-lsf-203', 'Row Payer', 'INV-203', 'ACCREC', 'PAID', 15, NULL, NULL, '2026-10-02', '2026-10-01 00:00Z', '[]',
  '{"Payments":[{"Date":"2026-10-02","Amount":15.00}]}'),
 ('19f00000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-0000000000aa', '19f00000-0000-4000-8000-000000000001',
  'xero-lsf-bill-102', 'Priced Metals', 'BILL-102', 'ACCPAY', 'PAID', 12.50, 12.50, 0, '2026-10-01', '2026-10-01 00:00Z', '[]', '{}'),
 ('19f00000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-0000000000aa', '19f00000-0000-4000-8000-000000000001',
  'xero-lsf-204', 'Still Owing', 'INV-204', 'ACCREC', 'AUTHORISED', 165, 0, 165, NULL, '2026-10-01 00:00Z', '[]', '{}');

SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000401', '{"email_event_id":"19f00000-0000-4000-8000-000000000401"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000402', '{"email_event_id":"19f00000-0000-4000-8000-000000000402"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000403', '{"email_event_id":"19f00000-0000-4000-8000-000000000403"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000404', '{"email_event_id":"19f00000-0000-4000-8000-000000000404"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000405', '{"email_event_id":"19f00000-0000-4000-8000-000000000405"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000406', '{"email_event_id":"19f00000-0000-4000-8000-000000000406"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000407', '{"email_event_id":"19f00000-0000-4000-8000-000000000407"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000501', '{"job_event_id":"19f00000-0000-4000-8000-000000000501"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000502', '{"job_event_id":"19f00000-0000-4000-8000-000000000502"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000503', '{"job_event_id":"19f00000-0000-4000-8000-000000000503"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000201', '{"xero_invoice_id":"19f00000-0000-4000-8000-000000000201"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000202', '{"xero_invoice_id":"xero-lsf-202"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000203', '{"xero_invoice_id":"xero-lsf-203"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000101', '{"xero_invoice_id":"19f00000-0000-4000-8000-000000000101"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000102', '{"xero_invoice_id":"xero-lsf-bill-102"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000204', '{"xero_invoice_id":"xero-lsf-204"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000311', '{"document_id":"19f00000-0000-4000-8000-000000000311"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000312', '{"document_id":"19f00000-0000-4000-8000-000000000312"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000313', '{"document_id":"19f00000-0000-4000-8000-000000000313"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000314', '{"document_id":"19f00000-0000-4000-8000-000000000314"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000315', '{"document_id":"19f00000-0000-4000-8000-000000000315"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000316', '{"document_id":"19f00000-0000-4000-8000-000000000316"}');
SELECT pg_temp.lsf_ev('19f10000-0000-4000-8000-000000000317', '{"document_id":"19f00000-0000-4000-8000-000000000317"}');

DO $proof$
DECLARE got jsonb; bare jsonb;
BEGIN
 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000401');
 PERFORM pg_temp.lsf_assert(got = jsonb_build_object(
  'kind','system_email','table','email_events','id','19f00000-0000-4000-8000-000000000401',
  'job_id','19f00000-0000-4000-8000-000000000001','email_type','quote','status','sent',
  'about','quote:q-19','system', true, 'recipient','client@example.test','contact_id','ghl-customer-1'),
  'email recipient ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000402');
 PERFORM pg_temp.lsf_assert(got->>'kind' = 'system_email' AND NOT (got ? 'recipient') AND NOT (got ? 'to_address') AND NOT (got ? 'contact_id'),
  'word client ' || coalesce(got::text, '<none>'));
 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000403');
 PERFORM pg_temp.lsf_assert(got->>'kind' = 'system_email' AND NOT (got ? 'recipient') AND NOT (got ? 'to_address'),
  'uuid recipient ' || coalesce(got::text, '<none>'));
 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000404');
 PERFORM pg_temp.lsf_assert(got->>'kind' = 'system_email' AND NOT (got ? 'recipient') AND NOT (got ? 'to_address'),
  'phone recipient ' || coalesce(got::text, '<none>'));
 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000405');
 PERFORM pg_temp.lsf_assert(got->>'kind' = 'system_email' AND NOT (got ? 'recipient') AND NOT (got ? 'to_address'),
  'several addresses ' || coalesce(got::text, '<none>'));
 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000406');
 PERFORM pg_temp.lsf_assert(got->>'kind' = 'system_email' AND NOT (got ? 'recipient') AND NOT (got ? 'to_address') AND NOT (got ? 'contact_id'),
  'several recipients flag ' || coalesce(got::text, '<none>'));
 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000407');
 PERFORM pg_temp.lsf_assert(got->>'recipient' = 'Client@Example.Test' AND NOT (got ? 'to_address') AND NOT (got ? 'contact_id'),
  'stored case ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000501');
 PERFORM pg_temp.lsf_assert(got = jsonb_build_object(
  'kind','job_event','table','job_events','id','19f00000-0000-4000-8000-000000000501',
  'job_id','19f00000-0000-4000-8000-000000000001','event_type','invoice.emailed','about','invoice:inv-19',
  'to','client@example.test','contact_id','ghl-customer-1')
  AND NOT (got ? 'to_address') AND NOT (got ? 'paid') AND NOT (got ? 'amount'),
  'invoice emailed ' || coalesce(got::text, '<none>'));
 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000502');
 PERFORM pg_temp.lsf_assert(got->>'kind' = 'job_event' AND got->>'about' = 'quote:q-19' AND NOT (got ? 'to')
  AND NOT (got ? 'to_address') AND NOT (got ? 'recipient') AND NOT (got ? 'contact_id'),
  'quote sent keeps its to ' || coalesce(got::text, '<none>'));
 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000503');
 PERFORM pg_temp.lsf_assert(got->>'event_type' = 'invoice.emailed' AND NOT (got ? 'to') AND NOT (got ? 'to_address'),
  'invoice emailed word ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000201');
 PERFORM pg_temp.lsf_assert(got = jsonb_build_object(
  'kind','paid_invoice','table','xero_invoices','id','19f00000-0000-4000-8000-000000000201',
  'job_id','19f00000-0000-4000-8000-000000000001','number','invoice:inv-19',
  'invoice_number','INV-19','xero_id','xero-lsf-201','supplier','Payer Bare','total','165.00')
  AND NOT (got ? 'paid') AND NOT (got ? 'owing') AND NOT (got ? 'payments') AND NOT (got ? 'credits'),
  'bare paid invoice ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000202');
 PERFORM pg_temp.lsf_assert(got = jsonb_build_object(
  'kind','paid_invoice','table','xero_invoices','id','19f00000-0000-4000-8000-000000000202',
  'job_id','19f00000-0000-4000-8000-000000000001','number','invoice:inv-202',
  'invoice_number','INV-202','xero_id','xero-lsf-202','supplier','Acme Supplies',
  'total','165.00','paid','40.00','owing','0.00',
  'payments', jsonb_build_array(jsonb_build_object('date','2026-10-02','amount','40.00')),
  'credits', jsonb_build_array(
    jsonb_build_object('kind','credit_note','number','CN-9','date','2026-10-03','amount','5.50'),
    jsonb_build_object('kind','overpayment','number','OP-1','date','2026-10-04','amount','1.00'),
    jsonb_build_object('kind','prepayment','date','2026-10-05','amount','2.00')))
  AND NOT (got ? 'amount_due') AND NOT (got ? 'amount_paid'),
  'paid invoice money ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000203');
 PERFORM pg_temp.lsf_assert(got->>'paid' = '15.00' AND NOT (got ? 'owing')
  AND got->'payments' = jsonb_build_array(jsonb_build_object('date','2026-10-02','amount','15.00')),
  'paid from payment rows ' || coalesce(got::text, '<none>'));

 bare := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000101');
 PERFORM pg_temp.lsf_assert(bare = jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','19f00000-0000-4000-8000-000000000101',
  'job_id','19f00000-0000-4000-8000-000000000001','supplier','Bare Metals','amount','90.00',
  'xero_id','xero-lsf-bill-101','total','90.00')
  AND NOT (bare ? 'invoice_number') AND NOT (bare ? 'bill_number') AND NOT (bare ? 'number')
  AND NOT (bare ? 'paid') AND NOT (bare ? 'credits'),
  'bare paid bill ' || coalesce(bare::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000102');
 PERFORM pg_temp.lsf_assert(got = jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','19f00000-0000-4000-8000-000000000102',
  'job_id','19f00000-0000-4000-8000-000000000001','supplier','Priced Metals','amount','12.50',
  'bill_number','BILL-102','xero_id','xero-lsf-bill-102','total','12.50','paid','12.50','owing','0.00')
  AND NOT (got ? 'invoice_number') AND NOT (got ? 'number') AND NOT (got ? 'credits') AND NOT (got ? 'payments'),
  'paid bill money ' || coalesce(got::text, '<none>'));

 PERFORM pg_temp.lsf_assert(pg_temp.lsf_one('19f10000-0000-4000-8000-000000000204') IS NULL,
  'authorised invoice is not a paid link');

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000311');
 PERFORM pg_temp.lsf_assert(got = jsonb_build_object(
  'kind','sent_document','table','job_documents','id','19f00000-0000-4000-8000-000000000311',
  'job_id','19f00000-0000-4000-8000-000000000001','about','quote:q-19',
  'document_id','19f00000-0000-4000-8000-000000000311','quote_number','Q-19',
  'recipient','client@example.test',
  'email_ids', jsonb_build_array('19f00000-0000-4000-8000-000000000411'),
  'delivery_status','delivered')
  AND NOT (got ? 'invoice_number'),
  'sent quote ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000312');
 PERFORM pg_temp.lsf_assert(got = jsonb_build_object(
  'kind','sent_document','table','job_documents','id','19f00000-0000-4000-8000-000000000312',
  'job_id','19f00000-0000-4000-8000-000000000001','about','invoice:inv-19',
  'document_id','19f00000-0000-4000-8000-000000000312','invoice_number','INV-19',
  'recipient','client@example.test')
  AND NOT (got ? 'quote_number') AND NOT (got ? 'email_ids') AND NOT (got ? 'delivery_status'),
  'sent invoice document ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000313');
 PERFORM pg_temp.lsf_assert(got->>'kind' = 'sent_document' AND NOT (got ? 'recipient')
  AND got->'email_ids' = jsonb_build_array(
   '19f00000-0000-4000-8000-000000000413','19f00000-0000-4000-8000-000000000414')
  AND got->>'delivery_status' = 'sent' AND got->>'quote_number' = 'Q-191',
  'sent two addresses ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000314');
 PERFORM pg_temp.lsf_assert(got->>'recipient' = 'client@example.test' AND got->>'delivery_status' = 'bounced'
  AND got->'email_ids' = jsonb_build_array('19f00000-0000-4000-8000-000000000415'),
  'sent bounced ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000315');
 PERFORM pg_temp.lsf_assert(got->>'recipient' = 'client@example.test' AND NOT (got ? 'delivery_status')
  AND got->'email_ids' = jsonb_build_array(
   '19f00000-0000-4000-8000-000000000416','19f00000-0000-4000-8000-000000000417'),
  'sent bounced and failed ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000316');
 PERFORM pg_temp.lsf_assert(got->>'recipient' = 'client@example.test' AND NOT (got ? 'email_ids')
  AND NOT (got ? 'delivery_status') AND got->>'quote_number' = 'Q-194',
  'sent quote uses sent_to ' || coalesce(got::text, '<none>'));

 got := pg_temp.lsf_one('19f10000-0000-4000-8000-000000000317');
 PERFORM pg_temp.lsf_assert(got->>'kind' = 'sent_document' AND NOT (got ? 'recipient')
  AND got->'email_ids' = jsonb_build_array('19f00000-0000-4000-8000-000000000418')
  AND got->>'delivery_status' = 'sent',
  'sent several recipients ' || coalesce(got::text, '<none>'));
END $proof$;

ROLLBACK;
