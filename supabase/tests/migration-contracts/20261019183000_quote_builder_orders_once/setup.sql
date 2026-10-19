-- Prerequisites for 20261019183000_quote_builder_orders_once. Earlier registered cases create
-- public.jobs, public.users, public.feature_flags, public.work_orders, public.purchase_orders and
-- (20261009120000) public.quote_builder_versions. 20261014140000_quote_builder_orders is not a
-- registered case, so its two version links and the work order key are laid down here as that
-- migration wrote them.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.feature_flags', 'public.work_orders',
                          'public.purchase_orders', 'public.quote_builder_versions'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'quote builder orders once setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS po_number text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS quote_builder_version_id uuid NULL
    REFERENCES public.quote_builder_versions(id) ON DELETE RESTRICT;
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS quote_builder_version_id uuid NULL
    REFERENCES public.quote_builder_versions(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_one_quote_builder_version
  ON public.work_orders (quote_builder_version_id)
  WHERE quote_builder_version_id IS NOT NULL;

-- Pre-existing state the migration must number: one version with two linked purchase orders and
-- a work order, made before the seq existed, and a plain Dispatch order with no link.
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9b000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'processing', 'repair')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.quote_builder_versions (id, job_id, kind, chain_id, version)
VALUES ('9b000000-0000-4000-8000-0000000000a1', '9b000000-0000-4000-8000-000000000001', 'scope',
        '9b000000-0000-4000-8000-000000000001', 1)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.purchase_orders (id, job_id, po_number, quote_builder_version_id) VALUES
 ('9b000000-0000-4000-8000-0000000000b2', '9b000000-0000-4000-8000-000000000001', 'PO-9B-2', '9b000000-0000-4000-8000-0000000000a1'),
 ('9b000000-0000-4000-8000-0000000000b1', '9b000000-0000-4000-8000-000000000001', 'PO-9B-1', '9b000000-0000-4000-8000-0000000000a1'),
 ('9b000000-0000-4000-8000-0000000000b9', '9b000000-0000-4000-8000-000000000001', 'PO-9B-DISPATCH', NULL)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.work_orders (id, org_id, job_id, quote_builder_version_id)
SELECT '9b000000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-000000000001',
       '9b000000-0000-4000-8000-000000000001', '9b000000-0000-4000-8000-0000000000a1'
WHERE NOT EXISTS (SELECT 1 FROM public.work_orders WHERE id = '9b000000-0000-4000-8000-0000000000c1');
