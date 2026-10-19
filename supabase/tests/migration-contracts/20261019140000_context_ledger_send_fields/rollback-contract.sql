-- After the down migration the record-link function is the 20261018120000 body
-- again, the four helpers are gone, and a system email does not carry to_address.
DO $shape$
DECLARE note text; src text;
BEGIN
 IF to_regprocedure('public.context_ledger_record_email(text)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_record_contact(text)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_record_xero_date(text)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_record_invoice_money(text,text,text,numeric,numeric,numeric,jsonb)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_record_send_recipient(text,text,jsonb)') IS NOT NULL THEN
  RAISE EXCEPTION 'ledger send fields rollback: a helper is still there';
 END IF;
 note := coalesce(obj_description(to_regprocedure('public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)'), 'pg_proc'), '');
 IF note NOT LIKE 'Ledger packet records (20261018120000)%'
  OR note LIKE '%Send recipient fields (20261019140000)%' THEN
  RAISE EXCEPTION 'ledger send fields rollback: record links comment %', note;
 END IF;
 SELECT p.prosrc INTO src FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.context_ledger_evidence_record_links(uuid,timestamptz,jsonb)');
 IF src LIKE '%context_ledger_record_email%' THEN
  RAISE EXCEPTION 'ledger send fields rollback: record links still copies an address';
 END IF;
 IF EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'email_events' AND column_name = 'to_address')
  OR EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'job_events' AND column_name IN ('to_address', 'payment_amount')) THEN
  RAISE EXCEPTION 'ledger send fields rollback: a recipient or payment column is still there';
 END IF;
 IF to_regprocedure('public.context_ledger_packet(uuid,timestamptz,timestamptz)') IS NULL THEN
  RAISE EXCEPTION 'ledger send fields rollback: packet function missing';
 END IF;
END $shape$;

BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.email_events ADD COLUMN IF NOT EXISTS sender text;

INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
VALUES ('19f30000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'scheduled', 'fencing', 'SWF-LSF19F3',
 'Robin Ledger', 'rollback@example.test', 'lsf-ct-3', 'Testville', '{}', '2026-09-01 00:00Z');

INSERT INTO public.email_events (id, job_id, email_type, recipient, sender, subject, status, sent_at, created_at, metadata)
VALUES ('19f30000-0000-4000-8000-000000000401', '19f30000-0000-4000-8000-000000000001', 'quote', 'client@example.test',
 'orders@secureworks.test', 'Your paperwork', 'sent', '2026-10-01 00:00Z', '2026-10-01 00:00Z', '{"quote_number":"Q-19"}');

INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id,
 payload, metadata, occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step,
 attribution_confidence, attributed_at, match_method)
VALUES ('19f30000-0000-4000-8000-000000000002', '19f30000-0000-4000-8000-000000000001', 'client.sms_in', 'ledger_contract',
 'sms', 'inbound', 'lsf-ct-3', 'lsf:rollback-1',
 '{"body":"Please send the paperwork.","email_event_id":"19f30000-0000-4000-8000-000000000401"}',
 '{"written_as":"service_role"}',
 '2026-10-01 00:02Z', '2026-10-01 00:02Z', '2026-10-01 00:02Z', '2026-10-01 00:02Z', 'direct', 1, 1, '2026-10-01 00:02Z', 'direct_job_id');

DO $proof$
DECLARE got jsonb;
BEGIN
 SELECT l.records->0 INTO got
 FROM public.context_ledger_evidence_record_links(
  '19f30000-0000-4000-8000-000000000001', '2026-10-18 00:00Z',
  jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', '19f30000-0000-4000-8000-000000000002'))) l;
 IF got->>'kind' IS DISTINCT FROM 'system_email' OR (got ? 'to_address') OR (got ? 'recipient') OR (got ? 'contact_id') THEN
  RAISE EXCEPTION 'ledger send fields rollback: system email still carries a recipient %', coalesce(got::text, '<none>');
 END IF;
END $proof$;

ROLLBACK;
