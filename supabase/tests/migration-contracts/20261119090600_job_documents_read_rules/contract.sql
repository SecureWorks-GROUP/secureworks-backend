-- Contract for 20261119090600_job_documents_read_rules. Four cases:
--   1. anon reads 0 document rows, with or without a token.
--   2. a signed-in trade reads 0 rows, and cannot insert or update one.
--   3. office staff in the company read its rows, and can insert and update.
--   4. office staff of another company read 0 of them.
-- Then the shape: no row rule applies to anon or PUBLIC, neither anon nor
-- PUBLIC holds a privilege on the table, authenticated and service_role keep
-- theirs, and the 2025 rules are gone.

BEGIN;

-- Fixed ids; nothing else uses them. trade_sees_all_jobs follows the
-- 20260925040000 backfill rule so that case's contract still holds.
INSERT INTO public.users (id, org_id, name, role, trade_sees_all_jobs) VALUES
  ('d0c00000-0000-4000-8000-000000000001', 'd0c00000-0000-4000-8000-0000000000a1', 'JD office', 'admin', true),
  ('d0c00000-0000-4000-8000-000000000003', 'd0c00000-0000-4000-8000-0000000000a1', 'JD trade', 'lead_installer', false),
  ('d0c00000-0000-4000-8000-000000000006', 'd0c00000-0000-4000-8000-0000000000b2', 'JD other office', 'admin', true);

INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('d0c00000-0000-4000-8000-0000000000f1', 'd0c00000-0000-4000-8000-0000000000a1', 'quoted', 'fencing', 'JD-FIXTURE-1');

INSERT INTO public.job_documents (id, job_id, type, sent_to_client, share_token) VALUES
  ('d0c00000-0000-4000-8000-0000000000d1', 'd0c00000-0000-4000-8000-0000000000f1', 'quote', true, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01'),
  ('d0c00000-0000-4000-8000-0000000000d2', 'd0c00000-0000-4000-8000-0000000000f1', 'quote', false, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02');

-- Fixture rows the current session can see; a refused read counts as 0.
CREATE FUNCTION pg_temp.jd_visible(p_token text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  SELECT count(*)::int INTO n FROM public.job_documents
  WHERE id IN ('d0c00000-0000-4000-8000-0000000000d1', 'd0c00000-0000-4000-8000-0000000000d2')
    AND (p_token IS NULL OR share_token = p_token);
  RETURN n;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN 0;
END $$;
CREATE FUNCTION pg_temp.jd_as(p_user uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
  SELECT NULL::void;
$$;
-- Fixture rows the current session updates (a no-op write); a refusal counts as 0.
CREATE FUNCTION pg_temp.jd_updated() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE public.job_documents SET type = type
  WHERE id IN ('d0c00000-0000-4000-8000-0000000000d1', 'd0c00000-0000-4000-8000-0000000000d2');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN 0;
END $$;
-- Whether the current session may add a document to the fixture job.
CREATE FUNCTION pg_temp.jd_inserts() RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.job_documents (job_id, type) VALUES ('d0c00000-0000-4000-8000-0000000000f1', 'quote');
  RETURN true;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN false;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.jd_visible(text), pg_temp.jd_as(uuid), pg_temp.jd_updated(), pg_temp.jd_inserts()
  TO anon, authenticated;

-- 1. anon ------------------------------------------------------------------------
SAVEPOINT anon_case;
SET LOCAL ROLE anon;
DO $$
DECLARE n int;
BEGIN
  n := pg_temp.jd_visible(NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: anon read % document rows without a token', n;
  END IF;
  n := pg_temp.jd_visible('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01');
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: anon read % document rows with a token', n;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT anon_case;

-- 2. a signed-in trade -----------------------------------------------------------------
SAVEPOINT trade_case;
SET LOCAL ROLE authenticated;
SELECT pg_temp.jd_as('d0c00000-0000-4000-8000-000000000003');
DO $$
DECLARE n int;
BEGIN
  n := pg_temp.jd_visible(NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: a trade read % document rows', n;
  END IF;
  n := pg_temp.jd_updated();
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: a trade updated % document rows', n;
  END IF;
  IF pg_temp.jd_inserts() THEN
    RAISE EXCEPTION 'jd-rules: a trade added a document';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT trade_case;

-- 3. office staff in the company -------------------------------------------------------
SAVEPOINT office_case;
SET LOCAL ROLE authenticated;
SELECT pg_temp.jd_as('d0c00000-0000-4000-8000-000000000001');
DO $$
DECLARE n int;
BEGIN
  n := pg_temp.jd_visible(NULL);
  IF n <> 2 THEN
    RAISE EXCEPTION 'jd-rules: office staff read % of their company''s 2 document rows', n;
  END IF;
  n := pg_temp.jd_updated();
  IF n <> 2 THEN
    RAISE EXCEPTION 'jd-rules: office staff updated % of their company''s 2 document rows', n;
  END IF;
  IF NOT pg_temp.jd_inserts() THEN
    RAISE EXCEPTION 'jd-rules: office staff could not add a document to their company''s job';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT office_case;

-- 4. office staff of another company -------------------------------------------------
SAVEPOINT other_case;
SET LOCAL ROLE authenticated;
SELECT pg_temp.jd_as('d0c00000-0000-4000-8000-000000000006');
DO $$
DECLARE n int;
BEGIN
  n := pg_temp.jd_visible(NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: another company''s office staff read % document rows', n;
  END IF;
  n := pg_temp.jd_updated();
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: another company''s office staff updated % document rows', n;
  END IF;
  IF pg_temp.jd_inserts() THEN
    RAISE EXCEPTION 'jd-rules: another company''s office staff added a document';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT other_case;

ROLLBACK;

-- Shape ------------------------------------------------------------------------------
DO $$
DECLARE problems text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
             AND roles && ARRAY['public', 'anon']::name[]) THEN
    problems := array_append(problems, 'a row rule applies to anon or PUBLIC'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
             AND policyname IN ('Public can view shared docs', 'Users can view job docs',
                                'Estimators+ can create docs', 'Estimators+ can update docs')) THEN
    problems := array_append(problems, 'a 2025 rule is still present'::text);
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
      AND policyname IN ('job_documents_office_read', 'job_documents_office_insert', 'job_documents_office_update')
      AND roles = ARRAY['authenticated']::name[]) <> 3 THEN
    problems := array_append(problems, 'the office rules are missing or not limited to authenticated'::text);
  END IF;
  IF has_table_privilege('anon', 'public.job_documents', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_any_column_privilege('anon', 'public.job_documents', 'SELECT, INSERT, UPDATE, REFERENCES') THEN
    problems := array_append(problems, 'anon still holds a privilege on job_documents'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
             WHERE c.oid = 'public.job_documents'::regclass AND a.grantee = 0) THEN
    problems := array_append(problems, 'PUBLIC holds a privilege on job_documents'::text);
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.job_documents', 'SELECT, INSERT, UPDATE')
     OR NOT has_table_privilege('service_role', 'public.job_documents', 'SELECT, INSERT, UPDATE, DELETE') THEN
    problems := array_append(problems, 'authenticated or service_role lost its grant on job_documents'::text);
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_documents'::regclass) THEN
    problems := array_append(problems, 'row level security is off'::text);
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'jd-rules: %', array_to_string(problems, '; ');
  END IF;
END $$;
