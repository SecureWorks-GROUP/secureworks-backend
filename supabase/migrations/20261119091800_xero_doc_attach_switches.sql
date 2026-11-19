-- Credit note PDF attachment and bank transaction receipt attachment.
-- Both switches stay off. Nothing calls Xero for these attachments until a switch is turned on.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  (
    'xero_bank_txn_receipt_attach_v1',
    false,
    'Attach a receipt file to a Xero bank transaction. Off: ops-api attach_bank_transaction_receipt refuses and makes no Xero call (20261119091800).'
  ),
  (
    'xero_credit_note_pdf_attach_v1',
    false,
    'Attach the supplier credit note PDF after the DRAFT credit note is created. Off: credit note creation does not attach a file (20261119091800).'
  )
ON CONFLICT (flag_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.xero_document_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  xero_entity_type text NOT NULL CHECK (xero_entity_type IN ('Invoices', 'CreditNotes', 'BankTransactions')),
  xero_entity_id uuid NOT NULL,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  status text NOT NULL CHECK (status IN ('attached', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  attached_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS xero_document_attachments_attached_sha_uidx
  ON public.xero_document_attachments (org_id, xero_entity_type, xero_entity_id, file_sha256)
  WHERE status = 'attached';

COMMENT ON TABLE public.xero_document_attachments IS
  'Files put on a Xero document (20261119091800). One attached sha per org, entity and file. Service role only.';

ALTER TABLE public.xero_document_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.xero_document_attachments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.xero_document_attachments TO service_role;
