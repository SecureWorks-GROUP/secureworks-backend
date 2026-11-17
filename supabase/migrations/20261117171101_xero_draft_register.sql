-- P3-01.4: draft completeness and later approval observations. No backfill.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.xero_draft_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  xero_document_id text NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('ACCPAY','ACCPAYCREDIT','ACCREC')),
  source_kind text NOT NULL,
  source_id text,
  register_row text NOT NULL CHECK (register_row IN ('X3','X6','X7','X9')),
  job_ids uuid[] NOT NULL DEFAULT '{}',
  drafted_at timestamptz NOT NULL DEFAULT now(),
  lines_fingerprint text NOT NULL,
  has_account_codes boolean NOT NULL,
  has_division_tags boolean NOT NULL,
  has_job_reference boolean NOT NULL,
  has_source_document boolean NOT NULL,
  problems jsonb NOT NULL DEFAULT '[]',
  approved_seen_at timestamptz NULL,
  approved_fingerprint text NULL,
  edited_before_approval boolean NULL,
  UNIQUE (org_id, xero_document_id)
);

CREATE INDEX IF NOT EXISTS xero_draft_register_org_drafted_idx
  ON public.xero_draft_register (org_id, drafted_at DESC);

COMMENT ON COLUMN public.xero_draft_register.edited_before_approval IS
  'Null until Xero shows the document approved. Null means not known yet, never ''not edited''.';

CREATE TABLE IF NOT EXISTS public.bookkeeping_checks (
  check_name text NOT NULL,
  period_key text NOT NULL,
  value numeric NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (check_name, period_key)
);

ALTER TABLE public.xero_draft_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookkeeping_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.xero_draft_register, public.bookkeeping_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.xero_draft_register, public.bookkeeping_checks TO service_role;
