-- Contract: 20261014120000_job_materials_by_supplier. The three Dispatch materials tables sit where
-- no browser role can read or write them; a line always sits under a supplier chosen for its job;
-- only the three hand-set statuses are stored; a supplier with a line cannot be taken off; the
-- sketch is a size-bounded PNG data URL; and everything goes with its job.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.jm_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'job materials contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.jm_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
 RETURN true;
END $$;

-- 1. Locked away from the browser, reachable by ops-api.
DO $$
DECLARE t text; p text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.job_material_suppliers', 'public.job_material_lines', 'public.job_dispatch_workings'] LOOP
  PERFORM pg_temp.jm_assert((SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass),
   format('row level security must be on for %s', t));
  PERFORM pg_temp.jm_assert(NOT EXISTS (
   SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = split_part(t, '.', 2)),
   format('%s must carry no policy: only ops-api reaches it', t));
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
   PERFORM pg_temp.jm_assert(NOT has_table_privilege('anon', t, p) AND NOT has_table_privilege('authenticated', t, p),
    format('browser roles must hold no privilege on %s', t));
  END LOOP;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
   PERFORM pg_temp.jm_assert(has_table_privilege('service_role', t, p),
    format('service_role (ops-api) must be able to %s %s', p, t));
  END LOOP;
 END LOOP;
END $$;

-- 2. Fixtures: two jobs, two supplier contacts, one purchase order.
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9e000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'order_materials', 'patio'),
       ('9e000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing');
INSERT INTO public.suppliers (id, name)
VALUES ('9e100000-0000-4000-8000-000000000001', 'Example Steel'),
       ('9e100000-0000-4000-8000-000000000002', 'Example Sheets');
INSERT INTO public.purchase_orders (id, job_id, po_number)
VALUES ('9e200000-0000-4000-8000-000000000001', '9e000000-0000-4000-8000-000000000001', 'PO-TEST-1');

INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
VALUES ('00000000-0000-0000-0000-000000000001', '9e000000-0000-4000-8000-000000000001', '9e100000-0000-4000-8000-000000000001', 'Example Steel', 1),
       ('00000000-0000-0000-0000-000000000001', '9e000000-0000-4000-8000-000000000001', '9e100000-0000-4000-8000-000000000002', 'Example Sheets', 2);

SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
 VALUES ('00000000-0000-0000-0000-000000000001', '9e000000-0000-4000-8000-000000000001', '9e100000-0000-4000-8000-000000000001', 'Example Steel', 3)
$q$), 'a supplier can be chosen once per job');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
 VALUES ('00000000-0000-0000-0000-000000000001', '9e000000-0000-4000-8000-000000000002', '9e100000-0000-4000-8000-0000000000ff', 'Nobody', 1)
$q$), 'a chosen supplier must be a supplier contact');

-- 3. A line sits under a supplier chosen for its own job.
INSERT INTO public.job_material_lines (id, org_id, job_id, supplier_id, description, quantity, unit, position)
VALUES ('9e300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
        '9e000000-0000-4000-8000-000000000001', '9e100000-0000-4000-8000-000000000001', '90x90 posts', 3, NULL, 1);
SELECT pg_temp.jm_assert(
 (SELECT status = 'not_reviewed' AND source = 'manual' FROM public.job_material_lines WHERE id = '9e300000-0000-4000-8000-000000000001'),
 'a new line defaults to not_reviewed and manual');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 INSERT INTO public.job_material_lines (id, org_id, job_id, supplier_id, description, position)
 VALUES ('9e300000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001',
         '9e000000-0000-4000-8000-000000000002', '9e100000-0000-4000-8000-000000000001', 'Sheets', 1)
$q$), 'a line under a supplier not chosen for its job must be refused');
-- Moving a line is one update of supplier_id, to another supplier chosen for the job.
UPDATE public.job_material_lines SET supplier_id = '9e100000-0000-4000-8000-000000000002'
WHERE id = '9e300000-0000-4000-8000-000000000001';
UPDATE public.job_material_lines SET supplier_id = '9e100000-0000-4000-8000-000000000001'
WHERE id = '9e300000-0000-4000-8000-000000000001';

-- 4. Only the three hand-set statuses are stored; the text stays in shape.
UPDATE public.job_material_lines SET status = 'to_order' WHERE id = '9e300000-0000-4000-8000-000000000001';
UPDATE public.job_material_lines SET status = 'in_stock' WHERE id = '9e300000-0000-4000-8000-000000000001';
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_material_lines SET status = 'on_po' WHERE id = '9e300000-0000-4000-8000-000000000001'
$q$), 'on_po is worked out on read and must never be stored');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_material_lines SET status = 'delivered' WHERE id = '9e300000-0000-4000-8000-000000000001'
$q$), 'delivered is worked out on read and must never be stored');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_material_lines SET description = '' WHERE id = '9e300000-0000-4000-8000-000000000001'
$q$), 'an empty description must be refused');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_material_lines SET description = repeat('x', 301) WHERE id = '9e300000-0000-4000-8000-000000000001'
$q$), 'a description over 300 characters must be refused');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_material_lines SET quantity = -1 WHERE id = '9e300000-0000-4000-8000-000000000001'
$q$), 'a negative quantity must be refused');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_material_lines SET unit = repeat('x', 31) WHERE id = '9e300000-0000-4000-8000-000000000001'
$q$), 'a unit over 30 characters must be refused');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_material_lines SET source = 'agent' WHERE id = '9e300000-0000-4000-8000-000000000001'
$q$), 'a source other than manual or scope must be refused');

-- 5. A supplier with a line cannot be taken off; an empty one can.
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 DELETE FROM public.job_material_suppliers
 WHERE job_id = '9e000000-0000-4000-8000-000000000001' AND supplier_id = '9e100000-0000-4000-8000-000000000001'
$q$), 'a supplier with a line under it must not be taken off the job');
DELETE FROM public.job_material_suppliers
WHERE job_id = '9e000000-0000-4000-8000-000000000001' AND supplier_id = '9e100000-0000-4000-8000-000000000002';

-- 6. A line's order link clears when the order goes; the line stays.
UPDATE public.job_material_lines SET purchase_order_id = '9e200000-0000-4000-8000-000000000001'
WHERE id = '9e300000-0000-4000-8000-000000000001';
DELETE FROM public.purchase_orders WHERE id = '9e200000-0000-4000-8000-000000000001';
SELECT pg_temp.jm_assert(
 (SELECT purchase_order_id IS NULL FROM public.job_material_lines WHERE id = '9e300000-0000-4000-8000-000000000001'),
 'deleting an order must clear purchase_order_id on its lines and keep the lines');

-- 7. One pad and one sketch per job; the sketch is a bounded PNG data URL.
INSERT INTO public.job_dispatch_workings (job_id, org_id, working_out, sketch_png)
VALUES ('9e000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', '42 m run / 2.4 m bays',
        'data:image/png;base64,iVBORw0KGgo=');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 INSERT INTO public.job_dispatch_workings (job_id, org_id)
 VALUES ('9e000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001')
$q$), 'one workings row per job');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_dispatch_workings SET sketch_png = 'data:image/jpeg;base64,AAAA'
 WHERE job_id = '9e000000-0000-4000-8000-000000000001'
$q$), 'a sketch that is not a PNG data URL must be refused');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_dispatch_workings SET sketch_png = 'data:image/png;base64,' || repeat('A', 400000)
 WHERE job_id = '9e000000-0000-4000-8000-000000000001'
$q$), 'a sketch over 400,000 characters must be refused');
SELECT pg_temp.jm_assert(pg_temp.jm_refused($q$
 UPDATE public.job_dispatch_workings SET working_out = repeat('x', 20001)
 WHERE job_id = '9e000000-0000-4000-8000-000000000001'
$q$), 'working out over 20,000 characters must be refused');

-- 8. Everything goes with its job, in one delete.
DELETE FROM public.jobs WHERE id = '9e000000-0000-4000-8000-000000000001';
SELECT pg_temp.jm_assert(
 NOT EXISTS (SELECT 1 FROM public.job_material_lines WHERE job_id = '9e000000-0000-4000-8000-000000000001')
 AND NOT EXISTS (SELECT 1 FROM public.job_material_suppliers WHERE job_id = '9e000000-0000-4000-8000-000000000001')
 AND NOT EXISTS (SELECT 1 FROM public.job_dispatch_workings WHERE job_id = '9e000000-0000-4000-8000-000000000001'),
 'deleting a job must delete its chosen suppliers, lines and workings');

ROLLBACK;
