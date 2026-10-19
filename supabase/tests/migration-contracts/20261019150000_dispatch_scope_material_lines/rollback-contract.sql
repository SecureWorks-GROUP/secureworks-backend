-- Rollback contract: 20261019150000_dispatch_scope_material_lines. The down
-- drops the material replace, the scope link columns, the price-note columns
-- and suppliers.aliases. job_material_lines and the scope-order replace remain,
-- and a scope-order insert that omits price_to_confirm still works.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regprocedure('public.dispatch_replace_scope_material_lines(jsonb)') IS NOT NULL THEN
  RAISE EXCEPTION 'scope material lines rollback contract: the material replace still exists';
 END IF;
 IF EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'job_material_lines'
    AND column_name IN ('product', 'length_mm', 'stock_length_mm', 'stock_qty', 'cut_size', 'cuts', 'scope_id', 'demand_id', 'unit_price')
 ) THEN
  RAISE EXCEPTION 'scope material lines rollback contract: a scope link column is still on job_material_lines';
 END IF;
 IF EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'dispatch_scope_order_lines'
    AND column_name IN ('price_to_confirm', 'supplier_match')
 ) THEN
  RAISE EXCEPTION 'scope material lines rollback contract: a stage 2 column is still on dispatch_scope_order_lines';
 END IF;
 IF EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'suppliers' AND column_name = 'aliases'
 ) THEN
  RAISE EXCEPTION 'scope material lines rollback contract: suppliers.aliases still exists';
 END IF;
 IF to_regclass('public.job_material_lines') IS NULL
  OR to_regprocedure('public.dispatch_replace_scope_order_lines(jsonb)') IS NULL
  OR to_regclass('public.jobs') IS NULL THEN
  RAISE EXCEPTION 'scope material lines rollback contract: the down removed a stage 1 object';
 END IF;
END $$;

INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9f200000-0000-4000-8000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing');

SELECT public.dispatch_replace_scope_order_lines(jsonb_build_object(
 'job_id', '9f200000-0000-4000-8000-0000000000aa',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'fence-fixture',
 'order_version', 'v1',
 'now', '2026-10-19T00:00:00Z',
 'actor', jsonb_build_object('email', 'ada@example.test'),
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f250000-0000-4000-8000-0000000000aa',
  'demand_id', 'post-1',
  'product', 'post:shs:65x65',
  'product_unknown', false,
  'description', 'Fence post',
  'quantity', 1,
  'position', 0
 ))
));

DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.dispatch_scope_order_lines
  WHERE job_id = '9f200000-0000-4000-8000-0000000000aa' AND demand_id = 'post-1'
 ) THEN
  RAISE EXCEPTION 'scope material lines rollback contract: an insert without price_to_confirm failed';
 END IF;
 DELETE FROM public.jobs WHERE id = '9f200000-0000-4000-8000-0000000000aa';
END $$;
