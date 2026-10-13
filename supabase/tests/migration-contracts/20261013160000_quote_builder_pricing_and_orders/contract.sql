-- Contract: 20261013160000_quote_builder_pricing_and_orders. The pricing settings sit in a table
-- no browser role can read, seeded with the owner's two starting values and no target margin; a
-- setting outside its bounds is refused; an issued quote holds at most one live crew work order,
-- one live purchase order per supplier and one filed copy of each extra document; and every row
-- that names no quote builder version is left exactly as free as before.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.qb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'quote builder pricing contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.qb_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation THEN
 RETURN true;
END $$;

-- 1. Settings: locked away from the browser, seeded, bounded.
SELECT pg_temp.qb_assert(
 (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.quote_builder_settings'::regclass),
 'row level security must be on for quote_builder_settings');
SELECT pg_temp.qb_assert(
 NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_builder_settings'),
 'quote_builder_settings must carry no policy: only the service role reads it');
SELECT pg_temp.qb_assert(
 NOT has_table_privilege('anon', 'public.quote_builder_settings', 'SELECT')
 AND NOT has_table_privilege('authenticated', 'public.quote_builder_settings', 'SELECT')
 AND NOT has_table_privilege('authenticated', 'public.quote_builder_settings', 'UPDATE')
 AND NOT has_table_privilege('authenticated', 'public.quote_builder_settings', 'INSERT'),
 'browser roles must hold no privilege on quote_builder_settings (what we charge is not a trade''s to read)');
SELECT pg_temp.qb_assert(
 has_table_privilege('service_role', 'public.quote_builder_settings', 'SELECT')
 AND has_table_privilege('service_role', 'public.quote_builder_settings', 'UPDATE')
 AND has_table_privilege('service_role', 'public.quote_builder_settings', 'DELETE'),
 'service_role (ops-api) must be able to read and change the settings');

SELECT pg_temp.qb_assert(
 (SELECT jsonb_object_agg(setting_key, amount) FROM public.quote_builder_settings
  WHERE org_id = '00000000-0000-0000-0000-000000000001')
 = '{"insurance_labour_rate_ex_gst": 120, "insurance_materials_multiplier": 1.6}'::jsonb,
 'the seed must be exactly the labour rate and the materials multiplier, and no target margin');

SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.quote_builder_settings (setting_key, amount) VALUES ('labour_rate', 100)
$q$), 'an unknown setting key must be refused');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 UPDATE public.quote_builder_settings SET amount = 0 WHERE setting_key = 'insurance_labour_rate_ex_gst'
$q$), 'a labour rate of zero must be refused');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 UPDATE public.quote_builder_settings SET amount = 1000.01 WHERE setting_key = 'insurance_labour_rate_ex_gst'
$q$), 'a labour rate above 1000 must be refused');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 UPDATE public.quote_builder_settings SET amount = 0.9 WHERE setting_key = 'insurance_materials_multiplier'
$q$), 'a materials multiplier below 1 must be refused: it would sell materials under cost');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.quote_builder_settings (setting_key, amount) VALUES ('target_margin_pct', 96)
$q$), 'a target margin above 95 must be refused');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.quote_builder_settings (setting_key, amount) VALUES ('insurance_labour_rate_ex_gst', 130)
$q$), 'one row per setting: a second labour rate row must be refused');
-- The owner's later changes are ordinary writes inside the bounds.
UPDATE public.quote_builder_settings SET amount = 135 WHERE setting_key = 'insurance_labour_rate_ex_gst';
INSERT INTO public.quote_builder_settings (setting_key, amount) VALUES ('target_margin_pct', 30);
SELECT pg_temp.qb_assert(
 (SELECT count(*) FROM public.quote_builder_settings) = 3, 'a target margin inside its bounds must be accepted');

-- 2. Orders made from a version.
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9b000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'processing', 'repair');
INSERT INTO public.quote_builder_versions (id, job_id, kind, chain_id, version)
VALUES ('9b000000-0000-4000-8000-0000000000a1', '9b000000-0000-4000-8000-000000000001', 'scope',
        '9b000000-0000-4000-8000-000000000001', 1),
       ('9b000000-0000-4000-8000-0000000000a2', '9b000000-0000-4000-8000-000000000001', 'variation',
        '9b000000-0000-4000-8000-0000000000c2', 1);

INSERT INTO public.work_orders (id, org_id, job_id, status, quote_builder_version_id)
VALUES ('9b000000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-000000000001',
        '9b000000-0000-4000-8000-000000000001', 'draft', '9b000000-0000-4000-8000-0000000000a1');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.work_orders (id, org_id, job_id, status, quote_builder_version_id)
 VALUES ('9b000000-0000-4000-8000-0000000000b2', '00000000-0000-0000-0000-000000000001',
         '9b000000-0000-4000-8000-000000000001', 'draft', '9b000000-0000-4000-8000-0000000000a1')
$q$), 'a second live work order for the same version must be refused');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.work_orders (id, org_id, job_id, status, quote_builder_version_id)
 VALUES ('9b000000-0000-4000-8000-0000000000b3', '00000000-0000-0000-0000-000000000001',
         '9b000000-0000-4000-8000-000000000001', 'draft', '9b000000-0000-4000-8000-0000000000ff')
$q$), 'a work order must not name a version that does not exist');
-- Another version, and work orders that name no version, are untouched.
INSERT INTO public.work_orders (id, org_id, job_id, status, quote_builder_version_id)
VALUES ('9b000000-0000-4000-8000-0000000000b4', '00000000-0000-0000-0000-000000000001',
        '9b000000-0000-4000-8000-000000000001', 'draft', '9b000000-0000-4000-8000-0000000000a2'),
       ('9b000000-0000-4000-8000-0000000000b5', '00000000-0000-0000-0000-000000000001',
        '9b000000-0000-4000-8000-000000000001', 'draft', NULL),
       ('9b000000-0000-4000-8000-0000000000b6', '00000000-0000-0000-0000-000000000001',
        '9b000000-0000-4000-8000-000000000001', 'draft', NULL);
-- A cancelled work order frees the version for a new one.
UPDATE public.work_orders SET status = 'cancelled' WHERE id = '9b000000-0000-4000-8000-0000000000b1';
INSERT INTO public.work_orders (id, org_id, job_id, status, quote_builder_version_id)
VALUES ('9b000000-0000-4000-8000-0000000000b7', '00000000-0000-0000-0000-000000000001',
        '9b000000-0000-4000-8000-000000000001', 'draft', '9b000000-0000-4000-8000-0000000000a1');
SELECT pg_temp.qb_assert(
 (SELECT count(*) FROM public.work_orders WHERE job_id = '9b000000-0000-4000-8000-000000000001') = 5,
 'a cancelled work order must free its version, and unlinked work orders must not collide');
SELECT pg_temp.qb_assert(
 (SELECT count(*) FROM public.work_orders WHERE job_id = '9b000000-0000-4000-8000-000000000001'
  AND quote_builder_version_id IS NOT NULL AND status <> 'cancelled' AND kind <> 'crew') = 0,
 'a work order made from a quote is a crew work order by default, never a job work order');

INSERT INTO public.purchase_orders (id, job_id, supplier_name, status, quote_builder_version_id)
VALUES ('9b000000-0000-4000-8000-0000000000e1', '9b000000-0000-4000-8000-000000000001', 'Bunnings', 'draft',
        '9b000000-0000-4000-8000-0000000000a1');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.purchase_orders (job_id, supplier_name, status, quote_builder_version_id)
 VALUES ('9b000000-0000-4000-8000-000000000001', 'BUNNINGS', 'draft', '9b000000-0000-4000-8000-0000000000a1')
$q$), 'a second live purchase order for the same version and supplier must be refused, whatever the case');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.purchase_orders (job_id, supplier_name, status, quote_builder_version_id)
 VALUES ('9b000000-0000-4000-8000-000000000001', 'Bunnings', 'draft', '9b000000-0000-4000-8000-0000000000ff')
$q$), 'a purchase order must not name a version that does not exist');
INSERT INTO public.purchase_orders (job_id, supplier_name, status, quote_builder_version_id)
VALUES ('9b000000-0000-4000-8000-000000000001', 'Stratco', 'draft', '9b000000-0000-4000-8000-0000000000a1'),
       ('9b000000-0000-4000-8000-000000000001', 'Bunnings', 'draft', '9b000000-0000-4000-8000-0000000000a2'),
       ('9b000000-0000-4000-8000-000000000001', 'Bunnings', 'draft', NULL),
       ('9b000000-0000-4000-8000-000000000001', 'Bunnings', 'draft', NULL);
UPDATE public.purchase_orders SET status = 'deleted' WHERE id = '9b000000-0000-4000-8000-0000000000e1';
INSERT INTO public.purchase_orders (id, job_id, supplier_name, status, quote_builder_version_id)
VALUES ('9b000000-0000-4000-8000-0000000000e2', '9b000000-0000-4000-8000-000000000001', 'Bunnings', 'draft',
        '9b000000-0000-4000-8000-0000000000a1');
UPDATE public.purchase_orders SET status = 'cancelled' WHERE id = '9b000000-0000-4000-8000-0000000000e2';
INSERT INTO public.purchase_orders (job_id, supplier_name, status, quote_builder_version_id)
VALUES ('9b000000-0000-4000-8000-000000000001', 'Bunnings', 'draft', '9b000000-0000-4000-8000-0000000000a1');
SELECT pg_temp.qb_assert(
 (SELECT count(*) FROM public.purchase_orders WHERE job_id = '9b000000-0000-4000-8000-000000000001') = 7,
 'another supplier, another version, unlinked orders and a deleted or cancelled order must not collide');

-- 3. Extra documents: one of each per version; nothing else on job_documents is narrowed.
INSERT INTO public.job_documents (job_id, type, version, metadata)
VALUES ('9b000000-0000-4000-8000-000000000001', 'other', 1,
        '{"quote_builder_version_id":"9b000000-0000-4000-8000-0000000000a1","quote_builder_document":"scope_of_works"}');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.job_documents (job_id, type, version, metadata)
 VALUES ('9b000000-0000-4000-8000-000000000001', 'other', 1,
         '{"quote_builder_version_id":"9b000000-0000-4000-8000-0000000000a1","quote_builder_document":"scope_of_works"}')
$q$), 'a second scope of works for the same version must be refused');
INSERT INTO public.job_documents (job_id, type, version, metadata)
VALUES ('9b000000-0000-4000-8000-000000000001', 'other', 1,
        '{"quote_builder_version_id":"9b000000-0000-4000-8000-0000000000a1","quote_builder_document":"material_order_list"}'),
       ('9b000000-0000-4000-8000-000000000001', 'other', 1,
        '{"quote_builder_version_id":"9b000000-0000-4000-8000-0000000000a2","quote_builder_document":"scope_of_works"}'),
       ('9b000000-0000-4000-8000-000000000001', 'other', 1, '{}'),
       ('9b000000-0000-4000-8000-000000000001', 'other', 1, '{}'),
       ('9b000000-0000-4000-8000-000000000001', 'general', 1,
        '{"quote_builder_version_id":"9b000000-0000-4000-8000-0000000000a1","quote_builder_document":"scope_of_works"}');
SELECT pg_temp.qb_assert(
 (SELECT count(*) FROM public.job_documents WHERE job_id = '9b000000-0000-4000-8000-000000000001') = 6,
 'the other document, another version, plain other documents and other types must not collide');

ROLLBACK;
