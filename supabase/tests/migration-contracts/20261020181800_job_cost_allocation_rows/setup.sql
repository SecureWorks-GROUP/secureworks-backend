-- Prerequisites for 20261020181800_job_cost_allocation_rows (CFO-18, CFO-20).
-- Earlier registered cases create the engine views, the facts table and the
-- Bills to place queue. This adds only columns the split function reads or
-- writes that a stub may lack, and the one-row-per-bill index the migration
-- replaces. Fail closed if a table is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.v_job_cost_events', 'public.v_job_revenue_events', 'public.v_job_profit',
                           'public.job_materials_facts', 'public.materials_reconciliation_queue',
                           'public.xero_invoices', 'public.trade_invoices', 'public.jobs'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'cfo18 setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.job_materials_facts
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS xero_contact_id text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS job_number text,
  ADD COLUMN IF NOT EXISTS lane text DEFAULT 'materials',
  ADD COLUMN IF NOT EXISTS kind text DEFAULT 'actual',
  ADD COLUMN IF NOT EXISTS amount_inc_gst numeric,
  ADD COLUMN IF NOT EXISTS fact_date date,
  ADD COLUMN IF NOT EXISTS assigned_by text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE public.materials_reconciliation_queue
  ADD COLUMN IF NOT EXISTS xero_contact_id text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS total numeric,
  ADD COLUMN IF NOT EXISTS invoice_date date,
  ADD COLUMN IF NOT EXISTS suggested_job_number text,
  ADD COLUMN IF NOT EXISTS suggestion_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS job_materials_facts_invoice_uidx
  ON public.job_materials_facts (xero_invoice_id);

-- Production's queue is one row per bill (20260705000010 materials_recon_invoice_uidx);
-- the installer holds insert ON CONFLICT on it.
CREATE UNIQUE INDEX IF NOT EXISTS materials_recon_invoice_uidx
  ON public.materials_reconciliation_queue (xero_invoice_id);
