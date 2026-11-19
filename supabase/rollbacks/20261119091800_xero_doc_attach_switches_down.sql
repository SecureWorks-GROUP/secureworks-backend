-- Down for 20261119091800_xero_doc_attach_switches.sql.
-- A switch someone turned on is left in place. The attachment table goes with this migration.
DELETE FROM public.feature_flags
WHERE flag_name IN (
  'xero_bank_txn_receipt_attach_v1',
  'xero_credit_note_pdf_attach_v1'
)
AND enabled = false;

DROP TABLE IF EXISTS public.xero_document_attachments;
