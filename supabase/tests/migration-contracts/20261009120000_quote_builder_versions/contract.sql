-- Contract: 20261009120000_quote_builder_versions. One table, browser roles locked out, one
-- version number per chain, the scope chain is the job's own id, issuing needs a PDF and a quote
-- number, an issued version is frozen against update and delete, a private quote job is
-- minted once per request id, and job_media takes the 'quote_builder' phase beside every phase it
-- took before.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.qb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'quote builder contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.qb_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN check_violation OR unique_violation THEN
 RETURN true;
END $$;

SELECT pg_temp.qb_assert(
 (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.quote_builder_versions'::regclass),
 'row level security must be on');
SELECT pg_temp.qb_assert(
 NOT has_table_privilege('anon', 'public.quote_builder_versions', 'SELECT')
 AND NOT has_table_privilege('authenticated', 'public.quote_builder_versions', 'SELECT')
 AND NOT has_table_privilege('authenticated', 'public.quote_builder_versions', 'INSERT'),
 'browser roles must hold no privilege on quote_builder_versions (internal costs live here)');
SELECT pg_temp.qb_assert(
 has_table_privilege('service_role', 'public.quote_builder_versions', 'INSERT')
 AND has_table_privilege('service_role', 'public.quote_builder_versions', 'UPDATE'),
 'service_role (ops-api) must be able to write');

INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9a000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'processing', 'repair');
INSERT INTO public.job_documents (id, job_id, type, file_name, storage_url, version)
VALUES ('9a000000-0000-4000-8000-0000000000d1', '9a000000-0000-4000-8000-000000000001', 'quote',
 'q.pdf', 'https://example.invalid/q.pdf', 1);

INSERT INTO public.quote_builder_versions (id, job_id, kind, chain_id, version, cost_lines, charge_lines)
VALUES ('9a000000-0000-4000-8000-0000000000a1', '9a000000-0000-4000-8000-000000000001', 'scope',
 '9a000000-0000-4000-8000-000000000001', 1, '[{"line_id":"c1"}]', '[{"line_id":"q1"}]');

SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.quote_builder_versions (job_id, kind, chain_id, version)
 VALUES ('9a000000-0000-4000-8000-000000000001', 'scope', '9a000000-0000-4000-8000-000000000001', 1)
$q$), 'a second version 1 on the same chain must be refused');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.quote_builder_versions (job_id, kind, chain_id, version)
 VALUES ('9a000000-0000-4000-8000-000000000001', 'scope', '9a000000-0000-4000-8000-0000000000ff', 1)
$q$), 'the scope chain must be the job''s own id');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.quote_builder_versions (job_id, kind, chain_id, version)
 VALUES ('9a000000-0000-4000-8000-000000000001', 'variation', '9a000000-0000-4000-8000-000000000001', 1)
$q$), 'a variation chain must not reuse the scope chain id');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.quote_builder_versions (job_id, kind, chain_id, version, cost_lines)
 VALUES ('9a000000-0000-4000-8000-000000000001', 'variation', '9a000000-0000-4000-8000-0000000000ee', 1, '{}')
$q$), 'cost_lines must be an array');

-- A private quote job is minted once per request id; other job types and jobs without one are untouched.
INSERT INTO public.jobs (id, org_id, status, type, metadata)
VALUES ('9a000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'draft', 'miscellaneous',
 '{"quote_builder":{"request_id":"9a000000-0000-4000-8000-0000000000e1"}}');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.jobs (id, org_id, status, type, metadata)
 VALUES ('9a000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'draft', 'miscellaneous',
  '{"quote_builder":{"request_id":"9a000000-0000-4000-8000-0000000000e1"}}')
$q$), 'a second private quote job for the same request id must be refused');
INSERT INTO public.jobs (id, org_id, status, type, metadata)
VALUES ('9a000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'draft', 'miscellaneous', '{}'),
       ('9a000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'draft', 'miscellaneous', '{}');
SELECT pg_temp.qb_assert(
 (SELECT count(*) FROM public.jobs WHERE type = 'miscellaneous' AND metadata = '{}'::jsonb) >= 2,
 'miscellaneous jobs without a quote builder request id must not collide');

-- Quote builder photos have their own job_media phase; every earlier phase is still accepted.
INSERT INTO public.job_media (job_id, phase, type, storage_url)
SELECT '9a000000-0000-4000-8000-000000000001', p, 'photo', 'https://example.invalid/' || p || '.jpg'
FROM unnest(ARRAY['scope', 'in_progress', 'completion', 'receipt', 'marketing', 'neighbour_signoff',
 'issue', 'quote_builder']) AS p;
SELECT pg_temp.qb_assert(
 (SELECT count(*) FROM public.job_media WHERE job_id = '9a000000-0000-4000-8000-000000000001') = 8,
 'job_media must accept the quote_builder phase and every earlier phase');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 INSERT INTO public.job_media (job_id, phase, type) VALUES ('9a000000-0000-4000-8000-000000000001', 'nope', 'photo')
$q$), 'job_media must still refuse an unknown phase');

-- A draft is editable and its updated_at moves.
UPDATE public.quote_builder_versions SET updated_at = '2026-01-01T00:00:00Z' WHERE id = '9a000000-0000-4000-8000-0000000000a1';
SELECT pg_temp.qb_assert(
 (SELECT updated_at > '2026-01-01T00:00:00Z' FROM public.quote_builder_versions WHERE id = '9a000000-0000-4000-8000-0000000000a1'),
 'the guard must stamp updated_at on every draft write');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 UPDATE public.quote_builder_versions SET version = 2 WHERE id = '9a000000-0000-4000-8000-0000000000a1'
$q$), 'a version''s number must never change');

-- Issuing needs the PDF document and a quote number.
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 UPDATE public.quote_builder_versions SET status = 'issued', issued_at = now()
 WHERE id = '9a000000-0000-4000-8000-0000000000a1'
$q$), 'an issue without a PDF document must be refused');
UPDATE public.quote_builder_versions
SET status = 'issued', issued_at = now(), quote_number = 'SWR-26001-Q1',
    client_pdf_document_id = '9a000000-0000-4000-8000-0000000000d1'
WHERE id = '9a000000-0000-4000-8000-0000000000a1';

SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 UPDATE public.quote_builder_versions SET narrative = 'changed after issue'
 WHERE id = '9a000000-0000-4000-8000-0000000000a1'
$q$), 'an issued version must be frozen against update');
SELECT pg_temp.qb_assert(pg_temp.qb_refused($q$
 DELETE FROM public.quote_builder_versions WHERE id = '9a000000-0000-4000-8000-0000000000a1'
$q$), 'an issued version must be frozen against delete');

-- The next edit after an issue is a new version on the same chain.
INSERT INTO public.quote_builder_versions (job_id, kind, chain_id, version)
VALUES ('9a000000-0000-4000-8000-000000000001', 'scope', '9a000000-0000-4000-8000-000000000001', 2);
SELECT pg_temp.qb_assert(
 (SELECT count(*) FROM public.quote_builder_versions WHERE job_id = '9a000000-0000-4000-8000-000000000001') = 2,
 'version 2 must sit beside the frozen version 1');

ROLLBACK;
