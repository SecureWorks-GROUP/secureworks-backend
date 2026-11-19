-- Contract for 20261119090600_job_documents_read_rules.
-- 1. Behaviour, under each API role:
--    a. anon reads no document row from the table, with or without a token.
--    b. anon with the right token on a sent document gets exactly that one
--       row from job_document_by_share_token; a wrong, empty or null token,
--       or the token of an unsent document, gets none.
--    c. a signed-in trade, estimator or roleless account reads and updates
--       no row; office staff read and update their own organisation's rows
--       and none of another organisation's.
--    d. service_role is unaffected.
-- 2. Shape: the three 2025 rules are gone, the insert rule is unchanged, no
--    read or update rule applies to anon or PUBLIC, and both functions are
--    SECURITY DEFINER with an empty search_path.

BEGIN;

-- Fixed ids; nothing else uses them. trade_sees_all_jobs follows the
-- 20260925040000 backfill rule so that case's contract still holds.
INSERT INTO public.users (id, org_id, name, role, trade_sees_all_jobs) VALUES
  ('d0c00000-0000-4000-8000-000000000001', 'd0c00000-0000-4000-8000-0000000000a1', 'JD admin', 'admin', true),
  ('d0c00000-0000-4000-8000-000000000002', 'd0c00000-0000-4000-8000-0000000000a1', 'JD sales', 'sales', false),
  ('d0c00000-0000-4000-8000-000000000003', 'd0c00000-0000-4000-8000-0000000000a1', 'JD lead installer', 'lead_installer', false),
  ('d0c00000-0000-4000-8000-000000000004', 'd0c00000-0000-4000-8000-0000000000a1', 'JD estimator', 'estimator', false),
  ('d0c00000-0000-4000-8000-000000000005', 'd0c00000-0000-4000-8000-0000000000a1', 'JD no role', NULL, false),
  ('d0c00000-0000-4000-8000-000000000006', 'd0c00000-0000-4000-8000-0000000000b2', 'JD other org admin', 'admin', true);

INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, site_suburb) VALUES
  ('d0c00000-0000-4000-8000-0000000000f1', 'd0c00000-0000-4000-8000-0000000000a1', 'quoted', 'fencing', 'JD-FIXTURE-1', 'Fixture client', 'Fixture suburb'),
  ('d0c00000-0000-4000-8000-0000000000f2', 'd0c00000-0000-4000-8000-0000000000b2', 'quoted', 'fencing', 'JD-FIXTURE-2', 'Other client', 'Other suburb');

INSERT INTO public.job_documents (id, job_id, type, version, pdf_url, data_snapshot_json, sent_to_client, sent_at, share_token) VALUES
  ('d0c00000-0000-4000-8000-0000000000d1', 'd0c00000-0000-4000-8000-0000000000f1', 'quote', 1, 'https://example.invalid/d1.pdf', '{"fixture":"snapshot"}', true, '2026-11-01T00:00:00Z', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01'),
  ('d0c00000-0000-4000-8000-0000000000d2', 'd0c00000-0000-4000-8000-0000000000f1', 'quote', 2, 'https://example.invalid/d2.pdf', NULL, false, NULL, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02'),
  ('d0c00000-0000-4000-8000-0000000000d3', 'd0c00000-0000-4000-8000-0000000000f2', 'quote', 1, 'https://example.invalid/d3.pdf', NULL, true, '2026-11-01T00:00:00Z', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03');

-- Fixture rows the current session can see through the table.
CREATE FUNCTION pg_temp.jd_visible() RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.job_documents
  WHERE id IN ('d0c00000-0000-4000-8000-0000000000d1', 'd0c00000-0000-4000-8000-0000000000d2',
               'd0c00000-0000-4000-8000-0000000000d3')
$$;
-- Fixture rows the current session updates (a no-op write to viewed_at).
CREATE FUNCTION pg_temp.jd_updated() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE public.job_documents SET viewed_at = viewed_at
  WHERE id IN ('d0c00000-0000-4000-8000-0000000000d1', 'd0c00000-0000-4000-8000-0000000000d2',
               'd0c00000-0000-4000-8000-0000000000d3');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
CREATE FUNCTION pg_temp.jd_as(p_user uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', CASE WHEN p_user IS NULL THEN '{}' ELSE json_build_object('sub', p_user)::text END, true);
  SELECT NULL::void;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.jd_visible(), pg_temp.jd_updated(), pg_temp.jd_as(uuid)
  TO anon, authenticated, service_role;

-- 1a/1b. anon -------------------------------------------------------------------
SAVEPOINT anon_reads;
SET LOCAL ROLE anon;
SELECT pg_temp.jd_as(NULL);
DO $$
DECLARE n int; r record;
BEGIN
  n := pg_temp.jd_visible();
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: anon read % document rows without a token', n;
  END IF;
  SELECT count(*) INTO n FROM public.job_documents WHERE share_token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: anon read % document rows from the table by token', n;
  END IF;
  SELECT count(*) INTO n FROM public.job_document_by_share_token('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01');
  IF n <> 1 THEN
    RAISE EXCEPTION 'jd-rules: anon with the token got % rows, not 1', n;
  END IF;
  SELECT * INTO r FROM public.job_document_by_share_token('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01');
  IF r.id <> 'd0c00000-0000-4000-8000-0000000000d1' OR r.client_name IS DISTINCT FROM 'Fixture client'
     OR r.pdf_url IS DISTINCT FROM 'https://example.invalid/d1.pdf' THEN
    RAISE EXCEPTION 'jd-rules: anon with the token got the wrong document';
  END IF;
  SELECT count(*) INTO n FROM public.job_document_by_share_token('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02');
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: the token of an unsent document returned % rows', n;
  END IF;
  SELECT count(*) INTO n FROM public.job_document_by_share_token('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa99');
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: a wrong token returned % rows', n;
  END IF;
  SELECT count(*) INTO n FROM public.job_document_by_share_token('');
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: an empty token returned % rows', n;
  END IF;
  SELECT count(*) INTO n FROM public.job_document_by_share_token(NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: a null token returned % rows', n;
  END IF;
  n := pg_temp.jd_updated();
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: anon updated % document rows', n;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT anon_reads;

-- 1c. signed-in callers -------------------------------------------------------------
-- Each row: the user, the rows they must see and update.
CREATE FUNCTION pg_temp.jd_expect(p_user uuid, p_label text, p_rows int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE seen int; changed int;
BEGIN
  PERFORM pg_temp.jd_as(p_user);
  seen := pg_temp.jd_visible();
  changed := pg_temp.jd_updated();
  IF seen <> p_rows THEN
    RAISE EXCEPTION 'jd-rules: % read % document rows, expected %', p_label, seen, p_rows;
  END IF;
  IF changed <> p_rows THEN
    RAISE EXCEPTION 'jd-rules: % updated % document rows, expected %', p_label, changed, p_rows;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.jd_expect(uuid, text, int) TO authenticated;

SAVEPOINT signed_in;
SET LOCAL ROLE authenticated;
SELECT pg_temp.jd_expect('d0c00000-0000-4000-8000-000000000003', 'a trade', 0);
SELECT pg_temp.jd_expect('d0c00000-0000-4000-8000-000000000004', 'an estimator', 0);
SELECT pg_temp.jd_expect('d0c00000-0000-4000-8000-000000000005', 'a roleless account', 0);
SELECT pg_temp.jd_expect(NULL, 'a session with no user', 0);
SELECT pg_temp.jd_expect('d0c00000-0000-4000-8000-000000000006', 'office staff of another organisation', 1);
SELECT pg_temp.jd_expect('d0c00000-0000-4000-8000-000000000001', 'an admin', 2);
SELECT pg_temp.jd_expect('d0c00000-0000-4000-8000-000000000002', 'sales staff', 2);
DO $$
DECLARE n int;
BEGIN
  PERFORM pg_temp.jd_as('d0c00000-0000-4000-8000-000000000001');
  SELECT count(*) INTO n FROM public.job_documents WHERE id = 'd0c00000-0000-4000-8000-0000000000d3';
  IF n <> 0 THEN
    RAISE EXCEPTION 'jd-rules: an admin read another organisation''s document';
  END IF;
  BEGIN
    UPDATE public.job_documents SET job_id = 'd0c00000-0000-4000-8000-0000000000f2'
    WHERE id = 'd0c00000-0000-4000-8000-0000000000d1';
    RAISE EXCEPTION 'jd-rules: an admin moved a document into another organisation''s job';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK TO SAVEPOINT signed_in;

-- 1d. service_role ------------------------------------------------------------------
SAVEPOINT service;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF pg_temp.jd_visible() <> 3 THEN
    RAISE EXCEPTION 'jd-rules: service_role no longer reads every document';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT service;

ROLLBACK;

-- 2. Shape -------------------------------------------------------------------------
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
  cols text[];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
             AND policyname IN ('Public can view shared docs', 'Users can view job docs', 'Estimators+ can update docs')) THEN
    problems := array_append(problems, 'a 2025 read or update rule is still present'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
             AND cmd IN ('SELECT', 'UPDATE', 'ALL') AND roles && ARRAY['public', 'anon']::name[]) THEN
    problems := array_append(problems, 'a read or update rule applies to anon or PUBLIC'::text);
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
      AND policyname IN ('job_documents_office_read', 'job_documents_office_update')
      AND roles = ARRAY['authenticated']::name[]) <> 2 THEN
    problems := array_append(problems, 'the office rules are missing or not limited to authenticated'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_documents'
                 AND policyname = 'Estimators+ can create docs' AND cmd = 'INSERT') THEN
    problems := array_append(problems, 'the insert rule changed (out of scope)'::text);
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_documents'::regclass) THEN
    problems := array_append(problems, 'row level security is off'::text);
  END IF;
  IF has_function_privilege('anon', 'public.job_documents_office_job(uuid)', 'EXECUTE') THEN
    problems := array_append(problems, 'anon can execute the office helper'::text);
  END IF;
  IF NOT has_function_privilege('anon', 'public.job_document_by_share_token(text)', 'EXECUTE') THEN
    problems := array_append(problems, 'anon cannot execute the token read'::text);
  END IF;
  IF (SELECT count(*) FROM pg_proc
      WHERE oid IN ('public.job_documents_office_job(uuid)'::regprocedure,
                    'public.job_document_by_share_token(text)'::regprocedure)
        AND prosecdef AND proconfig @> ARRAY['search_path=""']) <> 2 THEN
    problems := array_append(problems, 'a function is not SECURITY DEFINER with an empty search_path'::text);
  END IF;
  SELECT array_agg(a ORDER BY a) INTO cols
  FROM unnest((SELECT proargnames FROM pg_proc WHERE oid = 'public.job_document_by_share_token(text)'::regprocedure)) a
  WHERE a <> 'p_token';
  IF cols IS DISTINCT FROM ARRAY['accepted_at', 'client_name', 'declined_at', 'id', 'job_type', 'pdf_url',
                                 'sent_at', 'site_suburb', 'type', 'version', 'viewed_at']::text[] THEN
    problems := array_append(problems, format('the token read returns %s', cols));
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'jd-rules: %', array_to_string(problems, '; ');
  END IF;
END $$;
