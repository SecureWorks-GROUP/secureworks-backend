SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.division_tieout_cells (
  org_id uuid NOT NULL,
  month date NOT NULL,
  tracking_option text NOT NULL,
  account_code text NOT NULL,
  account_name text,
  section text,
  xero_amount numeric(14,2),
  ours_amount numeric(14,2) NOT NULL DEFAULT 0,
  difference numeric(14,2),
  listed_amount numeric(14,2) NOT NULL DEFAULT 0,
  ours_lines integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, month, tracking_option, account_code)
);

CREATE TABLE IF NOT EXISTS public.division_tieout_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  month date NOT NULL,
  tracking_option text NOT NULL,
  account_code text NOT NULL,
  amount numeric(14,2) NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'tag_differs_from_job', 'line_untagged', 'not_in_our_copy', 'date_or_status_differs', 'unknown'
  )),
  document_type text NOT NULL DEFAULT '',
  document_id text NOT NULL DEFAULT '',
  document_number text,
  line_id text NOT NULL DEFAULT '',
  holder text NOT NULL DEFAULT 'bookkeeper' CHECK (holder IN ('bookkeeper', 'ops', 'accountant', 'system')),
  note text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'explained', 'fixed')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, month, document_type, document_id, line_id, tracking_option, account_code, reason)
);

ALTER TABLE public.division_tieout_cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.division_tieout_exceptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.division_tieout_cells, public.division_tieout_exceptions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.division_tieout_cells, public.division_tieout_exceptions
  TO service_role;
