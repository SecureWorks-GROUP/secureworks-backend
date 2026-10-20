-- Contract: 20261020150000_dispatch_line_receipts. The receipts table sits where no browser role can
-- read or write it and the service role cannot delete from it; a receipt is positive, dated no later
-- than today in Perth, on its line's job and its line's current order; rows are append-only (the one
-- change is a void, once, naming a person; never a delete); a line with a receipt cannot be deleted;
-- and a line's purchase_order_attached_at is stamped by the database alone when its order changes.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.lr_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'dispatch line receipts contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.lr_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
 RETURN true;
END $$;

-- 1. Locked away from the browser; ops-api may read, insert and update, never delete.
DO $$
DECLARE p text;
BEGIN
 PERFORM pg_temp.lr_assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_material_line_receipts'::regclass),
  'row level security must be on');
 PERFORM pg_temp.lr_assert(NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
   AND tablename = 'job_material_line_receipts'), 'the receipts table must carry no policy');
 FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
  PERFORM pg_temp.lr_assert(NOT has_table_privilege('anon', 'public.job_material_line_receipts', p)
    AND NOT has_table_privilege('authenticated', 'public.job_material_line_receipts', p),
   format('browser roles must hold no %s on the receipts', p));
 END LOOP;
 FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
  PERFORM pg_temp.lr_assert(has_table_privilege('service_role', 'public.job_material_line_receipts', p),
   format('service_role (ops-api) must be able to %s the receipts', p));
 END LOOP;
 PERFORM pg_temp.lr_assert(NOT has_table_privilege('service_role', 'public.job_material_line_receipts', 'DELETE')
   AND NOT has_table_privilege('service_role', 'public.job_material_line_receipts', 'TRUNCATE'),
  'service_role must not be able to delete receipts');
 PERFORM pg_temp.lr_assert(NOT has_function_privilege('anon', 'public.dispatch_line_receipt_guard()', 'EXECUTE')
   AND NOT has_function_privilege('authenticated', 'public.dispatch_line_po_attached_stamp()', 'EXECUTE'),
  'browser roles must not execute the trigger functions');
END $$;

-- The line keeps its foreign key to its receipts as RESTRICT.
SELECT pg_temp.lr_assert((SELECT confdeltype = 'r' FROM pg_constraint
  WHERE conrelid = 'public.job_material_line_receipts'::regclass AND contype = 'f'
    AND confrelid = 'public.job_material_lines'::regclass),
 'line_id must reference job_material_lines ON DELETE RESTRICT');
SELECT pg_temp.lr_assert((SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'job_material_lines'
    AND column_name = 'purchase_order_attached_at' AND is_nullable = 'YES' AND column_default IS NULL
    AND data_type = 'timestamp with time zone') = 1,
 'job_material_lines must carry a nullable purchase_order_attached_at with no default');

-- 2. Fixtures.
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9f000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'order_materials', 'patio'),
       ('9f000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing');
INSERT INTO public.users (id, org_id, name)
VALUES ('9f400000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Contract Person')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.suppliers (id, name) VALUES ('9f100000-0000-4000-8000-000000000001', 'Example Panels');
INSERT INTO public.purchase_orders (id, job_id, po_number)
VALUES ('9f200000-0000-4000-8000-000000000001', '9f000000-0000-4000-8000-000000000001', 'PO-S5-1'),
       ('9f200000-0000-4000-8000-000000000002', '9f000000-0000-4000-8000-000000000001', 'PO-S5-2');
INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
VALUES ('00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
        '9f100000-0000-4000-8000-000000000001', 'Example Panels', 1);
INSERT INTO public.job_material_lines (id, org_id, job_id, supplier_id, description, quantity, status, position)
VALUES ('9f300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
        '9f000000-0000-4000-8000-000000000001', '9f100000-0000-4000-8000-000000000001', 'Panels', 42, 'to_order', 1),
       ('9f300000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001',
        '9f000000-0000-4000-8000-000000000001', '9f100000-0000-4000-8000-000000000001', 'Rails', 10, 'to_order', 2);

-- 3. The stamp: null off an order, now() when it goes on one, never set by a writer.
SELECT pg_temp.lr_assert((SELECT purchase_order_attached_at IS NULL FROM public.job_material_lines
  WHERE id = '9f300000-0000-4000-8000-000000000001'), 'a line on no order has no stamp');
UPDATE public.job_material_lines SET purchase_order_id = '9f200000-0000-4000-8000-000000000001'
 WHERE id IN ('9f300000-0000-4000-8000-000000000001', '9f300000-0000-4000-8000-000000000002');
SELECT pg_temp.lr_assert((SELECT purchase_order_attached_at = now() FROM public.job_material_lines
  WHERE id = '9f300000-0000-4000-8000-000000000001'), 'a line put on an order is stamped with the time');
UPDATE public.job_material_lines SET purchase_order_attached_at = '2000-01-01T00:00:00Z', description = 'Panels 2.4m'
 WHERE id = '9f300000-0000-4000-8000-000000000001';
SELECT pg_temp.lr_assert((SELECT purchase_order_attached_at = now() FROM public.job_material_lines
  WHERE id = '9f300000-0000-4000-8000-000000000001'), 'a writer cannot set the stamp by hand');
UPDATE public.job_material_lines SET purchase_order_id = NULL WHERE id = '9f300000-0000-4000-8000-000000000002';
SELECT pg_temp.lr_assert((SELECT purchase_order_attached_at IS NULL FROM public.job_material_lines
  WHERE id = '9f300000-0000-4000-8000-000000000002'), 'a line taken off its order loses the stamp');
INSERT INTO public.job_material_lines (id, org_id, job_id, supplier_id, description, quantity, purchase_order_id, position,
                                       purchase_order_attached_at)
VALUES ('9f300000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001',
        '9f000000-0000-4000-8000-000000000001', '9f100000-0000-4000-8000-000000000001', 'Posts', 4,
        '9f200000-0000-4000-8000-000000000001', 3, '2000-01-01T00:00:00Z');
SELECT pg_temp.lr_assert((SELECT purchase_order_attached_at = now() FROM public.job_material_lines
  WHERE id = '9f300000-0000-4000-8000-000000000003'), 'a line inserted on an order is stamped by the database');

-- 4. A good receipt lands, live, with no void.
INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on,
                                               note, created_by, created_by_email)
VALUES ('9f500000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
        '9f000000-0000-4000-8000-000000000001', '9f300000-0000-4000-8000-000000000001',
        '9f200000-0000-4000-8000-000000000001', 18, (now() AT TIME ZONE 'Australia/Perth')::date, 'First part',
        '9f400000-0000-4000-8000-000000000001', 'person@example.test');
SELECT pg_temp.lr_assert((SELECT quantity = 18 AND voided_at IS NULL FROM public.job_material_line_receipts
  WHERE id = '9f500000-0000-4000-8000-000000000001'), 'a receipt must land live');

-- 5. Refusals on insert.
SELECT pg_temp.lr_assert(pg_temp.lr_refused(format($q$
 INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on, created_by_email)
 VALUES ('9f500000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
         '9f300000-0000-4000-8000-000000000001', '9f200000-0000-4000-8000-000000000001', 1, %L, 'person@example.test')
$q$, (now() AT TIME ZONE 'Australia/Perth')::date)), 'a second row with the same id must be refused');
SELECT pg_temp.lr_assert(pg_temp.lr_refused(format($q$
 INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on, created_by_email)
 VALUES ('9f500000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
         '9f300000-0000-4000-8000-000000000001', '9f200000-0000-4000-8000-000000000001', 0, %L, 'person@example.test')
$q$, (now() AT TIME ZONE 'Australia/Perth')::date)), 'a quantity of 0 must be refused');
SELECT pg_temp.lr_assert(pg_temp.lr_refused(format($q$
 INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on, created_by_email)
 VALUES ('9f500000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
         '9f300000-0000-4000-8000-000000000001', '9f200000-0000-4000-8000-000000000001', 1, %L, 'person@example.test')
$q$, (now() AT TIME ZONE 'Australia/Perth')::date + 1)), 'a receipt dated after today in Perth must be refused');
SELECT pg_temp.lr_assert(pg_temp.lr_refused(format($q$
 INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on, created_by_email)
 VALUES ('9f500000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
         '9f300000-0000-4000-8000-000000000001', '9f200000-0000-4000-8000-000000000002', 1, %L, 'person@example.test')
$q$, (now() AT TIME ZONE 'Australia/Perth')::date)), 'a receipt naming another order than its line''s must be refused');
SELECT pg_temp.lr_assert(pg_temp.lr_refused(format($q$
 INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on, created_by_email)
 VALUES ('9f500000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000002',
         '9f300000-0000-4000-8000-000000000001', '9f200000-0000-4000-8000-000000000001', 1, %L, 'person@example.test')
$q$, (now() AT TIME ZONE 'Australia/Perth')::date)), 'a receipt on another job than its line''s must be refused');
SELECT pg_temp.lr_assert(pg_temp.lr_refused(format($q$
 INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on, created_by_email)
 VALUES ('9f500000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
         '9f300000-0000-4000-8000-000000000002', '9f200000-0000-4000-8000-000000000001', 1, %L, 'person@example.test')
$q$, (now() AT TIME ZONE 'Australia/Perth')::date)), 'a receipt for a line on no order must be refused');
SELECT pg_temp.lr_assert(pg_temp.lr_refused(format($q$
 INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on, note, created_by_email)
 VALUES ('9f500000-0000-4000-8000-000000000015', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
         '9f300000-0000-4000-8000-000000000001', '9f200000-0000-4000-8000-000000000001', 1, %L, repeat('x', 301), 'person@example.test')
$q$, (now() AT TIME ZONE 'Australia/Perth')::date)), 'a note over 300 characters must be refused');
SELECT pg_temp.lr_assert(pg_temp.lr_refused(format($q$
 INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on, created_by_email)
 VALUES ('9f500000-0000-4000-8000-000000000016', '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
         '9f300000-0000-4000-8000-000000000001', '9f200000-0000-4000-8000-000000000001', 1, %L, NULL)
$q$, (now() AT TIME ZONE 'Australia/Perth')::date)), 'a receipt that names no person must be refused');

-- 6. Append-only: no edit, no unnamed void, no delete; one named void; then frozen.
SELECT pg_temp.lr_assert(pg_temp.lr_refused($q$
 UPDATE public.job_material_line_receipts SET quantity = 20 WHERE id = '9f500000-0000-4000-8000-000000000001'
$q$), 'a receipt''s quantity must never be edited');
SELECT pg_temp.lr_assert(pg_temp.lr_refused($q$
 UPDATE public.job_material_line_receipts SET voided_at = now() WHERE id = '9f500000-0000-4000-8000-000000000001'
$q$), 'a void must name a person');
SELECT pg_temp.lr_assert(pg_temp.lr_refused($q$
 UPDATE public.job_material_line_receipts SET voided_at = now(), voided_by_email = 'person@example.test', quantity = 2
  WHERE id = '9f500000-0000-4000-8000-000000000001'
$q$), 'a void must change nothing else');
SELECT pg_temp.lr_assert(pg_temp.lr_refused($q$
 DELETE FROM public.job_material_line_receipts WHERE id = '9f500000-0000-4000-8000-000000000001'
$q$), 'a receipt must never be deleted');
SELECT pg_temp.lr_assert(pg_temp.lr_refused($q$
 DELETE FROM public.job_material_lines WHERE id = '9f300000-0000-4000-8000-000000000001'
$q$), 'a line with a receipt must not be deleted');
UPDATE public.job_material_line_receipts
   SET voided_at = now(), voided_by = '9f400000-0000-4000-8000-000000000001', voided_by_email = 'person@example.test'
 WHERE id = '9f500000-0000-4000-8000-000000000001';
SELECT pg_temp.lr_assert((SELECT voided_at IS NOT NULL AND quantity = 18 FROM public.job_material_line_receipts
  WHERE id = '9f500000-0000-4000-8000-000000000001'), 'a named void must land and keep the row');
SELECT pg_temp.lr_assert(pg_temp.lr_refused($q$
 UPDATE public.job_material_line_receipts SET voided_at = NULL, voided_by = NULL, voided_by_email = NULL
  WHERE id = '9f500000-0000-4000-8000-000000000001'
$q$), 'a voided receipt must never be un-voided');
SELECT pg_temp.lr_assert(pg_temp.lr_refused($q$
 DELETE FROM public.job_material_lines WHERE id = '9f300000-0000-4000-8000-000000000001'
$q$), 'a line with a voided receipt must still not be deleted');

ROLLBACK;

-- R2-2 (V round 3 probe): the down refuses while a receipt exists. The down carries its own
-- BEGIN/COMMIT, so the fixtures and one receipt go in an outer transaction and the down runs with
-- ON_ERROR_STOP off: its refusal turns its COMMIT into a ROLLBACK of everything. Had it not refused,
-- its COMMIT would have committed the drops, so the table still existing proves the refusal.
\set ON_ERROR_STOP on
BEGIN;
-- 2. Fixtures.
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9f000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'order_materials', 'patio'),
       ('9f000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing');
INSERT INTO public.users (id, org_id, name)
VALUES ('9f400000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Contract Person')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.suppliers (id, name) VALUES ('9f100000-0000-4000-8000-000000000001', 'Example Panels');
INSERT INTO public.purchase_orders (id, job_id, po_number)
VALUES ('9f200000-0000-4000-8000-000000000001', '9f000000-0000-4000-8000-000000000001', 'PO-S5-1'),
       ('9f200000-0000-4000-8000-000000000002', '9f000000-0000-4000-8000-000000000001', 'PO-S5-2');
INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
VALUES ('00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
        '9f100000-0000-4000-8000-000000000001', 'Example Panels', 1);
INSERT INTO public.job_material_lines (id, org_id, job_id, supplier_id, description, quantity, status, position)
VALUES ('9f300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
        '9f000000-0000-4000-8000-000000000001', '9f100000-0000-4000-8000-000000000001', 'Panels', 42, 'to_order', 1),
       ('9f300000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001',
        '9f000000-0000-4000-8000-000000000001', '9f100000-0000-4000-8000-000000000001', 'Rails', 10, 'to_order', 2);
UPDATE public.job_material_lines SET purchase_order_id = '9f200000-0000-4000-8000-000000000001' WHERE id = '9f300000-0000-4000-8000-000000000001';
INSERT INTO public.job_material_line_receipts (id, org_id, job_id, line_id, purchase_order_id, quantity, received_on,
                                               note, created_by, created_by_email)
VALUES ('9f500000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001',
        '9f000000-0000-4000-8000-000000000001', '9f300000-0000-4000-8000-000000000001',
        '9f200000-0000-4000-8000-000000000001', 18, (now() AT TIME ZONE 'Australia/Perth')::date, 'First part',
        '9f400000-0000-4000-8000-000000000001', 'person@example.test');
\set ON_ERROR_STOP off
\ir ../../../rollbacks/20261020150000_dispatch_line_receipts_down.sql
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.job_material_line_receipts') IS NULL
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'job_material_lines' AND column_name = 'purchase_order_attached_at') THEN
  RAISE EXCEPTION 'dispatch line receipts contract: the down must refuse while a receipt exists';
 END IF;
 IF EXISTS (SELECT 1 FROM public.jobs WHERE id = '9f000000-0000-4000-8000-000000000001') THEN
  RAISE EXCEPTION 'dispatch line receipts contract: the refused down must roll back the whole transaction';
 END IF;
END $$;
