-- Contract: 20261019150000_dispatch_scope_material_lines. Known scope lines
-- copy onto job_material_lines as to_order, linked by job, scope and demand.
-- A manual line and another scope stay. A line already on a purchase order
-- stays. An empty set removes only this scope's lines that are not on an
-- order. No supplier row is created by the function. The scope-order table
-- still stores no price and no supplier id.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.sm_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'scope material lines contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.sm_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
 RETURN true;
END $$;

DO $$
DECLARE p text;
BEGIN
 PERFORM pg_temp.sm_assert(
  to_regprocedure('public.dispatch_replace_scope_material_lines(jsonb)') IS NOT NULL,
  'dispatch_replace_scope_material_lines must exist');
 PERFORM pg_temp.sm_assert(
  NOT has_function_privilege('anon', 'public.dispatch_replace_scope_material_lines(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.dispatch_replace_scope_material_lines(jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.dispatch_replace_scope_material_lines(jsonb)', 'EXECUTE'),
  'browser roles must not execute dispatch_replace_scope_material_lines');
 PERFORM pg_temp.sm_assert(EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'suppliers' AND column_name = 'aliases'),
  'suppliers.aliases must exist');
 PERFORM pg_temp.sm_assert(NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'dispatch_scope_order_lines'
    AND column_name IN ('cost', 'price', 'unit_price', 'supplier_id', 'purchase_order_id')),
  'a scope order line stores no price, supplier contact or purchase order');
 PERFORM pg_temp.sm_assert(EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'job_material_lines'
    AND column_name IN ('product', 'stock_length_mm', 'scope_id', 'demand_id', 'unit_price')
  HAVING count(*) = 5),
  'job_material_lines carries the scope link and the piece fields');
 FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
  PERFORM pg_temp.sm_assert(
   NOT has_table_privilege('anon', 'public.job_material_lines', p)
   AND NOT has_table_privilege('authenticated', 'public.job_material_lines', p),
   'browser roles must hold no privilege on public.job_material_lines');
 END LOOP;
END $$;

INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9f200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'order_materials', 'fencing');

INSERT INTO public.suppliers (id, name)
VALUES ('9f210000-0000-4000-8000-000000000001', 'Example Steel'),
       ('9f210000-0000-4000-8000-000000000002', 'Stratco');

-- Earlier contracts may already have committed supplier rows. The apply must
-- add none of its own.
CREATE TEMP TABLE sm_supplier_ids AS SELECT id FROM public.suppliers;

SELECT pg_temp.sm_assert(
 (SELECT aliases = '{}'::text[] FROM public.suppliers WHERE id = '9f210000-0000-4000-8000-000000000001'),
 'a supplier alias list starts empty');

-- A contact already chosen for the job keeps the name the office stored.
INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
VALUES (
 '00000000-0000-0000-0000-000000000001', '9f200000-0000-4000-8000-000000000001',
 '9f210000-0000-4000-8000-000000000001', 'Example Steel (desk)', 0);

INSERT INTO public.job_material_lines (
 id, org_id, job_id, supplier_id, description, quantity, unit, status, source, position,
 created_by_email)
VALUES (
 '9f230000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
 '9f200000-0000-4000-8000-000000000001', '9f210000-0000-4000-8000-000000000001',
 'Hand added post cap', 4, 'each', 'not_reviewed', 'manual', 0, 'office@example.test');

-- Slice 4 suggestions are source scope with no scope link. That shape stays valid.
INSERT INTO public.job_material_lines (
 id, org_id, job_id, supplier_id, description, status, source, position)
VALUES (
 '9f230000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001',
 '9f200000-0000-4000-8000-000000000001', '9f210000-0000-4000-8000-000000000001',
 'Suggested beam', 'not_reviewed', 'scope', 1);

SELECT pg_temp.sm_assert(pg_temp.sm_refused($q$
 INSERT INTO public.job_material_lines (
  id, org_id, job_id, supplier_id, description, status, source, scope_id, demand_id, position)
 VALUES (
  '9f230000-0000-4000-8000-000000000099', '00000000-0000-0000-0000-000000000001',
  '9f200000-0000-4000-8000-000000000001', '9f210000-0000-4000-8000-000000000001',
  'Manual with a scope link', 'not_reviewed', 'manual', 'fence-fixture', 'post-9', 2)
$q$), 'a manual line cannot carry a scope link');

-- 1800 sheet + 150 plinth + 600 in the ground = 2550 cut, bought as a 2700 post.
SELECT public.dispatch_replace_scope_material_lines(jsonb_build_object(
 'job_id', '9f200000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'fence-fixture',
 'now', '2026-10-19T00:00:00Z',
 'actor', jsonb_build_object('user_id', '9f240000-0000-4000-8000-000000000001', 'email', 'ada@example.test'),
 'suppliers', jsonb_build_array(jsonb_build_object(
  'supplier_id', '9f210000-0000-4000-8000-000000000001',
  'supplier_name', 'Example Steel',
  'position', 0
 )),
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f230000-0000-4000-8000-000000000010',
  'supplier_id', '9f210000-0000-4000-8000-000000000001',
  'description', 'Fence post',
  'quantity', 1,
  'unit', 'each',
  'product', 'post:shs:65x65',
  'length_mm', 2550,
  'stock_length_mm', 2700,
  'stock_qty', 1,
  'cut_size', '1 x 2550 mm',
  'cuts', '[{"length_mm":2550,"qty":1}]'::jsonb,
  'demand_id', 'post-1',
  'unit_price', NULL,
  'position', 0
 )),
 'flags', jsonb_build_array(jsonb_build_object('demand_id', 'post-1', 'supplier_match', 'matched'))
));

SELECT pg_temp.sm_assert(
 (SELECT status = 'to_order' AND source = 'scope' AND product = 'post:shs:65x65'
    AND quantity = 1 AND stock_length_mm = 2700 AND stock_qty = 1 AND length_mm = 2550
    AND cuts = '[{"length_mm":2550,"qty":1}]'::jsonb
    AND supplier_id = '9f210000-0000-4000-8000-000000000001'
    AND scope_id = 'fence-fixture' AND demand_id = 'post-1'
    AND unit_price IS NULL AND purchase_order_id IS NULL
    AND created_by_email = 'ada@example.test'
  FROM public.job_material_lines
  WHERE id = '9f230000-0000-4000-8000-000000000010'),
 'a 2700 stock post copies as to_order with a 2550 cut and no price');

SELECT pg_temp.sm_assert(
 (SELECT supplier_name = 'Example Steel (desk)' FROM public.job_material_suppliers
   WHERE job_id = '9f200000-0000-4000-8000-000000000001'
     AND supplier_id = '9f210000-0000-4000-8000-000000000001'),
 'apply does not rename a supplier already on the job');

SELECT pg_temp.sm_assert(
 (SELECT count(*) = 0 FROM public.suppliers s
   WHERE NOT EXISTS (SELECT 1 FROM sm_supplier_ids known WHERE known.id = s.id)),
 'apply does not create a suppliers row');

SELECT public.dispatch_replace_scope_material_lines(jsonb_build_object(
 'job_id', '9f200000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'patio-fixture',
 'now', '2026-10-19T00:00:00Z',
 'actor', jsonb_build_object('email', 'ada@example.test'),
 'suppliers', jsonb_build_array(jsonb_build_object(
  'supplier_id', '9f210000-0000-4000-8000-000000000002',
  'supplier_name', 'Stratco',
  'position', 0
 )),
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f230000-0000-4000-8000-000000000011',
  'supplier_id', '9f210000-0000-4000-8000-000000000002',
  'description', 'Patio post',
  'quantity', 3,
  'unit', 'each',
  'product', 'p-stratco-est2-09090po31-colour',
  'length_mm', 2846,
  'stock_length_mm', 3100,
  'stock_qty', 3,
  'cuts', '[{"length_mm":2846,"qty":3}]'::jsonb,
  'demand_id', 'post-1',
  'unit_price', NULL,
  'position', 0
 )),
 'flags', '[]'::jsonb
));

SELECT public.dispatch_replace_scope_material_lines(jsonb_build_object(
 'job_id', '9f200000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'fence-fixture',
 'now', '2026-10-19T01:00:00Z',
 'actor', jsonb_build_object('user_id', '9f240000-0000-4000-8000-000000000002', 'email', 'bea@example.test'),
 'suppliers', jsonb_build_array(jsonb_build_object(
  'supplier_id', '9f210000-0000-4000-8000-000000000001',
  'supplier_name', 'Example Steel',
  'position', 0
 )),
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f230000-0000-4000-8000-000000000010',
  'supplier_id', '9f210000-0000-4000-8000-000000000001',
  'description', 'Fence post',
  'quantity', 2,
  'unit', 'each',
  'product', 'post:shs:65x65',
  'length_mm', 2550,
  'stock_length_mm', 2700,
  'stock_qty', 2,
  'cuts', '[{"length_mm":2550,"qty":1}]'::jsonb,
  'demand_id', 'post-1',
  'unit_price', NULL,
  'position', 0
 )),
 'flags', '[]'::jsonb
));

SELECT pg_temp.sm_assert(
 (SELECT quantity = 2 AND created_by_email = 'ada@example.test' AND updated_by_email = 'bea@example.test'
  FROM public.job_material_lines WHERE id = '9f230000-0000-4000-8000-000000000010'),
 're-apply updates the fence quantity and keeps who created the line');

SELECT pg_temp.sm_assert(
 (SELECT quantity = 3 FROM public.job_material_lines WHERE id = '9f230000-0000-4000-8000-000000000011')
 AND (SELECT description = 'Hand added post cap' AND quantity = 4 AND source = 'manual'
      AND scope_id IS NULL AND demand_id IS NULL
      FROM public.job_material_lines WHERE id = '9f230000-0000-4000-8000-000000000001'),
 're-apply leaves the other scope and the manual line');

INSERT INTO public.purchase_orders (id, job_id, po_number)
VALUES ('9f220000-0000-4000-8000-000000000001', '9f200000-0000-4000-8000-000000000001', 'PO-1000099');

UPDATE public.job_material_lines
SET purchase_order_id = '9f220000-0000-4000-8000-000000000001'
WHERE id = '9f230000-0000-4000-8000-000000000010';

SELECT public.dispatch_replace_scope_material_lines(jsonb_build_object(
 'job_id', '9f200000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'fence-fixture',
 'now', '2026-10-19T02:00:00Z',
 'actor', jsonb_build_object('email', 'bea@example.test'),
 'suppliers', '[]'::jsonb,
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f230000-0000-4000-8000-000000000010',
  'supplier_id', '9f210000-0000-4000-8000-000000000001',
  'description', 'Fence post',
  'quantity', 9,
  'unit', 'each',
  'product', 'post:shs:65x65',
  'length_mm', 2550,
  'stock_length_mm', 2700,
  'stock_qty', 9,
  'cuts', '[{"length_mm":2550,"qty":1}]'::jsonb,
  'demand_id', 'post-1',
  'unit_price', NULL,
  'position', 0
 )),
 'flags', '[]'::jsonb
));

SELECT pg_temp.sm_assert(
 (SELECT quantity = 2 AND purchase_order_id = '9f220000-0000-4000-8000-000000000001'
  FROM public.job_material_lines WHERE id = '9f230000-0000-4000-8000-000000000010'),
 'a line already on a purchase order is not rewritten');

SELECT public.dispatch_replace_scope_material_lines(jsonb_build_object(
 'job_id', '9f200000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'patio-fixture',
 'now', '2026-10-19T03:00:00Z',
 'actor', jsonb_build_object('email', 'ada@example.test'),
 'suppliers', '[]'::jsonb,
 'lines', '[]'::jsonb,
 'flags', '[]'::jsonb
));

SELECT pg_temp.sm_assert(
 (SELECT count(*) = 0 FROM public.job_material_lines WHERE scope_id = 'patio-fixture')
 AND (SELECT count(*) = 1 FROM public.job_material_suppliers
      WHERE job_id = '9f200000-0000-4000-8000-000000000001'
        AND supplier_id = '9f210000-0000-4000-8000-000000000002')
 AND (SELECT description = 'Hand added post cap' FROM public.job_material_lines
      WHERE id = '9f230000-0000-4000-8000-000000000001'),
 'an empty apply removes only that scope''s lines that are not on an order');

SELECT public.dispatch_replace_scope_material_lines(jsonb_build_object(
 'job_id', '9f200000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'priced',
 'now', '2026-10-19T04:00:00Z',
 'actor', jsonb_build_object('email', 'ada@example.test'),
 'suppliers', '[]'::jsonb,
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f230000-0000-4000-8000-000000000012',
  'supplier_id', '9f210000-0000-4000-8000-000000000002',
  'description', 'Patioline gutter, minimum purchase roll',
  'quantity', 1,
  'unit', 'length',
  'product', 'practice-cmi-patioline',
  'stock_length_mm', 7000,
  'stock_qty', 1,
  'length_mm', 6000,
  'cuts', '[{"length_mm":6000,"qty":1}]'::jsonb,
  'demand_id', 'gutter-1',
  'unit_price', 19.50,
  'position', 0
 )),
 'flags', '[]'::jsonb
));

SELECT pg_temp.sm_assert(
 (SELECT unit_price = 19.50 FROM public.job_material_lines WHERE id = '9f230000-0000-4000-8000-000000000012'),
 'a unit price the caller already resolved is stored');

DO $$
BEGIN
 PERFORM public.dispatch_replace_scope_material_lines(jsonb_build_object(
  'job_id', '9f200000-0000-4000-8000-000000000001',
  'org_id', '00000000-0000-0000-0000-000000000001',
  'scope_id', 'priced',
  'now', '2026-10-19T05:00:00Z',
  'suppliers', '[]'::jsonb,
  'lines', jsonb_build_array(jsonb_build_object(
   'id', '9f230000-0000-4000-8000-000000000012',
   'supplier_id', '9f210000-0000-4000-8000-000000000002',
   'description', 'Patioline gutter, minimum purchase roll',
   'quantity', 1,
   'product', 'practice-cmi-patioline',
   'demand_id', 'gutter-1',
   'unit_price', -1,
   'position', 0
  )),
  'flags', '[]'::jsonb
 ));
 RAISE EXCEPTION 'scope material lines contract: a negative price was accepted';
EXCEPTION WHEN check_violation THEN
 NULL;
END $$;

SELECT pg_temp.sm_assert(
 (SELECT unit_price = 19.50 AND quantity = 1 FROM public.job_material_lines
   WHERE id = '9f230000-0000-4000-8000-000000000012'),
 'a refused negative price leaves the stored line');

SELECT public.dispatch_replace_scope_order_lines(jsonb_build_object(
 'job_id', '9f200000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'fence-fixture',
 'order_version', 'v1',
 'now', '2026-10-19T06:00:00Z',
 'actor', jsonb_build_object('email', 'ada@example.test'),
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f250000-0000-4000-8000-000000000001',
  'demand_id', 'post-1',
  'product', 'post:shs:65x65',
  'product_unknown', false,
  'price_to_confirm', true,
  'description', 'Fence post',
  'quantity', 1,
  'position', 0
 ))
));

SELECT pg_temp.sm_assert(
 (SELECT price_to_confirm IS TRUE AND supplier_match IS NULL
  FROM public.dispatch_scope_order_lines
  WHERE job_id = '9f200000-0000-4000-8000-000000000001' AND scope_id = 'fence-fixture'),
 'the price note is stored and a re-import clears supplier_match');

SELECT public.dispatch_replace_scope_order_lines(jsonb_build_object(
 'job_id', '9f200000-0000-4000-8000-000000000001',
 'org_id', '00000000-0000-0000-0000-000000000001',
 'scope_id', 'omitted-flag',
 'order_version', 'v1',
 'now', '2026-10-19T06:00:00Z',
 'actor', jsonb_build_object('email', 'ada@example.test'),
 'lines', jsonb_build_array(jsonb_build_object(
  'id', '9f250000-0000-4000-8000-000000000002',
  'demand_id', 'post-2',
  'product', 'post:shs:65x65',
  'product_unknown', false,
  'description', 'Fence post',
  'quantity', 1,
  'position', 0
 ))
));

SELECT pg_temp.sm_assert(
 (SELECT price_to_confirm IS FALSE FROM public.dispatch_scope_order_lines
   WHERE scope_id = 'omitted-flag' AND demand_id = 'post-2'),
 'a payload that omits price_to_confirm stores false');

DO $$
BEGIN
 INSERT INTO public.job_material_lines (
  id, org_id, job_id, supplier_id, description, status, source, position)
 SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000001',
  '9f200000-0000-4000-8000-000000000001', '9f210000-0000-4000-8000-000000000001',
  'cap filler', 'not_reviewed', 'manual', g
 FROM generate_series(0, 499) AS g;
 PERFORM public.dispatch_replace_scope_material_lines(jsonb_build_object(
  'job_id', '9f200000-0000-4000-8000-000000000001',
  'org_id', '00000000-0000-0000-0000-000000000001',
  'scope_id', 'overflow',
  'suppliers', '[]'::jsonb,
  'lines', jsonb_build_array(jsonb_build_object(
   'id', '9f230000-0000-4000-8000-000000000077',
   'supplier_id', '9f210000-0000-4000-8000-000000000001',
   'description', 'One too many',
   'quantity', 1,
   'product', 'post:shs:65x65',
   'demand_id', 'extra-1',
   'position', 0
  )),
  'flags', '[]'::jsonb
 ));
 RAISE EXCEPTION 'scope material lines contract: the 500 line cap was not enforced';
EXCEPTION WHEN OTHERS THEN
 IF SQLERRM NOT LIKE '%too_many_lines%' THEN
  RAISE EXCEPTION 'scope material lines contract: line cap raised %', SQLERRM;
 END IF;
END $$;

SELECT pg_temp.sm_assert(
 (SELECT count(*) = 0 FROM public.job_material_lines WHERE description = 'cap filler'),
 'a refused cap writes nothing');

ROLLBACK;
