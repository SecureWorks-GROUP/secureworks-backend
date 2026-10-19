-- Prerequisites for 20261019120000_job_profit_commitments_truthful (CFO-12).
-- Earlier registered cases create everything this migration reads: the engine
-- views (20261009130000), purchase_orders with source and last_sent_at, and
-- job_order_emails and suppliers (20261014150000). Fail closed if any is gone.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.v_job_cost_events', 'public.v_job_profit', 'public.purchase_orders',
                          'public.job_order_emails', 'public.suppliers', 'public.job_materials_facts'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'cfo12 setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS supplier_id uuid,
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_received_at timestamptz;
