-- Both switches stay off, browser roles cannot read the audit table, and one attached sha cannot be stored twice.
BEGIN;
DO $$
DECLARE
  org uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  entity uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  sha text := repeat('ab', 32);
BEGIN
  IF (
    SELECT count(*) FROM public.feature_flags
    WHERE flag_name IN ('xero_bank_txn_receipt_attach_v1', 'xero_credit_note_pdf_attach_v1')
      AND enabled IS FALSE
  ) <> 2 THEN
    RAISE EXCEPTION 'xero doc attach switches: expected both switches off';
  END IF;
  IF NOT (
    SELECT relrowsecurity FROM pg_class WHERE oid = 'public.xero_document_attachments'::regclass
  ) THEN
    RAISE EXCEPTION 'xero doc attach switches: RLS is off';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'xero_document_attachments'
  ) THEN
    RAISE EXCEPTION 'xero doc attach switches: a policy was added';
  END IF;
  IF has_table_privilege('anon', 'public.xero_document_attachments', 'SELECT')
     OR has_table_privilege('authenticated', 'public.xero_document_attachments', 'INSERT') THEN
    RAISE EXCEPTION 'xero doc attach switches: browser role has access';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.xero_document_attachments', 'SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'xero doc attach switches: service role lacks access';
  END IF;
  INSERT INTO public.xero_document_attachments
    (org_id, xero_entity_type, xero_entity_id, file_sha256, file_name, content_type, byte_size, status)
  VALUES (org, 'BankTransactions', entity, sha, 'ZZTEST.webp', 'image/webp', 12, 'attached');
  BEGIN
    INSERT INTO public.xero_document_attachments
      (org_id, xero_entity_type, xero_entity_id, file_sha256, file_name, content_type, byte_size, status)
    VALUES (org, 'BankTransactions', entity, sha, 'ZZTEST.webp', 'image/webp', 12, 'attached');
    RAISE EXCEPTION 'duplicate attachment was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  INSERT INTO public.xero_document_attachments
    (org_id, xero_entity_type, xero_entity_id, file_sha256, file_name, content_type, byte_size, status)
  VALUES (org, 'CreditNotes', entity, sha, 'ZZTEST.pdf', 'application/pdf', 20, 'failed');
END $$;
ROLLBACK;

\ir ../../../migrations/20261119091800_xero_doc_attach_switches.sql

BEGIN;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'xero_credit_note_pdf_attach_v1';
\ir ../../../migrations/20261119091800_xero_doc_attach_switches.sql
DO $$ BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'xero_credit_note_pdf_attach_v1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'xero doc attach switches: a re-apply changed an existing on row';
  END IF;
END $$;
ROLLBACK;
