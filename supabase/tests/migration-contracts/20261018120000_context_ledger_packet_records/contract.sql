-- Contract for 20261018120000_context_ledger_packet_records.
-- A worded evidence row carries records only when a stored id names a real row
-- of one of the six link shapes. Another job, another supplier, another amount,
-- a forwarded human email and a pointer that matches two invoices carry none.
-- Shape checks use a different exception prefix from the behaviour checks, so a
-- broken aggregator fails on the paid bill and not on the shape.

DO $shape$
DECLARE
 f text;
 live text;
 n int := 0;
 sigs text[] := ARRAY[
  'public.context_ledger_record_invoice_about(text)',
  'public.context_ledger_record_link_about(text)',
  'public.context_ledger_record_uuid(text)',
  'public.context_ledger_record_trim(text)',
  'public.context_ledger_record_money(numeric)',
  'public.context_ledger_comm_log_links(uuid,timestamptz,jsonb)',
  'public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)'];
BEGIN
 FOREACH f IN ARRAY sigs LOOP
  IF to_regprocedure(f) IS NULL THEN
   RAISE EXCEPTION 'ledger packet records shape: % missing', f;
  END IF;
  IF coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE 'Ledger packet records (20261018120000)%' THEN
   RAISE EXCEPTION 'ledger packet records shape: % comment', f;
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'ledger packet records shape: % not executable by service_role', f;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'ledger packet records shape: % executable by a browser role', f;
  END IF;
  n := n + 4;
 END LOOP;
 -- The two readers and the packet run as the owner. The about and uuid helpers
 -- stay invoker SQL so they can be inlined; they touch no table.
 FOREACH f IN ARRAY ARRAY[
  'public.context_ledger_comm_log_links(uuid,timestamptz,jsonb)',
  'public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)',
  'public.context_ledger_packet(uuid,timestamptz,timestamptz)'] LOOP
  IF (SELECT p.proconfig FROM pg_proc p WHERE p.oid = to_regprocedure(f))::text NOT LIKE '%search_path%public%pg_temp%' THEN
   RAISE EXCEPTION 'ledger packet records shape: % search_path', f;
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(f)) THEN
   RAISE EXCEPTION 'ledger packet records shape: % is not security definer', f;
  END IF;
  n := n + 2;
 END LOOP;
 IF public.context_ledger_record_link_about('Q-1042') IS DISTINCT FROM 'quote:q-1042' THEN
  RAISE EXCEPTION 'ledger packet records shape: Q-1042';
 END IF;
 IF public.context_ledger_record_invoice_about('INV-1307') IS DISTINCT FROM 'invoice:inv-1307' THEN
  RAISE EXCEPTION 'ledger packet records shape: INV-1307';
 END IF;
 IF public.context_ledger_record_link_about('Please find attached') IS NOT NULL THEN
  RAISE EXCEPTION 'ledger packet records shape: prose about';
 END IF;
 IF public.context_ledger_record_link_about('2026-10-02') IS DISTINCT FROM 'booking:2026-10-02' THEN
  RAISE EXCEPTION 'ledger packet records shape: booking date';
 END IF;
 IF public.context_ledger_record_link_about('invoice:inv-88') IS DISTINCT FROM 'invoice:inv-88' THEN
  RAISE EXCEPTION 'ledger packet records shape: invoice about already';
 END IF;
 IF public.context_ledger_record_uuid('not-a-uuid') IS NOT NULL THEN
  RAISE EXCEPTION 'ledger packet records shape: non uuid';
 END IF;
 IF public.context_ledger_record_uuid('18F00000-0000-4000-8000-000000000101')
    IS DISTINCT FROM '18f00000-0000-4000-8000-000000000101'::uuid THEN
  RAISE EXCEPTION 'ledger packet records shape: uuid parse';
 END IF;
 IF public.context_ledger_record_trim(U&'\00A0') IS NOT NULL
  OR public.context_ledger_record_trim(E'\tAcme\n') IS DISTINCT FROM 'Acme'
  OR public.context_ledger_record_trim(U&'Acme\00A0Metals') IS DISTINCT FROM U&'Acme\00A0Metals'
  OR public.context_ledger_record_trim(U&'\200B') IS DISTINCT FROM U&'\200B' THEN
  RAISE EXCEPTION 'ledger packet records shape: javascript trim';
 END IF;
 IF public.context_ledger_record_money(90) IS DISTINCT FROM '90.00'
  OR public.context_ledger_record_money(10.10) IS DISTINCT FROM '10.10'
  OR public.context_ledger_record_money(0.10) IS DISTINCT FROM '0.10'
  OR public.context_ledger_record_money(1000000000.50) IS DISTINCT FROM '1000000000.50'
  OR public.context_ledger_record_money(0) IS NOT NULL
  OR public.context_ledger_record_money(-1) IS NOT NULL THEN
  RAISE EXCEPTION 'ledger packet records shape: money text %', public.context_ledger_record_money(1000000000.50);
 END IF;
 n := n + 9;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)');
 IF live IS DISTINCT FROM '4d99c79138a3b9de41b2957145addeb2' THEN
  RAISE EXCEPTION 'ledger packet records shape: packet md5 %', live;
 END IF;
 IF coalesce(obj_description(to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)'), 'pg_proc'), '')
    NOT LIKE '% Held notes (20261015100000): %'
  OR coalesce(obj_description(to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)'), 'pg_proc'), '')
    NOT LIKE '%Ledger packet records (20261018120000): an evidence row carries records%'
  OR coalesce(obj_description(to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)'), 'pg_proc'), '')
    LIKE 'Held notes%' THEN
  RAISE EXCEPTION 'ledger packet records shape: packet comment';
 END IF;
 IF NOT has_function_privilege('service_role', 'public.context_ledger_packet(uuid,timestamptz,timestamptz)', 'EXECUTE')
  OR has_function_privilege('anon', 'public.context_ledger_packet(uuid,timestamptz,timestamptz)', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.context_ledger_packet(uuid,timestamptz,timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'ledger packet records shape: packet privileges';
 END IF;
 n := n + 3;
 RAISE NOTICE 'ledger packet records shape checks: %', n;
END $shape$;

BEGIN;
SET LOCAL session_replication_role = replica;

CREATE FUNCTION pg_temp.lpr_assert(p_ok boolean, p_why text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger packet records contract: %', p_why; END IF;
 PERFORM set_config('lpr.n', (coalesce(nullif(current_setting('lpr.n', true), ''), '0')::int + 1)::text, true);
END $$;

CREATE FUNCTION pg_temp.lpr_ev(p_id uuid, p_job uuid, p_body text, p_at timestamptz, p_payload jsonb DEFAULT '{}',
 p_meta jsonb DEFAULT '{}', p_source_table text DEFAULT NULL, p_source_id text DEFAULT NULL,
 p_status text DEFAULT 'direct', p_candidates uuid[] DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id,
  payload, metadata, occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step,
  attribution_confidence, attributed_at, match_method, candidate_job_ids, source_table, source_id)
 VALUES (p_id, p_job, 'client.sms_in', 'ledger_contract', 'sms', 'inbound', 'lpr-ct', 'lpr:' || p_id::text,
  jsonb_build_object('body', p_body) || coalesce(p_payload, '{}'::jsonb),
  jsonb_build_object('written_as', 'service_role') || coalesce(p_meta, '{}'::jsonb),
  p_at, p_at, p_at, p_at, p_status, 1,
  CASE WHEN p_job IS NULL THEN NULL ELSE 1 END,
  CASE WHEN p_job IS NULL THEN NULL ELSE p_at END,
  CASE WHEN p_job IS NULL THEN NULL ELSE 'direct_job_id' END,
  p_candidates, p_source_table, p_source_id);
END $$;

INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
VALUES
 ('18f00000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'scheduled', 'fencing', 'SWF-LPR18F1',
  'Robin Ledger', 'client@example.test', 'lpr-ct-1', 'Testville', '{}', '2026-09-01 00:00Z'),
 ('18f00000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'scheduled', 'fencing', 'SWF-LPR18F2',
  'Other Client', 'other@example.test', 'lpr-ct-2', 'Elsewhere', '{}', '2026-09-01 00:00Z');

INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at) VALUES
 ('18f00000-0000-4000-8000-000000000301', '18f00000-0000-4000-8000-000000000001', 'quote', 'Q-9', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
 ('18f00000-0000-4000-8000-000000000302', '18f00000-0000-4000-8000-000000000001', 'quote', 'Q-77', 1, '2026-10-01 00:00Z', NULL),
 ('18f00000-0000-4000-8000-000000000303', '18f00000-0000-4000-8000-000000000001', 'quote', 'Q-55', 1, '2026-10-01 00:00Z', NULL),
 ('18f00000-0000-4000-8000-000000000304', '18f00000-0000-4000-8000-000000000001', 'quote', 'Please find attached', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
 ('18f00000-0000-4000-8000-000000000305', '18f00000-0000-4000-8000-000000000001', 'quote', 'Q-8', 1, '2026-10-01 00:00Z', '2026-10-18 01:00Z'),
 ('18f00000-0000-4000-8000-000000000306', '18f00000-0000-4000-8000-000000000002', 'quote', 'Q-1', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z');

INSERT INTO public.xero_invoices (id, org_id, job_id, xero_invoice_id, contact_name, invoice_number, invoice_type, status,
 total, fully_paid_on, created_at, line_items) VALUES
 ('18f00000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-bill-metals', ' Other Metals ', NULL, 'ACCPAY', 'PAID', 90, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-bill-steel', 'Sample Steel', NULL, 'ACCPAY', 'PAID', 48.15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000002',
  'xero-lpr-bill-other', 'Elsewhere Steel', NULL, 'ACCPAY', 'PAID', 12.00, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-draft', 'Draft Co', NULL, 'ACCPAY', 'DRAFT', 10, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-blank', '   ', NULL, 'ACCPAY', 'PAID', 10, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-zero', 'Zero Co', NULL, 'ACCPAY', 'PAID', 0, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-neg', 'Neg Co', NULL, 'ACCPAY', 'PAID', -1, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000108', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-future', 'Future Co', NULL, 'ACCPAY', 'PAID', 10, '2026-10-19', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000109', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-late', 'Late Co', NULL, 'ACCPAY', 'PAID', 11, '2026-10-01', '2026-10-18 01:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-token-1307', 'Payer One', 'INV-1307', 'ACCREC', 'PAID', 165, NULL, '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  '18f00000-0000-4000-8000-000000000299', 'Payer Two', 'INV-44', 'ACCREC', 'PAID', 44, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000298', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-i3-own', 'Payer Three', 'INV-3', 'ACCREC', 'PAID', 3, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  '18f00000-0000-4000-8000-000000000298', 'Payer Four', 'INV-4', 'ACCREC', 'PAID', 4, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000297', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-i7-own', 'Payer Seven', 'INV-77', 'ACCREC', 'PAID', 77, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f00000-0000-4000-8000-000000000208', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  '18f00000-0000-4000-8000-000000000297', 'Payer Eight', 'INV-78', 'ACCREC', 'DRAFT', 78, NULL, '2026-10-01 00:00Z', '[]');

INSERT INTO public.email_events (id, job_id, email_type, recipient, subject, status, sent_at, created_at, metadata) VALUES
 ('18f00000-0000-4000-8000-000000000401', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-1042"}'),
 ('18f00000-0000-4000-8000-000000000402', '18f00000-0000-4000-8000-000000000001', 'quote_sent', 'client@example.test', 'Your paperwork',
  'delivered', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-2001"}'),
 ('18f00000-0000-4000-8000-000000000403', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'failed', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-1042"}'),
 ('18f00000-0000-4000-8000-000000000404', '18f00000-0000-4000-8000-000000000001', 'reminder', 'client@example.test', 'Your paperwork',
  'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-1042"}'),
 ('18f00000-0000-4000-8000-000000000405', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'accepted', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"document_id":"18f00000-0000-4000-8000-000000000303"}'),
 ('18f00000-0000-4000-8000-000000000406', '18f00000-0000-4000-8000-000000000001', 'client_email', 'client@example.test', 'Your paperwork',
  'accepted', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"business_event_id":"18f10000-0000-4000-8000-000000000016","quote_number":"Q-3001"}');

INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at) VALUES
 ('18f00000-0000-4000-8000-000000000501', '18f00000-0000-4000-8000-000000000001', 'quote_sent', '{"invoice_number":"INV-88"}', '2026-10-01 00:00Z'),
 ('18f00000-0000-4000-8000-000000000502', '18f00000-0000-4000-8000-000000000001', 'booking_set', '{"scheduled_date":"2026-10-02"}', '2026-10-01 00:00Z');

DO $comm$
BEGIN
 IF to_regclass('public.communications_log') IS NULL THEN
  CREATE TABLE public.communications_log (
   id uuid PRIMARY KEY,
   has_attachments boolean,
   document_id uuid,
   business_event_id uuid,
   created_at timestamptz
  );
 END IF;
END $comm$;

INSERT INTO public.communications_log (id, has_attachments, document_id, business_event_id, created_at) VALUES
 ('18f00000-0000-4000-8000-000000000601', true, '18f00000-0000-4000-8000-000000000302', '18f10000-0000-4000-8000-000000000002', '2026-10-01 00:00Z'),
 ('18f00000-0000-4000-8000-000000000602', false, '18f00000-0000-4000-8000-000000000301', '18f10000-0000-4000-8000-000000000002', '2026-10-01 00:00Z'),
 ('18f00000-0000-4000-8000-000000000603', true, NULL, '18f10000-0000-4000-8000-000000000002', '2026-10-01 00:00Z'),
 ('18f00000-0000-4000-8000-000000000604', true, '18f00000-0000-4000-8000-000000000306', '18f10000-0000-4000-8000-000000000002', '2026-10-01 00:00Z'),
 ('18f00000-0000-4000-8000-000000000605', true, '18f00000-0000-4000-8000-000000000302', '18f10000-0000-4000-8000-000000000002', '2026-10-18 01:00Z'),
 ('18f00000-0000-4000-8000-000000000606', true, '18f00000-0000-4000-8000-000000000302', NULL, '2026-10-01 00:00Z');

SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000001', '18f00000-0000-4000-8000-000000000001',
 'The gate is fine.', '2026-10-01 00:01Z', '{}', '{"has_attachments":true}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000002', '18f00000-0000-4000-8000-000000000001',
 'Please pay the deposit and send the quote.', '2026-10-01 00:02Z',
 '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000101","document_id":"18f00000-0000-4000-8000-000000000301","email_event_id":"18f00000-0000-4000-8000-000000000401","job_event_id":"18f00000-0000-4000-8000-000000000501","related_entities":[{"type":"xero_invoice","id":"18f00000-0000-4000-8000-000000000201"}]}',
 '{}', 'xero_invoices', '18f00000-0000-4000-8000-000000000103');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000003', '18f00000-0000-4000-8000-000000000001',
 'Alias quote mail.', '2026-10-01 00:03Z', '{"email_event_id":"18f00000-0000-4000-8000-000000000402"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000004', '18f00000-0000-4000-8000-000000000001',
 'Token names the invoice.', '2026-10-01 00:04Z', '{"xero_invoice_id":"xero-lpr-token-1307"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000005', '18f00000-0000-4000-8000-000000000001',
 'The booking is set.', '2026-10-01 00:05Z', '{"job_event_id":"18f00000-0000-4000-8000-000000000502"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000006', '18f00000-0000-4000-8000-000000000001',
 'The email names the quote file.', '2026-10-01 00:06Z', '{"email_event_id":"18f00000-0000-4000-8000-000000000405"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000007', '18f00000-0000-4000-8000-000000000001',
 'The file was not sent.', '2026-10-01 00:07Z', '{"document_id":"18f00000-0000-4000-8000-000000000302"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000008', '18f00000-0000-4000-8000-000000000001',
 'The sent file has no number.', '2026-10-01 00:08Z', '{"document_id":"18f00000-0000-4000-8000-000000000304"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000009', '18f00000-0000-4000-8000-000000000001',
 'The mail failed.', '2026-10-01 00:09Z', '{"email_event_id":"18f00000-0000-4000-8000-000000000403"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-00000000000a', '18f00000-0000-4000-8000-000000000001',
 'The bill is still a draft.', '2026-10-01 00:10Z', '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000104"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-00000000000b', '18f00000-0000-4000-8000-000000000001',
 'The supplier name is blank.', '2026-10-01 00:11Z', '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000105"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-00000000000c', '18f00000-0000-4000-8000-000000000001',
 'The amount is zero.', '2026-10-01 00:12Z', '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000106"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-00000000000d', '18f00000-0000-4000-8000-000000000001',
 'The amount is negative.', '2026-10-01 00:13Z', '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000107"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-00000000000e', '18f00000-0000-4000-8000-000000000001',
 'That bill is another job.', '2026-10-01 00:14Z', '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000103"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-00000000000f', '18f00000-0000-4000-8000-000000000001',
 'A reminder is not a system mail.', '2026-10-01 00:15Z', '{"email_event_id":"18f00000-0000-4000-8000-000000000404"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000010', '18f00000-0000-4000-8000-000000000001',
 'A flag is not a file row.', '2026-10-01 00:16Z', '{}',
 '{"has_attachments":true,"document_id":"18f00000-0000-4000-8000-000000000302"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000011', '18f00000-0000-4000-8000-000000000001',
 'Paid after the reading.', '2026-10-01 00:17Z', '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000108"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000012', '18f00000-0000-4000-8000-000000000001',
 'Created after the reading.', '2026-10-01 00:18Z', '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000109"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000013', '18f00000-0000-4000-8000-000000000001',
 'Sent after the reading.', '2026-10-01 00:19Z', '{"document_id":"18f00000-0000-4000-8000-000000000305"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000014', '18f00000-0000-4000-8000-000000000001',
 'The token is a uuid.', '2026-10-01 00:20Z', '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000299"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000015', '18f00000-0000-4000-8000-000000000001',
 'Two invoices share that pointer.', '2026-10-01 00:21Z', '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000298"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000016', '18f00000-0000-4000-8000-000000000001',
 'The mail points back.', '2026-10-01 00:22Z');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000017', '18f00000-0000-4000-8000-000000000001',
 'A bare invoice label.', '2026-10-01 00:23Z', '{}', '{}', 'invoice', '18f00000-0000-4000-8000-000000000101');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000018', '18f00000-0000-4000-8000-000000000001',
 'The log names the file.', '2026-10-01 00:24Z', '{"communications_log_id":"18f00000-0000-4000-8000-000000000606"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000019', '18f00000-0000-4000-8000-000000000001',
 'A paid invoice shares its id with a draft token.', '2026-10-01 00:25Z',
 '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000297"}');
SELECT pg_temp.lpr_ev('18f10000-0000-4000-8000-000000000022', NULL,
 'This might be about the other fence too.', '2026-10-01 00:40Z',
 '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000101"}',
 '{"placement_rule":"review_several"}', NULL, NULL, 'unplaced',
 ARRAY['18f00000-0000-4000-8000-000000000001','18f00000-0000-4000-8000-000000000002']::uuid[]);

INSERT INTO public.inbox_events (id, job_id, mailbox, from_email, from_name, subject, body_preview, received_at, processed_at, classification, graph_message_id)
VALUES ('18f20000-0000-4000-8000-000000000001', '18f00000-0000-4000-8000-000000000001', 'admin@secureworkswa.com.au',
 'neighbour@example.test', 'Neighbour Example', 'Fwd: the quote',
 'Forwarding the neighbour''s note about the fence.', '2026-10-01 00:50Z', '2026-10-01 00:50Z', 'client', 'graph-lpr-forward-1');

INSERT INTO public.context_email_attachments (id, provider_message_id, attachment_key, business_event_id, file_name, content_type,
 sha256, storage_bucket, storage_path, status, created_at)
VALUES ('18f00000-0000-4000-8000-000000000701', 'email:lpr-full@example.test', repeat('a', 64),
 '18f10000-0000-4000-8000-000000000002', 'quote.pdf', 'application/pdf', repeat('b', 64),
 'context-email-attachments', 'synthetic.pdf', 'stored', '2026-10-01 00:00Z');

DO $proof$
DECLARE
 j1 text := '18f00000-0000-4000-8000-000000000001';
 j2 uuid := '18f00000-0000-4000-8000-000000000002';
 as_of timestamptz := '2026-10-18 00:00Z';
 pkt jsonb;
 pkt2 jsonb;
 got_full jsonb;
 expected jsonb;
 rowj jsonb;
 keys text;
 held_row jsonb;
 neg text;
 leaked text;
 n_ev int;
BEGIN
 pkt := public.context_ledger_packet('18f00000-0000-4000-8000-000000000001', NULL, as_of);
 SELECT e->'records' INTO got_full FROM jsonb_array_elements(pkt->'evidence') e
  WHERE e->>'id' = '18f10000-0000-4000-8000-000000000002';
 expected := jsonb_build_array(
  jsonb_build_object('kind','attachment','table','job_documents','id','18f00000-0000-4000-8000-000000000601','job_id',j1,
   'document_id','18f00000-0000-4000-8000-000000000302','about','quote:q-77'),
  jsonb_build_object('kind','job_event','table','job_events','id','18f00000-0000-4000-8000-000000000501','job_id',j1,
   'event_type','quote_sent','about','invoice:inv-88'),
  jsonb_build_object('kind','paid_bill','table','xero_invoices','id','18f00000-0000-4000-8000-000000000101','job_id',j1,
   'supplier','Other Metals','amount','90.00'),
  jsonb_build_object('kind','paid_invoice','table','xero_invoices','id','18f00000-0000-4000-8000-000000000201','job_id',j1,
   'number','invoice:inv-1307'),
  jsonb_build_object('kind','sent_document','table','job_documents','id','18f00000-0000-4000-8000-000000000301','job_id',j1,
   'about','quote:q-9'),
  jsonb_build_object('kind','system_email','table','email_events','id','18f00000-0000-4000-8000-000000000401','job_id',j1,
   'email_type','quote','status','sent','about','quote:q-1042','system', true));
 PERFORM pg_temp.lpr_assert(got_full IS NOT DISTINCT FROM expected, 'paid bill link got ' || coalesce(got_full::text, '<none>'));
 PERFORM pg_temp.lpr_assert(jsonb_typeof(got_full->5->'system') = 'boolean' AND (got_full->5->>'system') = 'true', 'system not boolean');
 PERFORM pg_temp.lpr_assert(jsonb_typeof(got_full->2->'amount') = 'string', 'amount type ' || coalesce(jsonb_typeof(got_full->2->'amount'), '<none>'));
 PERFORM pg_temp.lpr_assert(got_full::text NOT LIKE '%Sample Steel%' AND got_full::text NOT LIKE '%48.15%' AND got_full::text NOT LIKE '%Elsewhere Steel%',
  'decoy supplier or other job amount leaked');
 PERFORM pg_temp.lpr_assert(jsonb_array_length(got_full) = 6, 'full length');

 SELECT e->'records' INTO got_full FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000003';
 PERFORM pg_temp.lpr_assert(got_full IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','system_email','table','email_events','id','18f00000-0000-4000-8000-000000000402','job_id',j1,
  'email_type','quote','status','delivered','about','quote:q-2001','system', true)), 'alias email ' || coalesce(got_full::text, '<none>'));

 SELECT e->'records' INTO got_full FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000004';
 PERFORM pg_temp.lpr_assert(got_full IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_invoice','table','xero_invoices','id','18f00000-0000-4000-8000-000000000201','job_id',j1,
  'number','invoice:inv-1307')), 'token invoice ' || coalesce(got_full::text, '<none>'));

 SELECT e->'records' INTO got_full FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000005';
 PERFORM pg_temp.lpr_assert(got_full IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','job_event','table','job_events','id','18f00000-0000-4000-8000-000000000502','job_id',j1,
  'event_type','booking_set','about','booking:2026-10-02')), 'booking ' || coalesce(got_full::text, '<none>'));

 SELECT e->'records' INTO got_full FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000006';
 PERFORM pg_temp.lpr_assert(got_full IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','system_email','table','email_events','id','18f00000-0000-4000-8000-000000000405','job_id',j1,
  'email_type','quote','status','accepted','about','quote:q-55','system', true)), 'document fallback email ' || coalesce(got_full::text, '<none>'));

 SELECT e->'records' INTO got_full FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000014';
 PERFORM pg_temp.lpr_assert(got_full IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_invoice','table','xero_invoices','id','18f00000-0000-4000-8000-000000000202','job_id',j1,
  'number','invoice:inv-44')), 'uuid token ' || coalesce(got_full::text, '<none>'));

 SELECT e->'records' INTO got_full FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000016';
 PERFORM pg_temp.lpr_assert(got_full IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','system_email','table','email_events','id','18f00000-0000-4000-8000-000000000406','job_id',j1,
  'email_type','client_email','status','accepted','about','quote:q-3001','system', true)), 'reverse email ' || coalesce(got_full::text, '<none>'));

 SELECT e->'records' INTO got_full FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000018';
 PERFORM pg_temp.lpr_assert(got_full IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','attachment','table','job_documents','id','18f00000-0000-4000-8000-000000000606','job_id',j1,
  'document_id','18f00000-0000-4000-8000-000000000302','about','quote:q-77')), 'forward comm ' || coalesce(got_full::text, '<none>'));

 leaked := NULL;
 FOREACH neg IN ARRAY ARRAY[
  '18f10000-0000-4000-8000-000000000001','18f10000-0000-4000-8000-000000000007','18f10000-0000-4000-8000-000000000008',
  '18f10000-0000-4000-8000-000000000009','18f10000-0000-4000-8000-00000000000a','18f10000-0000-4000-8000-00000000000b',
  '18f10000-0000-4000-8000-00000000000c','18f10000-0000-4000-8000-00000000000d','18f10000-0000-4000-8000-00000000000e',
  '18f10000-0000-4000-8000-00000000000f','18f10000-0000-4000-8000-000000000010','18f10000-0000-4000-8000-000000000011',
  '18f10000-0000-4000-8000-000000000012','18f10000-0000-4000-8000-000000000013','18f10000-0000-4000-8000-000000000015',
  '18f10000-0000-4000-8000-000000000017','18f10000-0000-4000-8000-000000000019','18f20000-0000-4000-8000-000000000001'] LOOP
  SELECT e INTO rowj FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = neg;
  IF rowj IS NULL OR (rowj ? 'records') THEN
   leaked := coalesce(leaked || ',', '') || neg;
  END IF;
 END LOOP;
 PERFORM pg_temp.lpr_assert(leaked IS NULL, 'negative rows leaked or missing ' || coalesce(leaked, ''));

 n_ev := jsonb_array_length(pkt->'evidence');
 PERFORM pg_temp.lpr_assert(n_ev = 26 AND (pkt->>'evidence_rows')::int = 26, 'evidence count ' || n_ev || ' rows ' || coalesce(pkt->>'evidence_rows', '<none>'));
 PERFORM pg_temp.lpr_assert((pkt->>'duplicates_collapsed')::int = 0, 'collapsed ' || coalesce(pkt->>'duplicates_collapsed', '<none>'));
 PERFORM pg_temp.lpr_assert(pkt->>'version' = 'ledger-packet-v1' AND NOT (pkt ? 'records'), 'packet version or top-level records');

 -- jsonb stores object keys by length then text, so records is not last.
 -- What must not change is the set of names an older reader looks up.
 SELECT e INTO rowj FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000001';
 SELECT string_agg(k, ',' ORDER BY k) INTO keys FROM jsonb_object_keys(rowj) k;
 PERFORM pg_temp.lpr_assert(keys = 'already_read,at,audience,automated,call_customer,channel,counterpart_role,direction,elsewhere,has_transcript,id,kind,ours,placed_on,recipient,recipient_role,recorded_at,role_basis,sender,sender_role,subject,table,text',
  'bare keys ' || coalesce(keys, '<none>'));

 SELECT e INTO rowj FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000002';
 SELECT string_agg(k, ',' ORDER BY k) INTO keys FROM jsonb_object_keys(rowj) k;
 PERFORM pg_temp.lpr_assert(keys = 'already_read,at,audience,automated,call_customer,channel,counterpart_role,direction,elsewhere,has_transcript,id,kind,ours,placed_on,recipient,recipient_role,recorded_at,records,role_basis,sender,sender_role,subject,table,text',
  'full keys ' || coalesce(keys, '<none>'));

 SELECT e INTO rowj FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f20000-0000-4000-8000-000000000001';
 PERFORM pg_temp.lpr_assert(rowj->>'subject' = 'Fwd: the quote' AND rowj->>'text' LIKE '%neighbour%' AND NOT (rowj ? 'records'),
  'forwarded human email');

 pkt2 := public.context_ledger_packet(j2, NULL, as_of);
 PERFORM pg_temp.lpr_assert(pkt2->>'version' = 'ledger-packet-v1' AND jsonb_array_length(pkt2->'evidence') = 0 AND (pkt2->>'evidence_rows')::int = 0,
  'other job evidence ' || coalesce(pkt2->>'evidence_rows', '<none>'));

 SELECT e INTO held_row FROM jsonb_array_elements(pkt->'held'->'rows') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000022';
 PERFORM pg_temp.lpr_assert(held_row IS NOT NULL AND NOT (held_row ? 'records')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000022'),
  'held row ' || coalesce(held_row::text, '<missing>'));

 RAISE NOTICE 'ledger packet records behaviour checks: %', current_setting('lpr.n', true);
END $proof$;

\ir review_scenarios.sql

ROLLBACK;

\ir ../../../migrations/20261018120000_context_ledger_packet_records.sql

DO $re$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)');
 IF live IS DISTINCT FROM '4d99c79138a3b9de41b2957145addeb2' THEN
  RAISE EXCEPTION 'ledger packet records shape: reapply md5 %', live;
 END IF;
END $re$;

-- Same seed the review measured: 100,000 communications_log rows, 20,000 of
-- them attached, 80 source ids, zero of those ids in the bulk business_event_id
-- column. One planted row matches. The table is created here, after the
-- migration, so the partial indexes are absent and the bound is the unindexed
-- plan. Rolled back so later contracts do not inherit the seed.
BEGIN;
SET LOCAL session_replication_role = replica;
SET LOCAL statement_timeout = '120s';
SET LOCAL jit = off;

INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
VALUES ('18f60000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'scheduled', 'fencing', 'SWF-LPRPERF1',
 'Perf Client', 'perf@example.test', 'lpr-perf', 'Testville', '{}', '2026-09-01 00:00Z');

INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('18f60000-0000-4000-8000-000000000301', '18f60000-0000-4000-8000-000000000001', 'quote', 'Q-77', 1, '2026-10-01 00:00Z', NULL);

CREATE TABLE IF NOT EXISTS public.communications_log (
 id uuid PRIMARY KEY,
 has_attachments boolean,
 document_id uuid,
 business_event_id uuid,
 created_at timestamptz
);

INSERT INTO public.communications_log (id, has_attachments, document_id, business_event_id, created_at)
SELECT ('18f63000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
 g <= 20000,
 CASE WHEN g <= 20000 THEN '18f60000-0000-4000-8000-000000000301'::uuid ELSE NULL END,
 ('18f61000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
 '2026-10-01 00:00Z'
FROM generate_series(1, 100000) g;

UPDATE public.communications_log
SET business_event_id = '18f62000-0000-4000-8000-000000000001',
    has_attachments = true,
    document_id = '18f60000-0000-4000-8000-000000000301',
    created_at = '2026-10-01 00:00Z'
WHERE id = '18f63000-0000-4000-8000-000000000001';

ANALYZE public.communications_log;

DO $perf$
DECLARE
 sources jsonb;
 plan text;
 ms numeric;
 hits int;
 about text;
 doc text;
BEGIN
 IF to_regclass('public.communications_log_ledger_business_event_idx') IS NOT NULL
  OR to_regclass('public.communications_log_ledger_inbox_event_idx') IS NOT NULL THEN
  RAISE EXCEPTION 'ledger packet records contract: performance seed is indexed';
 END IF;
 SELECT jsonb_agg(jsonb_build_object(
   'table', 'business_events',
   'id', '18f62000-0000-4000-8000-' || lpad(g::text, 12, '0')) ORDER BY g)
  INTO sources
 FROM generate_series(1, 80) g;
 EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM public.context_ledger_comm_log_links($1, $2, $3)'
  INTO plan
  USING '18f60000-0000-4000-8000-000000000001'::uuid, '2026-10-18 00:00+00'::timestamptz, sources;
 ms := (plan::jsonb->0->>'Execution Time')::numeric;
 RAISE NOTICE 'ledger packet records comm log links ms: %', ms;
 IF ms >= 500 THEN
  RAISE EXCEPTION 'ledger packet records contract: comm log links % ms', ms;
 END IF;
 SELECT count(*)::int, min(c.rec->>'about'), min(c.rec->>'document_id')
  INTO hits, about, doc
 FROM public.context_ledger_comm_log_links(
  '18f60000-0000-4000-8000-000000000001', '2026-10-18 00:00+00', sources) c;
 IF hits IS DISTINCT FROM 1
  OR about IS DISTINCT FROM 'quote:q-77'
  OR doc IS DISTINCT FROM '18f60000-0000-4000-8000-000000000301' THEN
  RAISE EXCEPTION 'ledger packet records contract: planted attachment % % %', hits, about, doc;
 END IF;
 EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM public.context_ledger_evidence_record_links($1, $2, $3)'
  INTO plan
  USING '18f60000-0000-4000-8000-000000000001'::uuid, '2026-10-18 00:00+00'::timestamptz, sources;
 ms := (plan::jsonb->0->>'Execution Time')::numeric;
 RAISE NOTICE 'ledger packet records evidence record links ms: %', ms;
 IF ms >= 500 THEN
  RAISE EXCEPTION 'ledger packet records contract: evidence record links % ms', ms;
 END IF;
END $perf$;

ROLLBACK;
