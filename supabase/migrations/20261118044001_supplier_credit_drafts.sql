-- P3-02.1: unused private proposal store. No ingest, trigger, timer or Xero write.
CREATE TABLE IF NOT EXISTS public.supplier_credit_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  source_attachment_id uuid NULL,
  storage_bucket text,
  storage_path text,
  xero_contact_id text NULL,
  supplier_name text NOT NULL,
  credit_number text NOT NULL,
  credit_date date NULL,
  amount_ex numeric(12,2) NULL,
  amount_inc numeric(12,2) NULL,
  names_bill_number text NULL,
  matched_bill_xero_invoice_id text NULL,
  matched_job_id uuid NULL,
  match_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('proposed','drafted','dismissed','duplicate','failed')),
  xero_credit_note_id text NULL,
  drafted_by text NULL,
  drafted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_credit_drafts_xero_state_check
    CHECK ((state = 'drafted') = (xero_credit_note_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_credit_drafts_supplier_number_key
  ON public.supplier_credit_drafts(org_id, lower(supplier_name), credit_number);
COMMENT ON COLUMN public.supplier_credit_drafts.source_attachment_id IS
  'The context_email_attachments.id from which the credit was read.';
COMMENT ON COLUMN public.supplier_credit_drafts.amount_ex IS
  'Null means the document did not give it. Never 0 for unknown.';
COMMENT ON COLUMN public.supplier_credit_drafts.amount_inc IS
  'Null means the document did not give it. Never 0 for unknown.';
ALTER TABLE public.supplier_credit_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_credit_drafts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.supplier_credit_drafts TO service_role;
INSERT INTO public.feature_flags(flag_name, enabled, description)
VALUES('supplier_credit_drafts_v1', false, 'Supplier credit document proposals; no automatic Xero write')
ON CONFLICT(flag_name) DO NOTHING;
