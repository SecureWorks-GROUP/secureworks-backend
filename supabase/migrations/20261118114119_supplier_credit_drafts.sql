SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.supplier_credit_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  source_attachment_id uuid,
  storage_bucket text,
  storage_path text,
  xero_contact_id text,
  supplier_name text NOT NULL,
  credit_number text NOT NULL,
  credit_date date,
  amount_ex numeric(12,2) CHECK (amount_ex > 0 AND amount_ex <> 'NaN'::numeric),
  amount_inc numeric(12,2) CHECK (amount_inc > 0 AND amount_inc <> 'NaN'::numeric),
  names_bill_number text,
  matched_bill_xero_invoice_id text,
  matched_job_id uuid,
  match_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('proposed','drafted','dismissed','duplicate','failed')),
  xero_credit_note_id text,
  drafted_by text,
  drafted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'drafted') = (xero_credit_note_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_credit_drafts_org_supplier_number
  ON public.supplier_credit_drafts (org_id, lower(supplier_name), credit_number);

COMMENT ON COLUMN public.supplier_credit_drafts.amount_ex IS
  'Null means the document did not give it. Never 0 for unknown.';
COMMENT ON COLUMN public.supplier_credit_drafts.amount_inc IS
  'Null means the document did not give it. Never 0 for unknown.';

ALTER TABLE public.supplier_credit_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_credit_drafts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.supplier_credit_drafts TO service_role;

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('supplier_credit_drafts_v1', false, 'Supplier credits read from documents')
ON CONFLICT (flag_name) DO NOTHING;
