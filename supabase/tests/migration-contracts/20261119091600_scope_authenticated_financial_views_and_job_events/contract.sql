-- Contract for 20261119091600_scope_authenticated_financial_views_and_job_events.
--   1. anon cannot read the four views or read or write job_events.
--   2. a signed-in trade cannot read the four views, reads 0 job events, and
--      can still add an event to a job in its company (not another's).
--   3. office staff read their company's job events and no other company's;
--      the views are read through the server role only.
--   4. the server role reads the four views and every job event.
--   5. shape: grants, rules and row security are as promised.
--   6. the change record, and a second apply records nothing.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('f1e00000-0000-4000-8000-000000000001', 'f1e00000-0000-4000-8000-0000000000a1', 'FV office', 'admin'),
  ('f1e00000-0000-4000-8000-000000000002', 'f1e00000-0000-4000-8000-0000000000a1', 'FV trade', 'crew'),
  ('f1e00000-0000-4000-8000-000000000003', 'f1e00000-0000-4000-8000-0000000000a1', 'FV lead', 'lead_installer'),
  ('f1e00000-0000-4000-8000-000000000004', 'f1e00000-0000-4000-8000-0000000000b2', 'FV other office', 'ops_manager');

INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('f1e00000-0000-4000-8000-0000000000f1', 'f1e00000-0000-4000-8000-0000000000a1', 'quoted', 'fencing', 'FV-FIXTURE-1'),
  ('f1e00000-0000-4000-8000-0000000000f2', 'f1e00000-0000-4000-8000-0000000000b2', 'quoted', 'fencing', 'FV-FIXTURE-2');

INSERT INTO public.job_events (id, job_id, event_type, detail_json) VALUES
  ('f1e00000-0000-4000-8000-0000000000e1', 'f1e00000-0000-4000-8000-0000000000f1', 'fv_fixture', '{}'),
  ('f1e00000-0000-4000-8000-0000000000e2', 'f1e00000-0000-4000-8000-0000000000f1', 'fv_fixture', '{}'),
  ('f1e00000-0000-4000-8000-0000000000e3', 'f1e00000-0000-4000-8000-0000000000f2', 'fv_fixture', '{}');

-- Fixture events of one job the current session can see; a refusal counts as 0.
CREATE FUNCTION pg_temp.fv_events(p_job uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  SELECT count(*)::int INTO n FROM public.job_events
  WHERE job_id = p_job AND event_type = 'fv_fixture';
  RETURN n;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN 0;
END $$;
-- Whether the current session may read a view at all.
CREATE FUNCTION pg_temp.fv_reads(p_view text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SELECT count(*) FROM %s', p_view);
  RETURN true;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN false;
END $$;
-- Whether the current session may add an event to a job (no RETURNING, as the
-- browser client sends it).
CREATE FUNCTION pg_temp.fv_inserts(p_job uuid) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.job_events (job_id, event_type, detail_json) VALUES (p_job, 'fv_insert', '{}');
  RETURN true;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN false;
END $$;
CREATE FUNCTION pg_temp.fv_as(p_user uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
  SELECT NULL::void;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.fv_events(uuid), pg_temp.fv_reads(text), pg_temp.fv_inserts(uuid), pg_temp.fv_as(uuid)
  TO anon, authenticated, service_role;

-- 1. anon.
SET LOCAL ROLE anon;
SELECT pg_temp.fv_as(NULL);
DO $c1$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['public.job_financials', 'public.aged_receivables',
                           'public.monthly_revenue', 'public.monthly_costs', 'public.job_events'] LOOP
    IF pg_temp.fv_reads(v) THEN
      RAISE EXCEPTION 'fv-scope 1: anon read %', v;
    END IF;
  END LOOP;
  IF pg_temp.fv_inserts('f1e00000-0000-4000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'fv-scope 1: anon added a job event';
  END IF;
END
$c1$;
RESET ROLE;

-- 2. A signed-in trade (crew, then a lead installer) in company A.
SET LOCAL ROLE authenticated;
DO $c2$
DECLARE
  v text;
  u uuid;
  n int;
BEGIN
  FOREACH u IN ARRAY ARRAY['f1e00000-0000-4000-8000-000000000002', 'f1e00000-0000-4000-8000-000000000003']::uuid[] LOOP
    PERFORM pg_temp.fv_as(u);
    FOREACH v IN ARRAY ARRAY['public.job_financials', 'public.aged_receivables',
                             'public.monthly_revenue', 'public.monthly_costs'] LOOP
      IF pg_temp.fv_reads(v) THEN
        RAISE EXCEPTION 'fv-scope 2: a trade read %', v;
      END IF;
    END LOOP;
    n := pg_temp.fv_events('f1e00000-0000-4000-8000-0000000000f1') + pg_temp.fv_events('f1e00000-0000-4000-8000-0000000000f2');
    IF n <> 0 THEN
      RAISE EXCEPTION 'fv-scope 2: a trade read % job event rows', n;
    END IF;
    IF NOT pg_temp.fv_inserts('f1e00000-0000-4000-8000-0000000000f1') THEN
      RAISE EXCEPTION 'fv-scope 2: a trade could not add an event to a job in its company';
    END IF;
    IF pg_temp.fv_inserts('f1e00000-0000-4000-8000-0000000000f2') THEN
      RAISE EXCEPTION 'fv-scope 2: a trade added an event to another company''s job';
    END IF;
  END LOOP;
END
$c2$;

-- 3. Office staff: company A reads A's events only; company B reads B's only.
DO $c3$
DECLARE v text;
BEGIN
  PERFORM pg_temp.fv_as('f1e00000-0000-4000-8000-000000000001');
  IF pg_temp.fv_events('f1e00000-0000-4000-8000-0000000000f1') <> 2
     OR pg_temp.fv_events('f1e00000-0000-4000-8000-0000000000f2') <> 0 THEN
    RAISE EXCEPTION 'fv-scope 3: office staff of company A did not read exactly its own job events';
  END IF;
  IF NOT pg_temp.fv_inserts('f1e00000-0000-4000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'fv-scope 3: office staff could not add an event';
  END IF;
  FOREACH v IN ARRAY ARRAY['public.job_financials', 'public.aged_receivables',
                           'public.monthly_revenue', 'public.monthly_costs'] LOOP
    IF pg_temp.fv_reads(v) THEN
      RAISE EXCEPTION 'fv-scope 3: a signed-in caller read % directly', v;
    END IF;
  END LOOP;
  PERFORM pg_temp.fv_as('f1e00000-0000-4000-8000-000000000004');
  IF pg_temp.fv_events('f1e00000-0000-4000-8000-0000000000f1') <> 0
     OR pg_temp.fv_events('f1e00000-0000-4000-8000-0000000000f2') <> 1 THEN
    RAISE EXCEPTION 'fv-scope 3: office staff of company B read another company''s job events';
  END IF;
END
$c3$;
RESET ROLE;

-- 4. The server role.
SET LOCAL ROLE service_role;
DO $c4$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['public.job_financials', 'public.aged_receivables',
                           'public.monthly_revenue', 'public.monthly_costs'] LOOP
    IF NOT pg_temp.fv_reads(v) THEN
      RAISE EXCEPTION 'fv-scope 4: the server role could not read %', v;
    END IF;
  END LOOP;
  IF pg_temp.fv_events('f1e00000-0000-4000-8000-0000000000f1') <> 2
     OR pg_temp.fv_events('f1e00000-0000-4000-8000-0000000000f2') <> 1 THEN
    RAISE EXCEPTION 'fv-scope 4: the server role did not read every job event';
  END IF;
  IF NOT pg_temp.fv_inserts('f1e00000-0000-4000-8000-0000000000f2') THEN
    RAISE EXCEPTION 'fv-scope 4: the server role could not add an event';
  END IF;
END
$c4$;
RESET ROLE;

ROLLBACK;

-- 5. Shape.
DO $c5$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['public.job_financials', 'public.aged_receivables',
                           'public.monthly_revenue', 'public.monthly_costs'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class k
               CROSS JOIN LATERAL aclexplode(coalesce(k.relacl, acldefault('r', k.relowner))) a
               WHERE k.oid = v::regclass AND a.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole))
       OR EXISTS (SELECT 1 FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
                  WHERE at.attrelid = v::regclass AND at.attacl IS NOT NULL
                    AND a.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)) THEN
      RAISE EXCEPTION 'fv-scope 5: anon, PUBLIC or authenticated still holds a privilege on %', v;
    END IF;
    IF NOT has_table_privilege('service_role', v, 'SELECT') THEN
      RAISE EXCEPTION 'fv-scope 5: service_role lost SELECT on %', v;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_events'::regclass) THEN
    RAISE EXCEPTION 'fv-scope 5: row level security is off on job_events';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy p
             WHERE p.polrelid = 'public.job_events'::regclass AND p.polpermissive AND p.polcmd IN ('r', '*')
               AND (0::oid = ANY (p.polroles) OR 'anon'::regrole = ANY (p.polroles)
                    OR 'authenticated'::regrole = ANY (p.polroles))
               AND NOT (p.polname = 'job_events_office_read' AND p.polcmd = 'r'
                        AND p.polroles = ARRAY['authenticated'::regrole::oid])) THEN
    RAISE EXCEPTION 'fv-scope 5: another read rule on job_events reaches signed-in or anonymous callers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy p
                 WHERE p.polrelid = 'public.job_events'::regclass AND p.polname = 'Users can create events'
                   AND p.polcmd = 'a' AND p.polroles = ARRAY[0::oid]) THEN
    RAISE EXCEPTION 'fv-scope 5: the insert rule changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class k
             CROSS JOIN LATERAL aclexplode(coalesce(k.relacl, acldefault('r', k.relowner))) a
             WHERE k.oid = 'public.job_events'::regclass AND a.grantee IN (0, 'anon'::regrole)) THEN
    RAISE EXCEPTION 'fv-scope 5: anon or PUBLIC still holds a privilege on job_events';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.job_events', 'SELECT, INSERT')
     OR NOT has_table_privilege('service_role', 'public.job_events', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'fv-scope 5: a signed-in or server privilege on job_events was lost';
  END IF;
END
$c5$;

-- 6. The record names what changed, the record is not reachable through the
-- API, and a second apply records nothing.
DO $c6$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.financial_read_access_changes
                 WHERE relation = 'public.job_events' AND kind = 'policy' AND change = 'dropped'
                   AND policy_name = 'Users can view job events' AND policy_roles = ARRAY['public']
                   AND policy_using LIKE '%public.jobs%public.auth_org_id()%')
     OR NOT EXISTS (SELECT 1 FROM public.financial_read_access_changes
                    WHERE relation = 'public.job_events' AND kind = 'policy' AND change = 'created'
                      AND policy_name = 'job_events_office_read')
     OR NOT EXISTS (SELECT 1 FROM public.financial_read_access_changes
                    WHERE relation = 'public.monthly_costs' AND column_name = 'org_id'
                      AND grantee = 'PUBLIC' AND change = 'revoked')
     OR NOT EXISTS (SELECT 1 FROM public.financial_read_access_changes
                    WHERE relation = 'public.aged_receivables' AND grantee = 'authenticated'
                      AND privilege = 'SELECT' AND change = 'revoked')
     OR NOT EXISTS (SELECT 1 FROM public.financial_read_access_changes
                    WHERE relation = 'public.job_events' AND grantee = 'anon'
                      AND privilege = 'TRUNCATE' AND change = 'revoked')
     OR EXISTS (SELECT 1 FROM public.financial_read_access_changes
                WHERE relation = 'public.job_events' AND grantee = 'authenticated')
     OR EXISTS (SELECT 1 FROM public.financial_read_access_changes WHERE kind = 'row_security') THEN
    RAISE EXCEPTION 'fv-scope 6: the change record is not what the migration did';
  END IF;
  IF has_table_privilege('anon', 'public.financial_read_access_changes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.financial_read_access_changes', 'SELECT')
     OR has_table_privilege('service_role', 'public.financial_read_access_changes', 'SELECT') THEN
    RAISE EXCEPTION 'fv-scope 6: the change record is reachable through the API';
  END IF;
END
$c6$;

CREATE TEMP TABLE fv_count AS SELECT count(*) AS n FROM public.financial_read_access_changes;
\ir ../../../migrations/20261119091600_scope_authenticated_financial_views_and_job_events.sql
DO $c7$
BEGIN
  IF (SELECT count(*) FROM public.financial_read_access_changes) <> (SELECT n FROM fv_count) THEN
    RAISE EXCEPTION 'fv-scope 6: a second apply recorded a change';
  END IF;
END
$c7$;
DROP TABLE fv_count;
