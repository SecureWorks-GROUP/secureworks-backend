-- Prerequisites for 20261028173000_materials_ai_bill_reader. Earlier registered
-- cases create the engine views, the allocation rows, the queue, the bill
-- proposals and the email reader. This adds only columns the reader reads that
-- a stub may lack. Fail closed if a table is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.v_job_cost_events', 'public.v_bill_allocation_balance', 'public.v_job_profit',
                           'public.job_materials_facts', 'public.materials_reconciliation_queue',
                           'public.materials_bill_proposals', 'public.xero_invoices', 'public.trade_invoices',
                           'public.jobs', 'public.job_events', 'public.business_events',
                           'public.context_email_attachments', 'public.job_assignments'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'ai bill reader setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS site_address text,
  ADD COLUMN IF NOT EXISTS site_suburb text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.job_events
  ADD COLUMN IF NOT EXISTS detail_json jsonb;
ALTER TABLE public.materials_reconciliation_queue
  ADD COLUMN IF NOT EXISTS suggestion_confidence text,
  ADD COLUMN IF NOT EXISTS assigned_job_id uuid,
  ADD COLUMN IF NOT EXISTS assigned_by text,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.job_materials_facts
  ADD COLUMN IF NOT EXISTS match_reason text,
  ADD COLUMN IF NOT EXISTS matched_po_id uuid;
CREATE TABLE IF NOT EXISTS public.purchase_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS po_number text,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS xero_contact_id text,
  ADD COLUMN IF NOT EXISTS supplier_name text,
  ADD COLUMN IF NOT EXISTS subtotal numeric,
  ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.job_events ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.job_assignments
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS scheduled_date date,
  ADD COLUMN IF NOT EXISTS status text;
