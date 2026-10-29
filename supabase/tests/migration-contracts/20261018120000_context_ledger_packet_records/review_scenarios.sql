-- Reviewer's false-link hunt, reconstructed from the PR 1077 comment.
-- Runs inside the behaviour transaction, after the 26-row proof, and rolls
-- back with it. The whitespace sweep is extra: one assert per character the
-- reader strips, for a supplier and for an event_type, empty and padded.
-- sn counts the 61 numbered scenarios and nothing else.

CREATE FUNCTION pg_temp.lpr_links(p_id uuid, p_as_of timestamptz DEFAULT '2026-10-18 00:00+00')
RETURNS jsonb LANGUAGE sql AS $$
 SELECT l.records
 FROM public.context_ledger_evidence_record_links(
  '18f00000-0000-4000-8000-000000000001',
  p_as_of,
  jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', p_id::text))) l
$$;

INSERT INTO public.xero_invoices (id, org_id, job_id, xero_invoice_id, contact_name, invoice_number, invoice_type, status,
 total, fully_paid_on, created_at, line_items) VALUES
 ('18f50000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-ws', 'Acme', NULL, 'ACCPAY', 'PAID', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000906', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-voided', 'Void Co', NULL, 'ACCPAY', 'VOIDED', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000907', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-deleted', 'Deleted Co', NULL, 'ACCPAY', 'DELETED', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000908', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-auth', 'Auth Co', NULL, 'ACCPAY', 'AUTHORISED', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000909', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-paycredit', 'Credit Co', NULL, 'ACCPAYCREDIT', 'PAID', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000910', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-recredit', 'Credit Rec', 'INV-1', 'ACCRECCREDIT', 'PAID', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000913', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000002',
  'xero-lpr-other-job', 'Other Job Metals', NULL, 'ACCPAY', 'PAID', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000922', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-nbsp', 'Acme', NULL, 'ACCPAY', 'PAID', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000923', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-tab', 'Acme', NULL, 'ACCPAY', 'PAID', 16, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000924', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-nl', 'Acme', NULL, 'ACCPAY', 'PAID', 17, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000925', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-twin-paid', 'Twin Metals', NULL, 'ACCPAY', 'PAID', 33, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000926', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  '18f50000-0000-4000-8000-000000000925', 'Twin Void', NULL, 'ACCPAY', 'VOIDED', 33, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000933', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-case', 'Case Metals', NULL, 'ACCPAY', 'paid', 19, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000936', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-perth', 'Perth Metals', NULL, 'ACCPAY', 'PAID', 40, '2026-10-18', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000939', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-padded-939', 'Padded Metals', NULL, 'ACCPAY', 'PAID', 39, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000940', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-nonum', 'No Number', NULL, 'ACCREC', 'PAID', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000941', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-bill-inv9', 'Only Bill', 'INV-9', 'ACCPAY', 'PAID', 9, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000943', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-owing', 'Owing Metals', NULL, 'ACCPAY', 'PAID', 50, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000944', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-nullpaid', 'Null Paid', NULL, 'ACCPAY', 'PAID', 44, NULL, '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000959', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-trimsup', 'Acme', NULL, 'ACCPAY', 'PAID', 21, '2026-10-01', '2026-10-01 00:00Z', '[]'),
 ('18f50000-0000-4000-8000-000000000961', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
  'xero-lpr-big', 'Big Metals', NULL, 'ACCPAY', 'PAID', 1000000000.50, '2026-10-01', '2026-10-01 00:00Z', '[]');

UPDATE public.xero_invoices SET amount_due = 50 WHERE id = '18f50000-0000-4000-8000-000000000943';
UPDATE public.xero_invoices SET synced_at = '2026-10-19 00:00Z' WHERE id = '18f50000-0000-4000-8000-000000000944';

INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at) VALUES
 ('18f53000-0000-4000-8000-000000000100', '18f00000-0000-4000-8000-000000000001', 'quote', 'Q-100', 1, '2026-10-01 00:00Z', '2026-10-01 00:00Z'),
 ('18f53000-0000-4000-8000-000000000045', '18f00000-0000-4000-8000-000000000001', 'quote', 'Q-45', 1, '2026-10-01 00:00Z', '2026-10-18 00:00Z'),
 ('18f53000-0000-4000-8000-000000000046', '18f00000-0000-4000-8000-000000000001', 'quote', 'Q-46', 1, '2026-10-01 00:00Z', '2026-10-18 00:00:01Z');

INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at) VALUES
 ('18f52000-0000-4000-8000-000000000801', '18f00000-0000-4000-8000-000000000001', 'booking_set', '{"scheduled_date":"2026-10-02"}', '2026-10-01 00:00Z'),
 ('18f52000-0000-4000-8000-000000000003', '18f00000-0000-4000-8000-000000000002', 'booking_set', '{"scheduled_date":"2026-10-02"}', '2026-10-01 00:00Z'),
 ('18f52000-0000-4000-8000-000000000004', '18f00000-0000-4000-8000-000000000002', 'booking_set',
  '{"business_event_id":"18f51000-0000-4000-8000-000000000004","scheduled_date":"2026-10-02"}', '2026-10-01 00:00Z'),
 ('18f52000-0000-4000-8000-000000000020', '18f00000-0000-4000-8000-000000000001', 'booking_set', '{"scheduled_date":"2026-10-02"}', '2026-10-18 01:00Z'),
 ('18f52000-0000-4000-8000-000000000021', '18f00000-0000-4000-8000-000000000001', '   ', '{"scheduled_date":"2026-10-02"}', '2026-10-01 00:00Z'),
 ('18f52000-0000-4000-8000-000000000025', '18f00000-0000-4000-8000-000000000001', E'\t', '{"scheduled_date":"2026-10-02"}', '2026-10-01 00:00Z'),
 ('18f52000-0000-4000-8000-000000000048', '18f00000-0000-4000-8000-000000000001', 'booking_set',
  '{"invoice_number":"Please pay INV-1307","scheduled_date":"2026-10-02"}', '2026-10-01 00:00Z'),
 ('18f52000-0000-4000-8000-000000000060', '18f00000-0000-4000-8000-000000000001', 'booking_set', '{"scheduled_date":"2026-10-02"}', '2026-10-01 00:00Z');

INSERT INTO public.email_events (id, job_id, email_type, recipient, subject, status, sent_at, created_at, metadata) VALUES
 ('18f54000-0000-4000-8000-000000000005', '18f00000-0000-4000-8000-000000000002', 'quote', 'other@example.test', 'Your paperwork',
  'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z',
  '{"business_event_id":"18f51000-0000-4000-8000-000000000005","quote_number":"Q-1042"}'),
 ('18f54000-0000-4000-8000-000000000014', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'bounced', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-1042"}'),
 ('18f54000-0000-4000-8000-000000000015', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'complained', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-1042"}'),
 ('18f54000-0000-4000-8000-000000000016', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'queued', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-1042"}'),
 ('18f54000-0000-4000-8000-000000000017', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'opened', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-1042"}'),
 ('18f54000-0000-4000-8000-000000000018', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'sent', NULL, '2026-10-01 00:00Z', '{"quote_number":"Q-1042"}'),
 ('18f54000-0000-4000-8000-000000000019', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'sent', '2026-10-18 01:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-1042"}'),
 ('18f54000-0000-4000-8000-000000000042', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"see the attached file","invoice_number":"INV-44"}'),
 ('18f54000-0000-4000-8000-000000000062', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-9","invoice_number":"INV-44"}'),
 ('18f54000-0000-4000-8000-000000000063', '18f00000-0000-4000-8000-000000000001', 'client_email', 'client@example.test', 'Your paperwork',
  'accepted', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"invoice_number":"INV-44"}'),
 ('18f54000-0000-4000-8000-000000000064', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"INV-44"}'),
 ('18f54000-0000-4000-8000-000000000053', '18f00000-0000-4000-8000-000000000001', 'quote', 'client@example.test', 'Your paperwork',
  'accepted', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"document_id":"18f00000-0000-4000-8000-000000000303"}');

INSERT INTO public.communications_log (id, has_attachments, document_id, business_event_id, created_at) VALUES
 ('18f56000-0000-4000-8000-000000000050', true, '18f00000-0000-4000-8000-000000000306', '18f51000-0000-4000-8000-000000000050', '2026-10-01 00:00Z'),
 ('18f56000-0000-4000-8000-000000000051', true, '18f00000-0000-4000-8000-000000000302', '18f51000-0000-4000-8000-000000000051', '2026-10-18 01:00Z'),
 ('18f56000-0000-4000-8000-000000000052', true, '18f00000-0000-4000-8000-000000000302', '18f51000-0000-4000-8000-000000000052', NULL),
 ('18f56000-0000-4000-8000-000000000054', true, '18f00000-0000-4000-8000-000000000304', '18f51000-0000-4000-8000-000000000054', '2026-10-01 00:00Z'),
 ('18f56000-0000-4000-8000-000000000055', true, '18f00000-0000-4000-8000-000000000302', '18f51000-0000-4000-8000-000000000055', '2026-10-01 00:00Z');

SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-0000000000a1', '18f00000-0000-4000-8000-000000000001',
 'Whitespace supplier.', '2026-10-01 02:01Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000901"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-0000000000a2', '18f00000-0000-4000-8000-000000000001',
 'Whitespace event type.', '2026-10-01 02:02Z', '{"job_event_id":"18f52000-0000-4000-8000-000000000801"}');

SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000001', '18f00000-0000-4000-8000-000000000001',
 'Cross job bill.', '2026-10-01 03:01Z',
 '{"related_entities":[{"type":"xero_invoice","id":"18f00000-0000-4000-8000-000000000103"}]}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000002', '18f00000-0000-4000-8000-000000000001',
 'Cross job document.', '2026-10-01 03:02Z',
 '{"related_entities":[{"type":"job_document","id":"18f00000-0000-4000-8000-000000000306"}]}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000003', '18f00000-0000-4000-8000-000000000001',
 'Other job event.', '2026-10-01 03:03Z', '{"job_event_id":"18f52000-0000-4000-8000-000000000003"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000004', '18f00000-0000-4000-8000-000000000001',
 'Reverse event on the other job.', '2026-10-01 03:04Z');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000005', '18f00000-0000-4000-8000-000000000001',
 'Reverse mail on the other job.', '2026-10-01 03:05Z');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000006', '18f00000-0000-4000-8000-000000000001',
 'Voided bill.', '2026-10-01 03:06Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000906"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000007', '18f00000-0000-4000-8000-000000000001',
 'Deleted bill.', '2026-10-01 03:07Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000907"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000008', '18f00000-0000-4000-8000-000000000001',
 'Authorised bill.', '2026-10-01 03:08Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000908"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000009', '18f00000-0000-4000-8000-000000000001',
 'Payable credit.', '2026-10-01 03:09Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000909"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000010', '18f00000-0000-4000-8000-000000000001',
 'Receivable credit.', '2026-10-01 03:10Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000910"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000012', '18f00000-0000-4000-8000-000000000001',
 'Voided twin.', '2026-10-01 03:12Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000925"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000013', '18f00000-0000-4000-8000-000000000001',
 'Token on the other job.', '2026-10-01 03:13Z', '{"xero_invoice_id":"xero-lpr-other-job"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000014', '18f00000-0000-4000-8000-000000000001',
 'Bounced mail.', '2026-10-01 03:14Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000014"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000015', '18f00000-0000-4000-8000-000000000001',
 'Complained mail.', '2026-10-01 03:15Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000015"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000016', '18f00000-0000-4000-8000-000000000001',
 'Queued mail.', '2026-10-01 03:16Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000016"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000017', '18f00000-0000-4000-8000-000000000001',
 'Opened mail.', '2026-10-01 03:17Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000017"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000018', '18f00000-0000-4000-8000-000000000001',
 'Unsent mail.', '2026-10-01 03:18Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000018"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000019', '18f00000-0000-4000-8000-000000000001',
 'Mail after the reading.', '2026-10-01 03:19Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000019"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000020', '18f00000-0000-4000-8000-000000000001',
 'Event after the reading.', '2026-10-01 03:20Z', '{"job_event_id":"18f52000-0000-4000-8000-000000000020"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000021', '18f00000-0000-4000-8000-000000000001',
 'Spaces in the event type.', '2026-10-01 03:21Z', '{"job_event_id":"18f52000-0000-4000-8000-000000000021"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000022', '18f00000-0000-4000-8000-000000000001',
 'NBSP supplier.', '2026-10-01 03:22Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000922"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000023', '18f00000-0000-4000-8000-000000000001',
 'Tab supplier.', '2026-10-01 03:23Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000923"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000024', '18f00000-0000-4000-8000-000000000001',
 'Newline supplier.', '2026-10-01 03:24Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000924"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000025', '18f00000-0000-4000-8000-000000000001',
 'Tab event type.', '2026-10-01 03:25Z', '{"job_event_id":"18f52000-0000-4000-8000-000000000025"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000026', '18f00000-0000-4000-8000-000000000001',
 'The only id is in the words 18f00000-0000-4000-8000-000000000101.', '2026-10-01 03:26Z');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000027', '18f00000-0000-4000-8000-000000000001',
 'Related entities is a string.', '2026-10-01 03:27Z',
 '{"related_entities":"18f00000-0000-4000-8000-000000000101"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000028', '18f00000-0000-4000-8000-000000000001',
 'Related entities is an object.', '2026-10-01 03:28Z',
 '{"related_entities":{"type":"xero_invoice","id":"18f00000-0000-4000-8000-000000000101"}}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000029', '18f00000-0000-4000-8000-000000000001',
 'Type bill is not an invoice.', '2026-10-01 03:29Z',
 '{"related_entities":[{"type":"bill","id":"18f00000-0000-4000-8000-000000000101"}]}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000030', '18f00000-0000-4000-8000-000000000001',
 'Invoice id is an array.', '2026-10-01 03:30Z',
 '{"xero_invoice_id":["18f00000-0000-4000-8000-000000000101"]}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000031', '18f00000-0000-4000-8000-000000000001',
 'A token is not SQL.', '2026-10-01 03:31Z',
 $tok${"xero_invoice_id":"'; DROP TABLE public.jobs; --"}$tok$);
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000032', '18f00000-0000-4000-8000-000000000001',
 'This quote only.', '2026-10-01 03:32Z', '{"document_id":"18f00000-0000-4000-8000-000000000301"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000033', '18f00000-0000-4000-8000-000000000001',
 'Lower case paid.', '2026-10-01 03:33Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000933"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000034', '18f00000-0000-4000-8000-000000000001',
 'Unsent file.', '2026-10-01 03:34Z', '{"document_id":"18f00000-0000-4000-8000-000000000302"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000035', '18f00000-0000-4000-8000-000000000001',
 'Current quote.', '2026-10-01 03:35Z', '{"document_id":"18f00000-0000-4000-8000-000000000301"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000036', '18f00000-0000-4000-8000-000000000001',
 'Perth paid day.', '2026-10-01 03:36Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000936"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000038', '18f00000-0000-4000-8000-000000000001',
 'Four pointers, one bill.', '2026-10-01 03:38Z',
 '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000101","related_entities":[{"type":"xero_invoice","id":"18f00000-0000-4000-8000-000000000101"}]}',
 '{"xero_invoice_id":"18f00000-0000-4000-8000-000000000101"}',
 'xero_invoices', '18f00000-0000-4000-8000-000000000101');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000039', '18f00000-0000-4000-8000-000000000001',
 'Prose that mentions a number.', '2026-10-01 03:39Z', '{"xero_invoice_id":"TAX INVOICE 1307"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000040', '18f00000-0000-4000-8000-000000000001',
 'Paid receivable with no number.', '2026-10-01 03:40Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000940"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000041', '18f00000-0000-4000-8000-000000000001',
 'A bill that carries an invoice number.', '2026-10-01 03:41Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000941"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000042', '18f00000-0000-4000-8000-000000000001',
 'Quote mail with an invoice number.', '2026-10-01 03:42Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000042"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000062', '18f00000-0000-4000-8000-000000000001',
 'Quote mail keeps its quote.', '2026-10-01 03:42Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000062"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000063', '18f00000-0000-4000-8000-000000000001',
 'Client mail may name an invoice.', '2026-10-01 03:42Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000063"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000064', '18f00000-0000-4000-8000-000000000001',
 'Quote number that is an invoice key.', '2026-10-01 03:42Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000064"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000043', '18f00000-0000-4000-8000-000000000001',
 'Paid and still owing.', '2026-10-01 03:43Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000943"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000044', '18f00000-0000-4000-8000-000000000001',
 'Paid with no paid date.', '2026-10-01 03:44Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000944"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000045', '18f00000-0000-4000-8000-000000000001',
 'Sent at the reading.', '2026-10-01 03:45Z', '{"document_id":"18f53000-0000-4000-8000-000000000045"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000046', '18f00000-0000-4000-8000-000000000001',
 'Sent a second later.', '2026-10-01 03:46Z', '{"document_id":"18f53000-0000-4000-8000-000000000046"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000047', '18f00000-0000-4000-8000-000000000001',
 'Padded uuid.', '2026-10-01 03:47Z',
 '{"xero_invoice_id":"  18F50000-0000-4000-8000-000000000939  "}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000048', '18f00000-0000-4000-8000-000000000001',
 'Prose invoice on a booking.', '2026-10-01 03:48Z', '{"job_event_id":"18f52000-0000-4000-8000-000000000048"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000049', '18f00000-0000-4000-8000-000000000001',
 'Mixed related entities.', '2026-10-01 03:49Z',
 '{"related_entities":[{"type":"xero_invoice","id":"18f00000-0000-4000-8000-000000000103"},{"type":"xero_invoice","id":"18f00000-0000-4000-8000-000000000101"}]}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000050', '18f00000-0000-4000-8000-000000000001',
 'Attachment on the other job.', '2026-10-01 03:50Z');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000051', '18f00000-0000-4000-8000-000000000001',
 'Attachment after the reading.', '2026-10-01 03:51Z');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000052', '18f00000-0000-4000-8000-000000000001',
 'Attachment with no time.', '2026-10-01 03:52Z');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000053', '18f00000-0000-4000-8000-000000000001',
 'Mail cites an unsent quote.', '2026-10-01 03:53Z', '{"email_event_id":"18f54000-0000-4000-8000-000000000053"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000054', '18f00000-0000-4000-8000-000000000001',
 'Attachment with prose for a number.', '2026-10-01 03:54Z');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000055', '18f00000-0000-4000-8000-000000000001',
 'Attachment cites the file.', '2026-10-01 03:55Z');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000059', '18f00000-0000-4000-8000-000000000001',
 'Padded supplier.', '2026-10-01 03:59Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000959"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000060', '18f00000-0000-4000-8000-000000000001',
 'Padded event type.', '2026-10-01 04:00Z', '{"job_event_id":"18f52000-0000-4000-8000-000000000060"}');
SELECT pg_temp.lpr_ev('18f51000-0000-4000-8000-000000000061', '18f00000-0000-4000-8000-000000000001',
 'Ten digit total.', '2026-10-01 04:01Z', '{"xero_invoice_id":"18f50000-0000-4000-8000-000000000961"}');

DO $ws$
DECLARE
 chars text[];
 ch text;
 nch int := 0;
 got jsonb;
 j1 text := '18f00000-0000-4000-8000-000000000001';
 ev_sup uuid := '18f51000-0000-4000-8000-0000000000a1';
 ev_type uuid := '18f51000-0000-4000-8000-0000000000a2';
 inv uuid := '18f50000-0000-4000-8000-000000000901';
 je uuid := '18f52000-0000-4000-8000-000000000801';
 want_sup jsonb;
 want_type jsonb;
BEGIN
 chars := ARRAY[
  chr(9), chr(10), chr(11), chr(12), chr(13), ' ',
  U&'\00A0', U&'\1680',
  U&'\2000', U&'\2001', U&'\2002', U&'\2003', U&'\2004',
  U&'\2005', U&'\2006', U&'\2007', U&'\2008', U&'\2009', U&'\200A',
  U&'\2028', U&'\2029', U&'\202F', U&'\205F', U&'\3000', U&'\FEFF'];
 IF coalesce(array_length(chars, 1), 0) <> 25 THEN
  RAISE EXCEPTION 'ledger packet records contract: whitespace class length %', coalesce(array_length(chars, 1), 0);
 END IF;
 want_sup := jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id', inv::text, 'job_id', j1,
  'supplier','Acme','amount','15.00'));
 want_type := jsonb_build_array(jsonb_build_object(
  'kind','job_event','table','job_events','id', je::text, 'job_id', j1,
  'event_type','booking_set','about','booking:2026-10-02'));
 FOREACH ch IN ARRAY chars LOOP
  nch := nch + 1;
  UPDATE public.xero_invoices SET contact_name = ch WHERE id = inv;
  got := pg_temp.lpr_links(ev_sup);
  PERFORM pg_temp.lpr_assert(got IS NULL, 'whitespace only supplier ' || nch || ' ' || coalesce(got::text, ''));
  UPDATE public.xero_invoices SET contact_name = ch || 'Acme' || ch WHERE id = inv;
  got := pg_temp.lpr_links(ev_sup);
  PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM want_sup, 'whitespace padded supplier ' || nch || ' ' || coalesce(got::text, '<none>'));
  UPDATE public.job_events SET event_type = ch WHERE id = je;
  got := pg_temp.lpr_links(ev_type);
  PERFORM pg_temp.lpr_assert(got IS NULL, 'whitespace only event_type ' || nch || ' ' || coalesce(got::text, ''));
  UPDATE public.job_events SET event_type = ch || 'booking_set' || ch WHERE id = je;
  got := pg_temp.lpr_links(ev_type);
  PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM want_type, 'whitespace padded event_type ' || nch || ' ' || coalesce(got::text, '<none>'));
 END LOOP;
 UPDATE public.xero_invoices SET contact_name = U&'\200B' WHERE id = inv;
 got := pg_temp.lpr_links(ev_sup);
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id', inv::text, 'job_id', j1,
  'supplier', U&'\200B', 'amount','15.00')), 'zwsp supplier kept ' || coalesce(got::text, '<none>'));
 RAISE NOTICE 'ledger packet records whitespace trim checks: %', nch * 4 + 1;
END $ws$;

DO $rev$
DECLARE
 j1 text := '18f00000-0000-4000-8000-000000000001';
 sn int := 0;
 got jsonb;
 pkt jsonb;
 held_row jsonb;
 rowj jsonb;
 none uuid;
BEGIN
 -- 1 to 10, 13 to 31, 34, 39, 40, 46, 50 to 52, 54: no records.
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000001') IS NULL, '1 cross job bill');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000002') IS NULL, '2 cross job document');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000003') IS NULL, '3 other job event');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000004') IS NULL, '4 reverse event other job');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000005') IS NULL, '5 reverse mail other job');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000006') IS NULL, '6 voided');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000007') IS NULL, '7 deleted');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000008') IS NULL, '8 authorised');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000009') IS NULL, '9 payable credit');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000010') IS NULL, '10 receivable credit');
 sn := sn + 1;

 -- 11. The same org cannot store two rows with one Xero id.
 BEGIN
  INSERT INTO public.xero_invoices (id, org_id, job_id, xero_invoice_id, contact_name, invoice_type, status,
   total, fully_paid_on, created_at, line_items) VALUES
   ('18f50000-0000-4000-8000-000000000971', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
    'xero-lpr-dup-same', 'Dup One', 'ACCPAY', 'PAID', 15, '2026-10-01', '2026-10-01 00:00Z', '[]'),
   ('18f50000-0000-4000-8000-000000000972', '00000000-0000-4000-8000-0000000000aa', '18f00000-0000-4000-8000-000000000001',
    'xero-lpr-dup-same', 'Dup Two', 'ACCPAY', 'PAID', 15, '2026-10-01', '2026-10-01 00:00Z', '[]');
  PERFORM pg_temp.lpr_assert(false, '11 duplicate xero id accepted');
 EXCEPTION WHEN unique_violation THEN
  PERFORM pg_temp.lpr_assert(true, '11 duplicate xero id');
 END;
 sn := sn + 1;

 -- 12. A voided twin shares the paid row's id as its token and must not silence it.
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000012');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000925','job_id', j1,
  'supplier','Twin Metals','amount','33.00')), '12 voided twin ' || coalesce(got::text, '<none>'));
 sn := sn + 1;

 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000013') IS NULL, '13 token on the other job');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000014') IS NULL, '14 bounced');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000015') IS NULL, '15 complained');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000016') IS NULL, '16 queued');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000017') IS NULL, '17 opened');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000018') IS NULL, '18 sent_at null');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000019') IS NULL, '19 sent after');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000020') IS NULL, '20 event after');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000021') IS NULL, '21 spaces event type');
 sn := sn + 1;

 UPDATE public.xero_invoices SET contact_name = U&'\00A0' WHERE id = '18f50000-0000-4000-8000-000000000922';
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000022') IS NULL, '22 nbsp supplier');
 sn := sn + 1;
 UPDATE public.xero_invoices SET contact_name = chr(9) WHERE id = '18f50000-0000-4000-8000-000000000923';
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000023') IS NULL, '23 tab supplier');
 sn := sn + 1;
 UPDATE public.xero_invoices SET contact_name = chr(10) WHERE id = '18f50000-0000-4000-8000-000000000924';
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000024') IS NULL, '24 newline supplier');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000025') IS NULL, '25 tab event type');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000026') IS NULL, '26 uuid in the words');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000027') IS NULL, '27 related string');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000028') IS NULL, '28 related object');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000029') IS NULL, '29 type bill');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000030') IS NULL, '30 invoice id array');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000031') IS NULL
  AND to_regclass('public.jobs') IS NOT NULL, '31 sql token');
 sn := sn + 1;

 -- 32. A pointer at Q-9 does not also cite the sent Q-100 beside it.
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000032');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','sent_document','table','job_documents','id','18f00000-0000-4000-8000-000000000301','job_id', j1,
  'about','quote:q-9')) AND got::text NOT LIKE '%q-100%' AND got::text NOT LIKE '%000000000100%',
  '32 q-9 also cited q-100 ' || coalesce(got::text, '<none>'));
 sn := sn + 1;

 -- 33. paid, Paid, and NBSP-padded paid all emit.
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000033');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000933','job_id', j1,
  'supplier','Case Metals','amount','19.00')), '33 lower paid ' || coalesce(got::text, '<none>'));
 UPDATE public.xero_invoices SET status = 'Paid' WHERE id = '18f50000-0000-4000-8000-000000000933';
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000033');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000933','job_id', j1,
  'supplier','Case Metals','amount','19.00')), '33 mixed paid ' || coalesce(got::text, '<none>'));
 UPDATE public.xero_invoices SET status = U&' paid\00A0' WHERE id = '18f50000-0000-4000-8000-000000000933';
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000033');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000933','job_id', j1,
  'supplier','Case Metals','amount','19.00')), '33 padded paid ' || coalesce(got::text, '<none>'));
 sn := sn + 1;

 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000034') IS NULL, '34 unsent borrowed');
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000035');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','sent_document','table','job_documents','id','18f00000-0000-4000-8000-000000000301','job_id', j1,
  'about','quote:q-9')), '35 current quote ' || coalesce(got::text, '<none>'));
 sn := sn + 1;

 -- 36 and 37. fully_paid_on is a Perth date. 17 Oct 15:30Z is still the 17th; 16:30Z is the 18th.
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000036', '2026-10-17 15:30:00+00') IS NULL,
  '36 perth day not yet');
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000036', '2026-10-17 16:30:00+00');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000936','job_id', j1,
  'supplier','Perth Metals','amount','40.00')), '37 perth day ' || coalesce(got::text, '<none>'));
 sn := sn + 1;

 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000038');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f00000-0000-4000-8000-000000000101','job_id', j1,
  'supplier','Other Metals','amount','90.00')) AND jsonb_array_length(got) = 1,
  '38 four pointers ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000039') IS NULL, '39 prose tax invoice');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000040') IS NULL, '40 receivable without a number');
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000041');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000941','job_id', j1,
  'supplier','Only Bill','amount','9.00')) AND NOT (got->0 ? 'number') AND got::text NOT LIKE '%paid_invoice%',
  '41 bill with invoice number ' || coalesce(got::text, '<none>'));
 sn := sn + 1;

 -- 42. A quote email does not carry an invoice about-key. A later quote key still wins.
 -- A client email may still name an invoice. Those two are the same scenario's extras.
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000042') IS NULL, '42 quote mail carried an invoice');
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000064') IS NULL, '42 quote number was an invoice key');
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000062');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','system_email','table','email_events','id','18f54000-0000-4000-8000-000000000062','job_id', j1,
  'email_type','quote','status','sent','about','quote:q-9','system', true)),
  '42 quote kept ' || coalesce(got::text, '<none>'));
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000063');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','system_email','table','email_events','id','18f54000-0000-4000-8000-000000000063','job_id', j1,
  'email_type','client_email','status','accepted','about','invoice:inv-44','system', true)),
  '42 client invoice ' || coalesce(got::text, '<none>'));
 sn := sn + 1;

 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000043');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000943','job_id', j1,
  'supplier','Owing Metals','amount','50.00')), '43 still owing ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000044');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000944','job_id', j1,
  'supplier','Null Paid','amount','44.00')), '44 null paid date ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000045');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','sent_document','table','job_documents','id','18f53000-0000-4000-8000-000000000045','job_id', j1,
  'about','quote:q-45')), '45 sent at as_of ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000046') IS NULL, '46 sent a second later');
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000047');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000939','job_id', j1,
  'supplier','Padded Metals','amount','39.00')), '47 padded uuid ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000048');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','job_event','table','job_events','id','18f52000-0000-4000-8000-000000000048','job_id', j1,
  'event_type','booking_set','about','booking:2026-10-02')), '48 prose invoice ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000049');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f00000-0000-4000-8000-000000000101','job_id', j1,
  'supplier','Other Metals','amount','90.00')), '49 mixed related ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000050') IS NULL, '50 attachment other job');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000051') IS NULL, '51 attachment after');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000052') IS NULL, '52 attachment no time');
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000053');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','system_email','table','email_events','id','18f54000-0000-4000-8000-000000000053','job_id', j1,
  'email_type','quote','status','accepted','about','quote:q-55','system', true)),
  '53 unsent document cited ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f51000-0000-4000-8000-000000000054') IS NULL, '54 attachment prose');
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000055');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','attachment','table','job_documents','id','18f56000-0000-4000-8000-000000000055','job_id', j1,
  'document_id','18f00000-0000-4000-8000-000000000302','about','quote:q-77')),
  '55 attachment ' || coalesce(got::text, '<none>'));
 sn := sn + 1;

 pkt := public.context_ledger_packet('18f00000-0000-4000-8000-000000000001', NULL, '2026-10-18 00:00Z');
 SELECT e INTO held_row FROM jsonb_array_elements(pkt->'held'->'rows') e
  WHERE e->>'id' = '18f10000-0000-4000-8000-000000000022';
 PERFORM pg_temp.lpr_assert(held_row IS NOT NULL AND NOT (held_row ? 'records')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f10000-0000-4000-8000-000000000022'),
  '56 held row');
 sn := sn + 1;
 SELECT e INTO rowj FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f20000-0000-4000-8000-000000000001';
 PERFORM pg_temp.lpr_assert(rowj IS NOT NULL AND NOT (rowj ? 'records'), '57 inbox body');
 sn := sn + 1;
 PERFORM pg_temp.lpr_assert(pkt->>'version' = 'ledger-packet-v1' AND NOT (pkt ? 'records'), '58 packet version');
 sn := sn + 1;

 UPDATE public.xero_invoices SET contact_name = U&'\00A0Acme\0009' WHERE id = '18f50000-0000-4000-8000-000000000959';
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000059');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000959','job_id', j1,
  'supplier','Acme','amount','21.00')), '59 trimmed supplier ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 UPDATE public.job_events SET event_type = U&'\000Abooking_set\0009' WHERE id = '18f52000-0000-4000-8000-000000000060';
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000060');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','job_event','table','job_events','id','18f52000-0000-4000-8000-000000000060','job_id', j1,
  'event_type','booking_set','about','booking:2026-10-02')), '60 trimmed event type ' || coalesce(got::text, '<none>'));
 sn := sn + 1;
 got := pg_temp.lpr_links('18f51000-0000-4000-8000-000000000061');
 PERFORM pg_temp.lpr_assert(got IS NOT DISTINCT FROM jsonb_build_array(jsonb_build_object(
  'kind','paid_bill','table','xero_invoices','id','18f50000-0000-4000-8000-000000000961','job_id', j1,
  'supplier','Big Metals','amount','1000000000.50')) AND position('#' IN got::text) = 0,
  '61 ten digit amount ' || coalesce(got::text, '<none>'));
 sn := sn + 1;

 IF sn <> 61 THEN
  RAISE EXCEPTION 'ledger packet records contract: review scenario count %', sn;
 END IF;

 -- The original proof rows are unchanged by the hunt.
 got := pg_temp.lpr_links('18f10000-0000-4000-8000-000000000002');
 PERFORM pg_temp.lpr_assert(jsonb_array_length(got) = 6, 'original full link count ' || coalesce(jsonb_array_length(got)::text, '<none>'));
 PERFORM pg_temp.lpr_assert(pg_temp.lpr_links('18f10000-0000-4000-8000-000000000019') IS NULL, 'draft twin started emitting');
 RAISE NOTICE 'ledger packet records review scenarios: %', sn;
END $rev$;
