-- Supplier bill PDF findings (job number, PO, delivery address). The PDF text
-- itself is never stored. The switch ships off: the reader makes no Xero call
-- and no write until a person turns it on.
-- A same-named table that is not this shape fails the guard below. A re-apply
-- leaves an existing switch row as it is (ON CONFLICT DO NOTHING).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.xero_bill_attachment_reads (
  org_id uuid NOT NULL,
  xero_invoice_id text NOT NULL,
  attachment_id text NOT NULL,
  source text NOT NULL,
  file_name text,
  mime_type text,
  content_length integer,
  state text NOT NULL,
  text_sha256 text,
  text_chars integer,
  job_numbers text[] NOT NULL DEFAULT '{}',
  po_numbers text[] NOT NULL DEFAULT '{}',
  order_ref text,
  delivery_address text,
  read_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  PRIMARY KEY (org_id, attachment_id),
  CONSTRAINT xero_bill_attachment_reads_source_check CHECK (source IN ('xero', 'email')),
  CONSTRAINT xero_bill_attachment_reads_state_check CHECK (
    state IN ('listed', 'text_read', 'no_text', 'too_large', 'unsupported', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS xero_bill_attachment_reads_invoice_idx
  ON public.xero_bill_attachment_reads (org_id, xero_invoice_id);

ALTER TABLE public.xero_bill_attachment_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xero_bill_attachment_reads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.xero_bill_attachment_reads TO service_role;
DROP POLICY IF EXISTS xero_bill_attachment_reads_service ON public.xero_bill_attachment_reads;
CREATE POLICY xero_bill_attachment_reads_service
  ON public.xero_bill_attachment_reads
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DO $$ BEGIN
  IF to_regclass('public.xero_bill_attachment_reads') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.xero_bill_attachment_reads'::regclass
        AND conname = 'xero_bill_attachment_reads_pkey'
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.xero_bill_attachment_reads'::regclass
        AND conname = 'xero_bill_attachment_reads_state_check'
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.xero_bill_attachment_reads'::regclass
        AND conname = 'xero_bill_attachment_reads_source_check'
    )
    OR to_regclass('public.xero_bill_attachment_reads_invoice_idx') IS NULL THEN
    RAISE EXCEPTION 'xero_bill_attachment_reads shape';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES (
  'xero_bill_attachment_read_v1',
  false,
  'Read supplier bill PDFs for job number, PO and delivery address, and feed those findings to the matcher as proposals. Off: no Xero call and no write (20261119091400).'
)
ON CONFLICT (flag_name) DO NOTHING;
