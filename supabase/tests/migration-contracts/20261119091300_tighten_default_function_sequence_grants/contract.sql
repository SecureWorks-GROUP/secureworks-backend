-- Contract for 20261119091300_tighten_default_function_sequence_grants.
\set ON_ERROR_STOP on

-- 1. anon and PUBLIC hold nothing on an owner-rights routine or a sequence in
-- schema public, nor in postgres's defaults for new objects there.
DO $c1$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(DISTINCT coalesce(object_type || ' in ', '') || object, ', ') INTO v_left
  FROM public.object_grant_open();
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'contract 1: still granted to anon or PUBLIC: %', v_left;
  END IF;
END
$c1$;

-- 2. As anon, every changed routine and sequence refuses.
DO $c2$
DECLARE
  v_sql text;
  v_refused boolean;
BEGIN
  FOREACH v_sql IN ARRAY ARRAY[
    'SELECT public.zgs_definer_open(1)',
    'SELECT public.zgs_definer_public_only()',
    'SELECT public.zgs_definer_named()',
    'CALL public.zgs_definer_proc(1)',
    'SELECT nextval(''public.zgs_serial_id_seq'')',
    'SELECT setval(''public.zgs_serial_id_seq'', 100)',
    'SELECT nextval(''public.zgs_identity_id_seq'')',
    'SELECT setval(''public.zgs_identity_id_seq'', 100)',
    'SELECT last_value FROM public.zgs_counter',
    'SELECT setval(''public.zgs_counter'', 100)'
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
  IF has_function_privilege('anon', 'public.zgs_stamp()', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract 2: anon can still execute the trigger function';
  END IF;
END
$c2$;

-- 3. Controls are untouched: a caller-rights routine anon can execute, an
-- owner-rights routine already closed, a sequence only the server role holds.
DO $c3$
BEGIN
  IF NOT has_function_privilege('anon', 'public.zgs_invoker_open()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.zgs_definer_closed()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.zgs_definer_closed()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.zgs_definer_closed()', 'EXECUTE')
     OR has_sequence_privilege('authenticated', 'public.zgs_closed_seq', 'USAGE')
     OR NOT has_sequence_privilege('service_role', 'public.zgs_closed_seq', 'USAGE') THEN
    RAISE EXCEPTION 'contract 3: a control changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.object_grant_changes
             WHERE object IN ('public.zgs_invoker_open()', 'public.zgs_definer_closed()', 'public.zgs_closed_seq')) THEN
    RAISE EXCEPTION 'contract 3: a control is in the change record';
  END IF;
END
$c3$;
BEGIN;
SET LOCAL ROLE anon;
DO $c3b$
BEGIN
  IF public.zgs_invoker_open() <> 3 THEN RAISE EXCEPTION 'contract 3: the caller-rights routine changed'; END IF;
END
$c3b$;
ROLLBACK;

-- 4. As a signed-in user, the same calls and inserts work as before, and the
-- owner-rights trigger still fires.
BEGIN;
SET LOCAL ROLE authenticated;
DO $c4$
BEGIN
  IF public.zgs_definer_open(1) IS DISTINCT FROM 'a' THEN RAISE EXCEPTION 'contract 4: open routine'; END IF;
  IF public.zgs_definer_public_only() <> 1 THEN RAISE EXCEPTION 'contract 4: public-only routine'; END IF;
  IF public.zgs_definer_named() <> 1 THEN RAISE EXCEPTION 'contract 4: named routine'; END IF;
  CALL public.zgs_definer_proc(1);
  INSERT INTO public.zgs_serial (note) VALUES ('signed in');
  INSERT INTO public.zgs_identity (note) VALUES ('signed in');
  INSERT INTO public.zgs_triggered (id) VALUES (1);
  IF (SELECT stamped FROM public.zgs_triggered WHERE id = 1) IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'contract 4: the owner-rights trigger did not fire';
  END IF;
  PERFORM setval('public.zgs_counter', 5);
  IF (SELECT last_value FROM public.zgs_counter) <> 5 THEN RAISE EXCEPTION 'contract 4: counter'; END IF;
END
$c4$;
ROLLBACK;

-- 5. The server role likewise.
BEGIN;
SET LOCAL ROLE service_role;
DO $c5$
BEGIN
  IF public.zgs_definer_open(1) IS DISTINCT FROM 'a'
     OR public.zgs_definer_public_only() <> 1
     OR public.zgs_definer_closed() <> 2 THEN
    RAISE EXCEPTION 'contract 5: a server call changed';
  END IF;
  CALL public.zgs_definer_proc(1);
  INSERT INTO public.zgs_serial (note) VALUES ('server');
  INSERT INTO public.zgs_identity (note) VALUES ('server');
  PERFORM setval('public.zgs_counter', 6);
  PERFORM nextval('public.zgs_closed_seq');
END
$c5$;
ROLLBACK;

-- 6. The record names what changed: what PUBLIC gave moved to the signed-in
-- and server roles as their own, a grant made by name was not handed on, and
-- the defaults lost anon and PUBLIC.
DO $c6$
BEGIN
  IF (SELECT count(*) FROM public.object_grant_changes
       WHERE object = 'public.zgs_definer_public_only()' AND change = 'granted'
         AND grantee IN ('authenticated', 'service_role') AND privilege = 'EXECUTE') <> 2
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object = 'public.zgs_definer_public_only()' AND change = 'revoked' AND grantee = 'PUBLIC')
     OR EXISTS (SELECT 1 FROM public.object_grant_changes
                WHERE object = 'public.zgs_definer_named()' AND change = 'granted')
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object = 'public.zgs_definer_named()' AND change = 'revoked' AND grantee = 'anon')
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object = 'public.zgs_stamp()' AND change = 'revoked' AND grantee = 'anon')
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object = 'public.zgs_definer_proc(integer)' AND change = 'revoked' AND grantee = 'PUBLIC')
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object = 'public.zgs_serial_id_seq' AND change = 'granted'
                      AND grantee = 'authenticated' AND privilege = 'USAGE')
     OR (SELECT count(*) FROM public.object_grant_changes
          WHERE object = 'public.zgs_counter' AND change = 'granted') <> 4
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object = 'public.zgs_identity_id_seq' AND change = 'revoked' AND grantee = 'anon'
                      AND privilege = 'UPDATE')
     OR EXISTS (SELECT 1 FROM public.object_grant_changes
                WHERE object = 'public.zgs_identity_id_seq' AND change = 'granted')
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object_kind = 'default' AND object = 'public' AND object_type = 'TABLES'
                      AND grantee = 'anon' AND privilege = 'SELECT' AND change = 'revoked')
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object_kind = 'default' AND object = 'public' AND object_type = 'SEQUENCES'
                      AND grantee = 'anon' AND privilege = 'USAGE' AND change = 'revoked')
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object_kind = 'default' AND object = 'public' AND object_type = 'FUNCTIONS'
                      AND grantee = 'anon' AND privilege = 'EXECUTE' AND change = 'revoked')
     OR NOT EXISTS (SELECT 1 FROM public.object_grant_changes
                    WHERE object_kind = 'default' AND object = '*' AND object_type = 'FUNCTIONS'
                      AND grantee = 'PUBLIC' AND privilege = 'EXECUTE' AND change = 'revoked')
     OR EXISTS (SELECT 1 FROM public.object_grant_changes
                WHERE object_kind = 'default' AND grantee IN ('authenticated', 'service_role')
                  AND object_type <> 'FUNCTIONS') THEN
    RAISE EXCEPTION 'contract 6: the change record is not what the migration did';
  END IF;
  IF has_table_privilege('anon', 'public.object_grant_changes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.object_grant_changes', 'SELECT')
     OR has_function_privilege('anon', 'public.object_grant_open()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.object_grant_open()', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract 6: the record or the rule is reachable through the API';
  END IF;
END
$c6$;

-- 7. Objects postgres creates from now on in schema public give anon nothing
-- and PUBLIC no EXECUTE; authenticated and service_role keep their defaults.
-- An object made before keeps what it had.
BEGIN;
CREATE TABLE public.zgs_new_table (id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, note text);
CREATE SEQUENCE public.zgs_new_seq;
CREATE FUNCTION public.zgs_new_definer() RETURNS int
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT 4 $$;
CREATE FUNCTION public.zgs_new_invoker() RETURNS int LANGUAGE sql AS $$ SELECT 5 $$;
DO $c7$
DECLARE
  v_rel text;
  v_fn text;
BEGIN
  FOREACH v_rel IN ARRAY ARRAY['public.zgs_new_table', 'public.zgs_new_seq', 'public.zgs_new_table_id_seq'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class c
               CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault(CASE c.relkind WHEN 'S' THEN 'S' ELSE 'r' END::"char", c.relowner))) a
               WHERE c.oid = v_rel::regclass AND a.grantee IN (0, 'anon'::regrole)) THEN
      RAISE EXCEPTION 'contract 7: a new relation is granted to anon or PUBLIC: %', v_rel;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.zgs_new_definer()', 'public.zgs_new_invoker()'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p
               CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE p.oid = v_fn::regprocedure AND a.grantee IN (0, 'anon'::regrole))
       OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract 7: a new routine is executable by anon or PUBLIC: %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract 7: a new routine is not executable by the signed-in or server role: %', v_fn;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.zgs_new_table', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.zgs_new_table', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.zgs_new_table', 'SELECT')
     OR NOT has_sequence_privilege('authenticated', 'public.zgs_new_seq', 'USAGE')
     OR NOT has_table_privilege('anon', 'public.zgs_kept', 'SELECT') THEN
    RAISE EXCEPTION 'contract 7: the default privileges of the signed-in or server role changed';
  END IF;
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM public.zgs_new_definer();
    RAISE EXCEPTION 'contract 7: anon executed a new owner-rights routine';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END
$c7$;
ROLLBACK;

-- 8. A second apply changes nothing and records nothing.
CREATE TEMP TABLE zgs_count AS SELECT count(*) AS n FROM public.object_grant_changes;
\ir ../../../migrations/20261119091300_tighten_default_function_sequence_grants.sql
DO $c8$
BEGIN
  IF (SELECT count(*) FROM public.object_grant_changes) <> (SELECT n FROM zgs_count) THEN
    RAISE EXCEPTION 'contract 8: a second apply recorded a change';
  END IF;
END
$c8$;
DROP TABLE zgs_count;
