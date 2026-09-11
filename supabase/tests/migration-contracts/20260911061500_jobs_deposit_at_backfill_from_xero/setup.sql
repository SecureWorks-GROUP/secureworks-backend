-- Minimal pre-migration surface for the deposit backfill contract.
-- public.jobs and public.business_events come from the earlier registered
-- fixtures; this case only adds the columns and the invoice cache it needs.
-- Test infrastructure, not a replacement for the production schema.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS deposit_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_invoice_id text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- business_events.job_id is uuid in production (the 11 Sep deploy proved it); the
-- earlier registered fixture already declares it uuid and it is NOT retyped here.
-- That fixture omits the event columns the backfill writes, so add only those.
ALTER TABLE public.business_events
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS entity_type text,
  ADD COLUMN IF NOT EXISTS entity_id text;

CREATE TABLE IF NOT EXISTS public.xero_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  xero_invoice_id text NOT NULL,
  invoice_number text,
  invoice_type text NOT NULL,
  status text,
  amount_due numeric(12,2),
  amount_paid numeric(12,2),
  fully_paid_on date,
  job_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, xero_invoice_id)
);

-- Fixtures the migration is expected to act on, written BEFORE it runs because
-- a one-off backfill can only be observed against pre-existing rows.
INSERT INTO public.jobs (id, org_id, status, type, job_number, deposit_at, deposit_invoice_id)
VALUES
  -- paid deposit, never stamped: the SWF-261334 case
  ('d0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa',
   'order_materials', 'fencing', 'SWF-CONTRACT-PAID', NULL, 'xinv-paid-with-date'),
  -- paid deposit whose invoice carries no FullyPaidOnDate
  ('d0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa',
   'processing', 'patio', 'SWP-CONTRACT-NODATE', NULL, 'xinv-paid-no-date'),
  -- deposit invoice still awaiting payment
  ('d0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa',
   'deposit', 'fencing', 'SWF-CONTRACT-UNPAID', NULL, 'xinv-authorised'),
  -- already stamped by the desk: must survive untouched
  ('d0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa',
   'scheduled', 'patio', 'SWP-CONTRACT-STAMPED', '2026-08-01T03:04:05Z', 'xinv-paid-already'),
  -- no deposit invoice at all
  ('d0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000aa',
   'quoted', 'fencing', 'SWF-CONTRACT-NOINVOICE', NULL, NULL),
  -- a PAID deposit invoice belonging to another org must not reach this job
  ('d0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-0000000000bb',
   'processing', 'fencing', 'SWF-CONTRACT-OTHERORG', NULL, 'xinv-paid-with-date');

INSERT INTO public.xero_invoices (
  org_id, xero_invoice_id, invoice_number, invoice_type, status,
  amount_due, amount_paid, fully_paid_on, updated_at
) VALUES
  ('00000000-0000-4000-8000-0000000000aa', 'xinv-paid-with-date', 'INV-9001', 'ACCREC', 'PAID',
   0, 1650.00, '2026-09-01', '2026-09-02T06:07:08Z'),
  ('00000000-0000-4000-8000-0000000000aa', 'xinv-paid-no-date', 'INV-9002', 'ACCREC', 'PAID',
   0, 2200.00, NULL, '2026-09-03T09:10:11Z'),
  ('00000000-0000-4000-8000-0000000000aa', 'xinv-authorised', 'INV-9003', 'ACCREC', 'AUTHORISED',
   1100.00, 0, NULL, '2026-09-04T01:02:03Z'),
  ('00000000-0000-4000-8000-0000000000aa', 'xinv-paid-already', 'INV-9004', 'ACCREC', 'PAID',
   0, 990.00, '2026-09-05', '2026-09-05T00:00:00Z');
