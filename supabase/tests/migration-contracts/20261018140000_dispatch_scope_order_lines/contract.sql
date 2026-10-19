-- Contract: 20261018140000_dispatch_scope_order_lines. The table is locked away
-- from the browser, one demand is one row per scope, a second scope on the
-- same job is kept, a blank product stays flagged, stock length and cut
-- length may differ, and the row carries no supplier contact, price or
-- purchase order. The replace function is the one writer of a scope.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.so_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'scope order lines contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.so_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
 RETURN true;
END $$;

DO $$
DECLARE p text;
BEGIN
 PERFORM pg_temp.so_assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.dispatch_scope_order_lines'::regclass),
  'row level security must be on for public.dispatch_scope_order_lines');
 PERFORM pg_temp.so_assert(NOT EXISTS (
  SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dispatch_scope_order_lines'),
  'public.dispatch_scope_order_lines must carry no policy: only ops-api reaches it');
 FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
  PERFORM pg_temp.so_assert(
   NOT has_table_privilege('anon', 'public.dispatch_scope_order_lines', p)
   AND NOT has_table_privilege('authenticated', 'public.dispatch_scope_order_lines', p),
   format('browser roles must hold no privilege on public.dispatch_scope_order_lines'));
 END LOOP;
 FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
  PERFORM pg_temp.so_assert(has_table_privilege('service_role', 'public.dispatch_scope_order_lines', p),
   format('service_role (ops-api) must be able to %s public.dispatch_scope_order_lines', p));
 END LOOP;
 PERFORM pg_temp.so_assert(
  to_regprocedure('public.dispatch_replace_scope_order_lines(jsonb)') IS NOT NULL,
  'dispatch_replace_scope_order_lines must exist');
 PERFORM pg_temp.so_assert(
  NOT has_function_privilege('anon', 'public.dispatch_replace_scope_order_lines(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.dispatch_replace_scope_order_lines(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.dispatch_replace_scope_order_lines(jsonb)', 'EXECUTE'),
  'only service_role may execute dispatch_replace_scope_order_lines');
 PERFORM pg_temp.so_assert(NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'dispatch_scope_order_lines'
    AND column_name IN ('cost', 'price', 'unit_price', 'supplier_id', 'purchase_order_id')),
  'a scope order line stores no price, supplier contact or purchase order');
END $$;

INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9f000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'order_materials', 'patio'),
       ('9f000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing');

INSERT INTO public.dispatch_scope_order_lines (
 id, org_id, job_id, scope_id, order_version, demand_id, product, product_unknown, description,
 quantity, unit, length_mm, stock_length_mm, stock_qty, cut_size, cuts, element_refs, supplier_name, position)
VALUES (
 '9f100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
 '9f000000-0000-4000-8000-000000000001', 'stated', 'v1', 'beam-a', 'rhs:100x50x2.0:c450l0', false,
 'beam beam-a', 1, 'each', 2800, NULL, NULL, '1 x 2800 mm', '[{"length_mm":2800,"qty":1}]'::jsonb,
 '["beam-a"]'::jsonb, NULL, 0);

-- 1800 sheet + 150 plinth + 600 in the ground = 2550 cut, bought as a 2700 post.
INSERT INTO public.dispatch_scope_order_lines (
 id, org_id, job_id, scope_id, order_version, demand_id, product, product_unknown, description,
 quantity, unit, length_mm, stock_length_mm, stock_qty, cut_size, cuts, element_refs, position)
VALUES (
 '9f100000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001',
 '9f000000-0000-4000-8000-000000000002', 'fence-fixture', 'v1', 'post-1', 'post:shs', false,
 'Fence post', 1, 'each', 2550, 2700, 1, '1 x 2550 mm', '[{"length_mm":2550,"qty":1}]'::jsonb,
 '["post-1"]'::jsonb, 0);

SELECT pg_temp.so_assert(
 (SELECT length_mm = 2550 AND stock_length_mm = 2700 AND stock_qty = 1
    AND cuts = '[{"length_mm":2550,"qty":1}]'::jsonb
  FROM public.dispatch_scope_order_lines
  WHERE job_id = '9f000000-0000-4000-8000-000000000002' AND scope_id = 'fence-fixture'),
 'a 2700 stock post may carry a 2550 cut');

SELECT pg_temp.so_assert(pg_temp.so_refused($q$
 INSERT INTO public.dispatch_scope_order_lines (
  id, org_id, job_id, scope_id, order_version, demand_id, product, product_unknown, description, position)
 VALUES (
  '9f100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001',
  '9f000000-0000-4000-8000-000000000001', 'stated', 'v1', 'beam-a', 'rhs:100x50x2.0:c450l0', false,
  'beam beam-a again', 1)
$q$), 'the same demand on a scope is one row');

INSERT INTO public.dispatch_scope_order_lines (
 id, org_id, job_id, scope_id, order_version, demand_id, product, product_unknown, description, position)
VALUES (
 '9f100000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001',
 '9f000000-0000-4000-8000-000000000001', 'other-scope', 'v1', 'beam-a', 'rhs:100x50x2.0:c450l0', false,
 'beam beam-a on another scope', 0);

SELECT pg_temp.so_assert(pg_temp.so_refused($q$
 INSERT INTO public.dispatch_scope_order_lines (
  id, org_id, job_id, scope_id, order_version, demand_id, product, product_unknown, description, position)
 VALUES (
  '9f100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001',
  '9f000000-0000-4000-8000-000000000001', 'stated', 'v1', 'flashing', NULL, false, 'flashing flashing', 1)
$q$), 'a blank product must stay flagged');

SELECT pg_temp.so_assert(pg_temp.so_refused($q$
 INSERT INTO public.dispatch_scope_order_lines (
  id, org_id, job_id, scope_id, order_version, demand_id, product, product_unknown, description, quantity, position)
 VALUES (
  '9f100000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001',
  '9f000000-0000-4000-8000-000000000001', 'stated', 'v1', 'negative', 'synthetic:rail', false, 'rails', -1, 2)
$q$), 'a quantity cannot be negative');

INSERT INTO public.dispatch_scope_order_lines (
 id, org_id, job_id, scope_id, order_version, demand_id, product, product_unknown, description, position)
VALUES (
 '9f100000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001',
 '9f000000-0000-4000-8000-000000000001', 'stated', 'v1', 'to-confirm', 'synthetic:unknown', true,
 'Unconfirmed latch', 1);

SELECT pg_temp.so_assert(
 (SELECT count(*) = 3 FROM public.dispatch_scope_order_lines
   WHERE job_id = '9f000000-0000-4000-8000-000000000001'),
 'a flagged product and a second scope can sit on the same job');

SELECT public.dispatch_replace_scope_order_lines(jsonb_build_object(
 'job_id', '9f000000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'patio',
 'order_version', 'v1',
 'now', '2026-10-18T00:00:00Z',
 'actor', jsonb_build_object('email', 'ada@example.test'),
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f100000-0000-4000-8000-000000000010',
  'demand_id', 'post-1',
  'product', 'post:patio',
  'product_unknown', false,
  'description', 'Patio post',
  'quantity', 1,
  'unit', 'each',
  'length_mm', 2846,
  'stock_length_mm', 3100,
  'stock_qty', 1,
  'cut_size', '1 x 2846 mm',
  'cuts', '[{"length_mm":2846,"qty":1}]'::jsonb,
  'element_refs', '["post-1"]'::jsonb,
  'supplier_name', NULL,
  'position', 0
 ))
));

SELECT public.dispatch_replace_scope_order_lines(jsonb_build_object(
 'job_id', '9f000000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'fence',
 'order_version', 'v1',
 'now', '2026-10-18T00:00:00Z',
 'actor', jsonb_build_object('email', 'ada@example.test'),
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f100000-0000-4000-8000-000000000011',
  'demand_id', 'post-1',
  'product', 'post:fence',
  'product_unknown', false,
  'description', 'Fence post',
  'quantity', 1,
  'unit', 'each',
  'length_mm', 2550,
  'stock_length_mm', 2700,
  'stock_qty', 1,
  'cut_size', '1 x 2550 mm',
  'cuts', '[{"length_mm":2550,"qty":1}]'::jsonb,
  'element_refs', '["post-1"]'::jsonb,
  'supplier_name', NULL,
  'position', 0
 ))
));

SELECT pg_temp.so_assert(
 (SELECT count(*) = 2 FROM public.dispatch_scope_order_lines
   WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND demand_id = 'post-1'),
 'a fence post-1 and a patio post-1 are different rows');

SELECT public.dispatch_replace_scope_order_lines(jsonb_build_object(
 'job_id', '9f000000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'patio',
 'order_version', 'v2',
 'now', '2026-10-18T01:00:00Z',
 'actor', jsonb_build_object('email', 'bea@example.test'),
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f100000-0000-4000-8000-000000000010',
  'demand_id', 'post-1',
  'product', 'post:patio',
  'product_unknown', false,
  'description', 'Patio post',
  'quantity', 2,
  'unit', 'each',
  'length_mm', 2846,
  'stock_length_mm', 3100,
  'stock_qty', 2,
  'cut_size', '1 x 2846 mm',
  'cuts', '[{"length_mm":2846,"qty":1}]'::jsonb,
  'element_refs', '["post-1"]'::jsonb,
  'supplier_name', NULL,
  'position', 0
 ))
));

SELECT pg_temp.so_assert(
 (SELECT quantity = 2 AND order_version = 'v2' AND created_by_email = 'ada@example.test'
    AND updated_by_email = 'bea@example.test'
  FROM public.dispatch_scope_order_lines
  WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND scope_id = 'patio' AND demand_id = 'post-1'),
 're-import updates the patio quantity and keeps who created the row');

SELECT pg_temp.so_assert(
 (SELECT quantity = 1 FROM public.dispatch_scope_order_lines
   WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND scope_id = 'fence' AND demand_id = 'post-1'),
 're-importing the patio scope leaves the fence scope');

SELECT pg_temp.so_assert(
 (SELECT count(*) = 3 FROM public.dispatch_scope_order_lines
   WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND scope_id IN ('stated', 'other-scope')),
 're-importing one scope leaves the scopes it was not asked to replace');

DO $$
BEGIN
 PERFORM public.dispatch_replace_scope_order_lines(jsonb_build_object(
  'job_id', '9f000000-0000-4000-8000-000000000001',
  'org_id', '00000000-0000-0000-0000-000000000001',
  'scope_id', 'patio',
  'order_version', 'v3',
  'lines', '[]'::jsonb
 ));
 RAISE EXCEPTION 'scope order lines contract: empty lines were accepted';
EXCEPTION WHEN OTHERS THEN
 IF SQLERRM NOT LIKE '%no_lines%' THEN
  RAISE EXCEPTION 'scope order lines contract: empty lines raised %', SQLERRM;
 END IF;
END $$;

SELECT pg_temp.so_assert(
 (SELECT quantity = 2 FROM public.dispatch_scope_order_lines
   WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND scope_id = 'patio'),
 'an empty replace writes nothing');

DELETE FROM public.jobs WHERE id = '9f000000-0000-4000-8000-000000000001';
SELECT pg_temp.so_assert(
 (SELECT count(*) = 0 FROM public.dispatch_scope_order_lines
   WHERE job_id = '9f000000-0000-4000-8000-000000000001'),
 'scope order lines go with the job');

COMMIT;
