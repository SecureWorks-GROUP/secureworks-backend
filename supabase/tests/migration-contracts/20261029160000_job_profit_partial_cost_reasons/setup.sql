-- Prerequisites for 20261029160000_job_profit_partial_cost_reasons (TP-13).
-- Earlier registered cases build the engine views (20261009130000 to
-- 20261028173000) and the client sign-off record (20261020170100). This adds
-- only the production columns the new rules read that a stub may lack, and
-- fails closed if a table the view reads is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.v_job_profit', 'public.v_job_cost_events', 'public.v_job_revenue_events',
                           'public.job_variations', 'public.job_client_signoffs', 'public.xero_invoices',
                           'public.purchase_orders', 'public.job_materials_facts', 'public.jobs'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'tp13 setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
END $$;

-- Production columns (20260322000010 job_variations; 20260924140000 jobs).
ALTER TABLE public.job_variations ADD COLUMN IF NOT EXISTS cost_estimate numeric(12,2);
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS completed_at timestamptz;
