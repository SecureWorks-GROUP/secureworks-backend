-- The shared migration-contracts stack supplies roles, organisations, jobs,
-- xero_invoices, xero_supplier_credit_notes and phase 2's cost-line tables.
-- In standalone mode (scripts/test-division-tieout.sh), create those exact
-- schema prerequisites and apply phase 2's 20261117160400_job_cost_lines.sql.
SELECT to_regclass('public.job_cost_lines') IS NULL AS standalone_cost_lines \gset
\if :standalone_cost_lines
CREATE TABLE IF NOT EXISTS public.organisations (
  id uuid PRIMARY KEY,
  name text
);

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  job_number text,
  type text,
  status text
);

CREATE TABLE IF NOT EXISTS public.xero_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organisations(id),
  xero_invoice_id text NOT NULL,
  invoice_number text,
  invoice_type text NOT NULL,
  status text,
  invoice_date date,
  line_items jsonb,
  job_id uuid REFERENCES public.jobs(id),
  raw_json jsonb,
  UNIQUE (org_id, xero_invoice_id)
);

CREATE TABLE IF NOT EXISTS public.xero_supplier_credit_notes (
  org_id uuid NOT NULL REFERENCES public.organisations(id),
  xero_credit_note_id text NOT NULL CHECK (btrim(xero_credit_note_id) <> ''),
  credit_note_type text NOT NULL CHECK (credit_note_type = 'ACCPAYCREDIT'),
  credit_note_number text,
  credit_note_date date,
  status text,
  line_amount_types text,
  sub_total numeric(14,2),
  total_tax numeric(14,2),
  total numeric(14,2),
  remaining_credit numeric(14,2),
  allocations_returned boolean NOT NULL DEFAULT true,
  raw_json jsonb NOT NULL,
  PRIMARY KEY (org_id, xero_credit_note_id)
);

\ir ../../../migrations/20261117160400_job_cost_lines.sql
\endif

-- Production reporting schema (20250301000003) owns idx_xero_invoices_date;
-- earlier test fixtures omit it on the shared stack.
CREATE INDEX IF NOT EXISTS idx_xero_invoices_date ON public.xero_invoices(invoice_date);

-- Apply P3-04.3 and its ruling update in standalone mode; the shared stack runs both earlier.
SELECT to_regprocedure('public.job_division_option(text,text,uuid)') IS NULL AS need_division_option \gset
\if :need_division_option
\ir ../../../migrations/20261117163100_xero_draft_standard.sql
\ir ../../../migrations/20261118080638_job_division_option.sql
\ir ../../../migrations/20261118120115_division_rulings.sql
\endif
