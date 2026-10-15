-- Prerequisites for 20261014150000_dispatch_purchase_orders. Earlier registered cases create
-- public.jobs, public.suppliers, public.users, public.job_events, public.purchase_orders (reduced to
-- id, job_id, po_number) and slice 4's job_material_suppliers / job_material_lines. This adds only
-- the live purchase_orders columns the migration and its functions use (nullable, so earlier
-- contracts that insert reduced rows still run), the live updated_at trigger, po_communications
-- (which the draft table references), po_number_seq as live has it (never called), and
-- the id defaults live has on job_events and purchase_orders.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.suppliers', 'public.users', 'public.job_events',
                          'public.purchase_orders', 'public.job_material_suppliers', 'public.job_material_lines'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'dispatch purchase orders setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS supplier_name text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS po_type text,
  ADD COLUMN IF NOT EXISTS line_items jsonb,
  ADD COLUMN IF NOT EXISTS subtotal numeric,
  ADD COLUMN IF NOT EXISTS tax numeric,
  ADD COLUMN IF NOT EXISTS total numeric,
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS xero_po_id text,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE OR REPLACE FUNCTION public.dispatch_contract_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_po_updated'
                AND tgrelid = 'public.purchase_orders'::regclass) THEN
  CREATE TRIGGER trg_po_updated BEFORE UPDATE ON public.purchase_orders
   FOR EACH ROW EXECUTE FUNCTION public.dispatch_contract_touch_updated_at();
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.po_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid,
  job_id uuid,
  direction text,
  created_at timestamptz DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS public.po_number_seq;

-- Live gives both ids a default (job_events uuid_generate_v4(), purchase_orders
-- gen_random_uuid()); earlier reduced fixtures may not.
ALTER TABLE public.job_events ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.purchase_orders ALTER COLUMN id SET DEFAULT gen_random_uuid();
