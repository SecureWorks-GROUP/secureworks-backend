DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name IN ('xero_bank_txn_receipt_attach_v1', 'xero_credit_note_pdf_attach_v1')
  ) THEN
    RAISE EXCEPTION 'xero doc attach rollback: off switch remains';
  END IF;
  IF to_regclass('public.xero_document_attachments') IS NOT NULL THEN
    RAISE EXCEPTION 'xero doc attach rollback: attachment table remains';
  END IF;
END $$;

BEGIN;
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('xero_credit_note_pdf_attach_v1', true, 'ZZTEST existing switch');
\ir ../../../rollbacks/20261119091800_xero_doc_attach_switches_down.sql
DO $$ BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'xero_credit_note_pdf_attach_v1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'xero doc attach rollback: existing on row changed';
  END IF;
END $$;
ROLLBACK;
