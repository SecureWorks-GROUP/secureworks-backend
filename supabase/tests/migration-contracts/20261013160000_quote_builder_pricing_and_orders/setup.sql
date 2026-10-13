-- Prerequisites for 20261013160000_quote_builder_pricing_and_orders. Earlier registered cases
-- already create public.users, public.jobs, public.job_documents, public.work_orders,
-- public.purchase_orders and public.quote_builder_versions (checked here) and the API roles its
-- grants name; only the columns this migration's indexes and this contract read are added, each
-- IF NOT EXISTS, in the live types.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.users', 'public.jobs', 'public.job_documents', 'public.work_orders',
                          'public.purchase_orders', 'public.quote_builder_versions'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'quote builder pricing setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
   RAISE EXCEPTION 'quote builder pricing setup: role % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;

ALTER TABLE public.job_documents
 ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.work_orders
 ADD COLUMN IF NOT EXISTS org_id uuid,
 ADD COLUMN IF NOT EXISTS job_id uuid,
 ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';
ALTER TABLE public.purchase_orders
 ADD COLUMN IF NOT EXISTS org_id uuid,
 ADD COLUMN IF NOT EXISTS job_id uuid,
 ADD COLUMN IF NOT EXISTS supplier_name text,
 ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.purchase_orders ALTER COLUMN status SET DEFAULT 'draft';
