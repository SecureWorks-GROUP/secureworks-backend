-- Prerequisites for 20261029093000_materials_ai_two_keys. The AI bill reader
-- (20261028173000) and the earlier cases build every table this reads; this
-- adds only columns a stub may lack. Fail closed if a table is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.materials_ai_placements', 'public.materials_ai_settings', 'public.materials_ai_calls',
                           'public.job_materials_facts', 'public.materials_reconciliation_queue', 'public.xero_invoices',
                           'public.purchase_orders', 'public.jobs', 'public.job_events'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'ai two keys setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.materials_reconciliation_queue
  ADD COLUMN IF NOT EXISTS xero_contact_id text;
ALTER TABLE public.job_materials_facts
  ADD COLUMN IF NOT EXISTS xero_contact_id text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS fact_date date;
