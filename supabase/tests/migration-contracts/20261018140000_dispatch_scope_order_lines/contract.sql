-- Contract: 20261018140000_dispatch_scope_order_lines. The table is locked away
-- from the browser, one demand is one row per job, a blank product stays flagged,
-- and the row carries no supplier contact, price or purchase order.
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
 id, org_id, job_id, demand_id, product, product_unknown, description, quantity, unit,
 length_mm, cut_size, cuts, supplier_name, position)
VALUES (
 '9f100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
 '9f000000-0000-4000-8000-000000000001', 'beam-a', 'rhs:100x50x2.0:c450l0', false,
 'beam beam-a', 1, 'each', 2800, '1 x 2800 mm', '[{"length_mm":2800,"qty":1}]'::jsonb, NULL, 0);

SELECT pg_temp.so_assert(pg_temp.so_refused($q$
 INSERT INTO public.dispatch_scope_order_lines (
  id, org_id, job_id, demand_id, product, product_unknown, description, position)
 VALUES (
  '9f100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001',
  '9f000000-0000-4000-8000-000000000001', 'beam-a', 'rhs:100x50x2.0:c450l0', false,
  'beam beam-a again', 1)
$q$), 'the same demand on a job is one row');

SELECT pg_temp.so_assert(pg_temp.so_refused($q$
 INSERT INTO public.dispatch_scope_order_lines (
  id, org_id, job_id, demand_id, product, product_unknown, description, position)
 VALUES (
  '9f100000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001',
  '9f000000-0000-4000-8000-000000000001', 'flashing', NULL, false, 'flashing flashing', 1)
$q$), 'a blank product must stay flagged');

SELECT pg_temp.so_assert(pg_temp.so_refused($q$
 INSERT INTO public.dispatch_scope_order_lines (
  id, org_id, job_id, demand_id, product, product_unknown, description, quantity, position)
 VALUES (
  '9f100000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001',
  '9f000000-0000-4000-8000-000000000001', 'negative', 'synthetic:rail', false, 'rails', -1, 2)
$q$), 'a quantity cannot be negative');

INSERT INTO public.dispatch_scope_order_lines (
 id, org_id, job_id, demand_id, product, product_unknown, description, position)
VALUES (
 '9f100000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001',
 '9f000000-0000-4000-8000-000000000001', 'to-confirm', 'synthetic:unknown', true,
 'Unconfirmed latch', 1);

SELECT pg_temp.so_assert(
 (SELECT count(*) = 2 FROM public.dispatch_scope_order_lines
   WHERE job_id = '9f000000-0000-4000-8000-000000000001'),
 'a flagged product and a known product can sit on the same job');

DELETE FROM public.jobs WHERE id = '9f000000-0000-4000-8000-000000000001';
SELECT pg_temp.so_assert(
 (SELECT count(*) = 0 FROM public.dispatch_scope_order_lines
   WHERE job_id = '9f000000-0000-4000-8000-000000000001'),
 'scope order lines go with the job');

COMMIT;
