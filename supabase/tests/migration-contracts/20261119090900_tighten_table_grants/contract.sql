-- Contract for 20261119090900_tighten_table_grants.
\set ON_ERROR_STOP on

-- 1. Nothing in schema public is reachable by anon without a sign-in test.
DO $c1$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(relation, ', ') INTO v_left FROM public.table_grant_open_relations();
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'contract 1: still reachable by anon: %', v_left;
  END IF;
END
$c1$;

-- 2. As anon, every tightened relation refuses, read and write.
DO $c2$
DECLARE
  v_sql text;
  v_refused boolean;
BEGIN
  FOREACH v_sql IN ARRAY ARRAY[
    'SELECT count(*) FROM public.ztg_rls_off',
    'INSERT INTO public.ztg_rls_off VALUES (9, ''x'')',
    'UPDATE public.ztg_rls_off SET note = ''x''',
    'DELETE FROM public.ztg_rls_off',
    'SELECT count(*) FROM public.ztg_open_read',
    'INSERT INTO public.ztg_open_write VALUES (9, NULL, ''x'')',
    'SELECT count(*) FROM public.ztg_public_only',
    'INSERT INTO public.ztg_public_only VALUES (9, ''x'')',
    'SELECT id, shown FROM public.ztg_column_grant',
    'SELECT other FROM public.ztg_column_grant',
    'SELECT count(*) FROM public.ztg_owner_view'
  ] LOOP
    v_refused := false;
    BEGIN
      SET LOCAL ROLE anon;
      EXECUTE v_sql;
      RESET ROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      v_refused := true;
    END;
    RESET ROLE;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'contract 2: anon was not refused: %', v_sql;
    END IF;
  END LOOP;
END
$c2$;

-- 2b. Every privilege is gone from anon and PUBLIC on the tightened
-- relations, not only reads and writes; TRUNCATE ignores row rules.
DO $c2b$
DECLARE
  v_rel text;
BEGIN
  FOREACH v_rel IN ARRAY ARRAY['public.ztg_rls_off', 'public.ztg_open_read', 'public.ztg_open_write',
                               'public.ztg_public_only', 'public.ztg_column_grant', 'public.ztg_owner_view'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class k
               CROSS JOIN LATERAL aclexplode(coalesce(k.relacl, acldefault('r', k.relowner))) a
               WHERE k.oid = v_rel::regclass AND a.grantee IN (0, 'anon'::regrole))
       OR EXISTS (SELECT 1 FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
                  WHERE at.attrelid = v_rel::regclass AND at.attacl IS NOT NULL AND a.grantee IN (0, 'anon'::regrole))
       OR has_table_privilege('anon', v_rel, 'TRUNCATE')
       OR has_table_privilege('anon', v_rel, 'REFERENCES')
       OR has_table_privilege('anon', v_rel, 'TRIGGER') THEN
      RAISE EXCEPTION 'contract 2b: anon or PUBLIC still holds a privilege on %', v_rel;
    END IF;
  END LOOP;
  BEGIN
    SET LOCAL ROLE anon;
    TRUNCATE public.ztg_rls_off;
    RESET ROLE;
    RAISE EXCEPTION 'contract 2b: anon truncated a tightened table';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;
END
$c2b$;

-- 3. Controls keep their anon grants: a policy with a sign-in test, and a
-- security_invoker view. Policies are unchanged.
DO $c3$
BEGIN
  IF NOT has_table_privilege('anon', 'public.ztg_guarded', 'SELECT')
     OR NOT has_table_privilege('anon', 'public.ztg_guarded', 'INSERT')
     OR NOT has_table_privilege('anon', 'public.ztg_guarded', 'TRUNCATE')
     OR NOT has_table_privilege('anon', 'public.ztg_invoker_view', 'SELECT') THEN
    RAISE EXCEPTION 'contract 3: a control lost its anon grant';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid IN (
        'public.ztg_open_read'::regclass, 'public.ztg_open_write'::regclass, 'public.ztg_guarded'::regclass)) <> 4 THEN
    RAISE EXCEPTION 'contract 3: policies changed';
  END IF;
END
$c3$;

-- 4. As a signed-in user, the same reads work as before.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
DO $c4$
BEGIN
  IF (SELECT count(*) FROM public.ztg_rls_off) <> 2 THEN RAISE EXCEPTION 'contract 4: rls_off read'; END IF;
  IF (SELECT count(*) FROM public.ztg_open_read) <> 1 THEN RAISE EXCEPTION 'contract 4: open_read read'; END IF;
  IF (SELECT count(*) FROM public.ztg_open_write) <> 1 THEN RAISE EXCEPTION 'contract 4: open_write read'; END IF;
  IF (SELECT count(*) FROM public.ztg_public_only) <> 1 THEN RAISE EXCEPTION 'contract 4: public_only read'; END IF;
  IF (SELECT other FROM public.ztg_column_grant LIMIT 1) <> 'b' THEN RAISE EXCEPTION 'contract 4: public column read'; END IF;
  IF (SELECT count(*) FROM public.ztg_guarded) <> 1 THEN RAISE EXCEPTION 'contract 4: guarded read'; END IF;
  IF (SELECT count(*) FROM public.ztg_owner_view) <> 2 THEN RAISE EXCEPTION 'contract 4: owner view read'; END IF;
  IF (SELECT count(*) FROM public.ztg_invoker_view) <> 1 THEN RAISE EXCEPTION 'contract 4: invoker view read'; END IF;
  INSERT INTO public.ztg_public_only VALUES (8, 'signed in');
END
$c4$;
ROLLBACK;

-- 5. The server role and owner-rights readers are untouched.
BEGIN;
SET LOCAL ROLE service_role;
DO $c5$
BEGIN
  IF (SELECT count(*) FROM public.ztg_rls_off) <> 2
     OR (SELECT count(*) FROM public.ztg_public_only) <> 1
     OR (SELECT count(*) FROM public.ztg_owner_view) <> 2
     OR (SELECT other FROM public.ztg_column_grant WHERE id = 1) <> 'b'
     OR public.ztg_definer_read(1) IS DISTINCT FROM 'a' THEN
    RAISE EXCEPTION 'contract 5: a server read changed';
  END IF;
  INSERT INTO public.ztg_public_only VALUES (7, 'server');
END
$c5$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE ztg_link_reader;
DO $c5b$
BEGIN
  IF has_table_privilege('ztg_link_reader', 'public.ztg_open_read', 'SELECT') THEN
    RAISE EXCEPTION 'contract 5: the reader''s caller holds a grant on the table';
  END IF;
  IF public.ztg_definer_read(1) IS DISTINCT FROM 'a' THEN
    RAISE EXCEPTION 'contract 5: the owner-rights reader changed';
  END IF;
END
$c5b$;
ROLLBACK;

-- 6. The record names what changed: PUBLIC's grants moved to the signed-in and
-- server roles as their own, and no role or relation outside it was touched.
DO $c6$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.table_grant_changes WHERE relation = 'public.ztg_public_only'
                   AND grantee = 'PUBLIC' AND privilege = 'INSERT' AND change = 'revoked' AND column_name IS NULL)
     OR (SELECT count(*) FROM public.table_grant_changes WHERE relation = 'public.ztg_public_only'
           AND grantee IN ('authenticated', 'service_role') AND change = 'granted') <> 4
     OR NOT EXISTS (SELECT 1 FROM public.table_grant_changes WHERE relation = 'public.ztg_column_grant'
                      AND column_name = 'shown' AND grantee = 'anon' AND change = 'revoked')
     OR NOT EXISTS (SELECT 1 FROM public.table_grant_changes WHERE relation = 'public.ztg_column_grant'
                      AND column_name = 'other' AND grantee = 'authenticated' AND change = 'granted')
     OR EXISTS (SELECT 1 FROM public.table_grant_changes WHERE relation = 'public.ztg_column_grant'
                  AND column_name = 'other' AND grantee = 'service_role')
     OR NOT EXISTS (SELECT 1 FROM public.table_grant_changes WHERE relation = 'public.ztg_rls_off'
                      AND grantee = 'anon' AND privilege = 'TRUNCATE' AND change = 'revoked')
     OR NOT EXISTS (SELECT 1 FROM public.table_grant_changes WHERE relation = 'public.ztg_public_only'
                      AND grantee = 'PUBLIC' AND privilege = 'REFERENCES' AND change = 'revoked')
     OR EXISTS (SELECT 1 FROM public.table_grant_changes WHERE change = 'granted'
                  AND privilege NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
     OR has_table_privilege('authenticated', 'public.ztg_public_only', 'TRUNCATE')
     OR EXISTS (SELECT 1 FROM public.table_grant_changes
                 WHERE relation IN ('public.ztg_guarded', 'public.ztg_invoker_view')) THEN
    RAISE EXCEPTION 'contract 6: the change record is not what the migration did';
  END IF;
  IF has_table_privilege('anon', 'public.table_grant_changes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.table_grant_changes', 'SELECT')
     OR has_function_privilege('anon', 'public.table_grant_open_relations()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.table_grant_open_relations()', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract 6: the record or the rule is reachable through the API';
  END IF;
END
$c6$;

-- 7. A second apply changes nothing and records nothing.
CREATE TEMP TABLE ztg_count AS SELECT count(*) AS n FROM public.table_grant_changes;
\ir ../../../migrations/20261119090900_tighten_table_grants.sql
DO $c7$
BEGIN
  IF (SELECT count(*) FROM public.table_grant_changes) <> (SELECT n FROM ztg_count) THEN
    RAISE EXCEPTION 'contract 7: a second apply recorded a change';
  END IF;
END
$c7$;
DROP TABLE ztg_count;
