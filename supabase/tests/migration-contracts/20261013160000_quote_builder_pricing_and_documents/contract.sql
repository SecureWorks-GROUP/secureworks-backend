-- Contract: 20261013160000_quote_builder_pricing_and_documents. The pricing settings sit in a table no browser role can read,
-- seeded with the owner's two starting values and no target margin; only a known setting is kept,
-- one row each, at whatever number the owner sets; an issued quote holds at most one filed copy of
-- each extra document; and every other job_documents row is left exactly as free as before.
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

-- 1. Settings: locked away from the browser, seeded, one row per known setting.
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
 INSERT INTO public.quote_builder_settings (setting_key, amount) VALUES ('insurance_labour_rate_ex_gst', 130)
$q$), 'one row per setting: a second labour rate row must be refused');
-- The owner's later changes are ordinary writes, at any number he chooses: the figures are a goal
-- shown to the scoper, so the table holds no rule about their size.
UPDATE public.quote_builder_settings SET amount = 135 WHERE setting_key = 'insurance_labour_rate_ex_gst';
UPDATE public.quote_builder_settings SET amount = 0.9 WHERE setting_key = 'insurance_materials_multiplier';
INSERT INTO public.quote_builder_settings (setting_key, amount) VALUES ('target_margin_pct', 96);
SELECT pg_temp.qb_assert(
 (SELECT jsonb_object_agg(setting_key, amount) FROM public.quote_builder_settings
  WHERE org_id = '00000000-0000-0000-0000-000000000001')
 = '{"insurance_labour_rate_ex_gst": 135, "insurance_materials_multiplier": 0.9, "target_margin_pct": 96}'::jsonb,
 'the owner must be able to set any number on each of the three settings');

-- 2. Extra documents: one of each per version; nothing else on job_documents is narrowed.
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9b000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'processing', 'repair');
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
        '{"quote_builder_version_id":"9b000000-0000-4000-8000-0000000000a1","quote_builder_document":"another_document"}'),
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
