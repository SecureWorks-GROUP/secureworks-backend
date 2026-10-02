-- Contract for 20261002150000_business_events_close_anon_read.
-- 1. The public key (anon) cannot read business_events.
-- 2. Signed-in office staff can; trades, estimator, roleless and unknown
--    sessions read nothing.
-- 3. service_role is unaffected.
-- 4. anon INSERT behaves as before for the patio tool's return=minimal post.
-- 5. Neither the public key nor a signed-in session can empty the table:
--    anon cannot TRUNCATE, UPDATE or DELETE; authenticated cannot TRUNCATE.

-- 1. Shape --------------------------------------------------------------------
-- Every failed check is collected and raised together, so the break contract
-- can prove more than one of them at once.
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF has_table_privilege('anon', 'public.business_events', 'SELECT')
     OR has_any_column_privilege('anon', 'public.business_events', 'SELECT') THEN
    problems := array_append(problems, 'anon still holds SELECT'::text);
  END IF;
  IF has_table_privilege('anon', 'public.business_events', 'TRUNCATE') THEN
    problems := array_append(problems, 'anon still holds TRUNCATE'::text);
  END IF;
  IF has_table_privilege('anon', 'public.business_events', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.business_events', 'UPDATE') THEN
    problems := array_append(problems, 'anon still holds UPDATE'::text);
  END IF;
  IF has_table_privilege('anon', 'public.business_events', 'DELETE') THEN
    problems := array_append(problems, 'anon still holds DELETE'::text);
  END IF;
  IF has_table_privilege('anon', 'public.business_events', 'REFERENCES')
     OR has_any_column_privilege('anon', 'public.business_events', 'REFERENCES') THEN
    problems := array_append(problems, 'anon still holds REFERENCES'::text);
  END IF;
  IF has_table_privilege('anon', 'public.business_events', 'TRIGGER') THEN
    problems := array_append(problems, 'anon still holds TRIGGER'::text);
  END IF;
  IF NOT has_table_privilege('anon', 'public.business_events', 'INSERT') THEN
    problems := array_append(problems, 'anon lost INSERT (out of scope for this change)'::text);
  END IF;
  IF has_table_privilege('authenticated', 'public.business_events', 'TRUNCATE') THEN
    problems := array_append(problems, 'authenticated still holds TRUNCATE'::text);
  END IF;
  IF has_table_privilege('authenticated', 'public.business_events', 'REFERENCES')
     OR has_table_privilege('authenticated', 'public.business_events', 'TRIGGER') THEN
    problems := array_append(problems, 'authenticated still holds REFERENCES or TRIGGER'::text);
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.business_events', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.business_events', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.business_events', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.business_events', 'DELETE') THEN
    problems := array_append(problems, 'authenticated lost SELECT, INSERT, UPDATE or DELETE (out of scope)'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_events'
             AND policyname = 'select_all') THEN
    problems := array_append(problems, 'select_all still present'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_events'
             AND cmd IN ('SELECT', 'ALL') AND roles && ARRAY['public', 'anon']::name[]) THEN
    problems := array_append(problems, 'a read policy still applies to anon or PUBLIC'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_events'
                 AND policyname = 'business_events_staff_read' AND cmd = 'SELECT'
                 AND roles = ARRAY['authenticated']::name[]) THEN
    problems := array_append(problems, 'business_events_staff_read missing or not limited to authenticated'::text);
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_events'
      AND policyname IN ('insert_only', 'Allow scope decision inserts from tools') AND cmd = 'INSERT') <> 2 THEN
    problems := array_append(problems, 'the insert policies changed'::text);
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.business_events'::regclass) THEN
    problems := array_append(problems, 'row level security is off'::text);
  END IF;
  IF has_function_privilege('anon', 'public.business_events_staff_reader()', 'EXECUTE') THEN
    problems := array_append(problems, 'anon can execute the staff helper'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.business_events_staff_reader()'::regprocedure
                 AND prosecdef AND proconfig @> ARRAY['search_path=""']) THEN
    problems := array_append(problems, 'staff helper is not SECURITY DEFINER with an empty search_path'::text);
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'be-close: %', array_to_string(problems, '; ');
  END IF;
END $$;

-- 2. Behaviour ------------------------------------------------------------------
BEGIN;
INSERT INTO public.business_events (id, event_type, source, entity_type, entity_id, payload, body_preview)
VALUES
  ('be0e0000-0000-4000-8000-000000000001', 'sms.received', 'ghl', 'contact', 'c1', '{"body":"fixture text"}', 'fixture text'),
  ('be0e0000-0000-4000-8000-000000000002', 'note.added', 'ops', 'job', 'j1', '{}', NULL);

CREATE FUNCTION pg_temp.be_visible() RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.business_events
  WHERE id IN ('be0e0000-0000-4000-8000-000000000001', 'be0e0000-0000-4000-8000-000000000002')
$$;
GRANT EXECUTE ON FUNCTION pg_temp.be_visible() TO anon, authenticated, service_role;

-- 2a. anon cannot read: permission denied, not an empty answer.
SAVEPOINT anon_read;
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM 1 FROM public.business_events LIMIT 1;
  RAISE EXCEPTION 'be-close: anon read business_events';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
ROLLBACK TO SAVEPOINT anon_read;

-- 2b. anon INSERT as the patio tool sends it (PostgREST return=minimal is
-- INSERT ... RETURNING 1): still accepted.
SAVEPOINT anon_insert;
SET LOCAL ROLE anon;
INSERT INTO public.business_events (event_type, source, entity_type, entity_id, payload)
VALUES ('scope.decision', 'patio-tool', 'scope', 'no-job', '{"decision_type":"fixture"}');
DO $$
DECLARE n int;
BEGIN
  WITH ins AS (
    INSERT INTO public.business_events (event_type, source, entity_type, entity_id, payload)
    VALUES ('scope.decision', 'patio-tool', 'scope', 'no-job', '{"decision_type":"fixture-returning-1"}')
    RETURNING 1
  ) SELECT count(*) INTO n FROM ins;
  IF n <> 1 THEN RAISE EXCEPTION 'be-close: anon RETURNING 1 insert did not land'; END IF;
END $$;
-- Asking for the row back (return=representation) now needs a read, so it is refused.
DO $$
DECLARE returned uuid;
BEGIN
  INSERT INTO public.business_events (event_type, source, entity_type, entity_id, payload)
  VALUES ('scope.decision', 'patio-tool', 'scope', 'no-job', '{}') RETURNING id INTO returned;
  RAISE EXCEPTION 'be-close: anon read a row back through INSERT ... RETURNING id';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.business_events
      WHERE event_type = 'scope.decision' AND source = 'patio-tool'
        AND payload->>'decision_type' IN ('fixture', 'fixture-returning-1')) <> 2 THEN
    RAISE EXCEPTION 'be-close: anon scope.decision inserts were not stored';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT anon_insert;

-- 2b2. anon cannot empty or change the table, even by a route row rules
-- would not stop (TRUNCATE ignores row level security).
SAVEPOINT anon_wipe;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    TRUNCATE public.business_events;
    RAISE EXCEPTION 'be-close: anon truncated business_events';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.business_events;
    RAISE EXCEPTION 'be-close: anon ran DELETE on business_events';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.business_events SET body_preview = 'x';
    RAISE EXCEPTION 'be-close: anon ran UPDATE on business_events';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT anon_wipe;

-- 2b3. A signed-in staff session cannot truncate either.
SAVEPOINT staff_wipe;
SELECT set_config('request.jwt.claim.sub', 'be000000-0000-4000-8000-000000000001', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  TRUNCATE public.business_events;
  RAISE EXCEPTION 'be-close: signed-in admin truncated business_events';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;
ROLLBACK TO SAVEPOINT staff_wipe;
DO $$
BEGIN
  IF pg_temp.be_visible() <> 2 THEN RAISE EXCEPTION 'be-close: fixture rows went missing'; END IF;
END $$;

-- 2c. Signed-in sessions: staff see both rows; everyone else sees none.
DO $$
DECLARE
  r record;
  n int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('be000000-0000-4000-8000-000000000001', 'admin', 2),
    ('be000000-0000-4000-8000-000000000002', 'owner', 2),
    ('be000000-0000-4000-8000-000000000003', 'ops_manager', 2),
    ('be000000-0000-4000-8000-000000000004', 'sales', 2),
    ('be000000-0000-4000-8000-000000000005', 'sales_manager', 2),
    ('be000000-0000-4000-8000-000000000006', 'estimator', 0),
    ('be000000-0000-4000-8000-000000000007', 'lead_installer', 0),
    ('be000000-0000-4000-8000-000000000008', 'crew', 0),
    ('be000000-0000-4000-8000-000000000009', 'no role', 0),
    ('be000000-0000-4000-8000-0000000000ff', 'no users row', 0),
    ('', 'no sub claim', 0)
  ) AS t(sub, label, expected) LOOP
    PERFORM set_config('request.jwt.claim.sub', r.sub, true);
    SET LOCAL ROLE authenticated;
    n := pg_temp.be_visible();
    RESET ROLE;
    IF n <> r.expected THEN
      RAISE EXCEPTION 'be-close: authenticated % saw % rows, expected %', r.label, n, r.expected;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

-- 2d. service_role reads and writes as before.
SAVEPOINT service;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF pg_temp.be_visible() <> 2 THEN RAISE EXCEPTION 'be-close: service_role lost the read'; END IF;
  INSERT INTO public.business_events (event_type, source, entity_type, entity_id, payload)
  VALUES ('note.added', 'ops', 'job', 'j2', '{}');
END $$;
ROLLBACK TO SAVEPOINT service;

ROLLBACK;
