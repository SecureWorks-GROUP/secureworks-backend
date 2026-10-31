-- After the down migration the packet is the 20261015100000 body again and a
-- worded row that names a paid bill carries no records key.
DO $shape$
DECLARE live text; c text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)');
 IF live IS DISTINCT FROM 'e2ccc5450117a4e36b30df104752d1cd' THEN
  RAISE EXCEPTION 'ledger packet records rollback: packet md5 %', live;
 END IF;
 c := coalesce(obj_description(to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)'), 'pg_proc'), '');
 IF c NOT LIKE '% Held notes (20261015100000): %' OR c LIKE '%Ledger packet records (20261018120000)%' THEN
  RAISE EXCEPTION 'ledger packet records rollback: packet comment';
 END IF;
 IF to_regprocedure('public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_comm_log_links(uuid,timestamptz,jsonb)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_record_link_about(text)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_record_invoice_about(text)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_record_uuid(text)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_record_trim(text)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_record_money(numeric)') IS NOT NULL THEN
  RAISE EXCEPTION 'ledger packet records rollback: a helper is still there';
 END IF;
 IF to_regclass('public.communications_log_ledger_business_event_idx') IS NOT NULL
  OR to_regclass('public.communications_log_ledger_inbox_event_idx') IS NOT NULL THEN
  RAISE EXCEPTION 'ledger packet records rollback: a communications_log index is still there';
 END IF;
END $shape$;

BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
VALUES ('18f30000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'scheduled', 'fencing', 'SWF-LPR18F3',
 'Robin Ledger', 'rollback@example.test', 'lpr-ct-3', 'Testville', '{}', '2026-09-01 00:00Z');
INSERT INTO public.xero_invoices (id, org_id, job_id, xero_invoice_id, contact_name, invoice_type, status, total, fully_paid_on, created_at, line_items)
VALUES ('18f30000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000aa', '18f30000-0000-4000-8000-000000000001',
 'xero-lpr-rollback-bill', 'Rollback Metals', 'ACCPAY', 'PAID', 90, '2026-10-01', '2026-10-01 00:00Z', '[]');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id,
 payload, metadata, occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step,
 attribution_confidence, attributed_at, match_method)
VALUES ('18f30000-0000-4000-8000-000000000002', '18f30000-0000-4000-8000-000000000001', 'client.sms_in', 'ledger_contract',
 'sms', 'inbound', 'lpr-ct-3', 'lpr:rollback-1',
 '{"body":"Please pay the deposit.","xero_invoice_id":"18f30000-0000-4000-8000-000000000101"}',
 '{"written_as":"service_role"}',
 '2026-10-01 00:02Z', '2026-10-01 00:02Z', '2026-10-01 00:02Z', '2026-10-01 00:02Z', 'direct', 1, 1, '2026-10-01 00:02Z', 'direct_job_id');
DO $proof$
DECLARE pkt jsonb; rowj jsonb;
BEGIN
 pkt := public.context_ledger_packet('18f30000-0000-4000-8000-000000000001', NULL, '2026-10-18 00:00Z');
 SELECT e INTO rowj FROM jsonb_array_elements(pkt->'evidence') e WHERE e->>'id' = '18f30000-0000-4000-8000-000000000002';
 IF pkt->>'version' IS DISTINCT FROM 'ledger-packet-v1' OR rowj IS NULL OR (rowj ? 'records') OR (pkt ? 'records') THEN
  RAISE EXCEPTION 'ledger packet records rollback: worded row still carries records %', coalesce(rowj::text, '<missing>');
 END IF;
END $proof$;
ROLLBACK;
