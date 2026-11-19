-- Fixtures for 20261119090900_tighten_table_grants: one relation per kind of
-- grant the migration acts on, plus controls it must leave alone. A snapshot
-- of every grant in schema public, taken just before the migration, lets the
-- rollback contract prove the rollback restores them exactly.
DO $roles$
BEGIN
  IF to_regrole('anon') IS NULL THEN CREATE ROLE anon NOLOGIN; END IF;
  IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS auth;
DO $uid$
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
  END IF;
END
$uid$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Row security off; every API role holds every privilege.
CREATE TABLE public.ztg_rls_off (id int PRIMARY KEY, note text);
GRANT ALL ON public.ztg_rls_off TO anon, authenticated, service_role;
INSERT INTO public.ztg_rls_off VALUES (1, 'a'), (2, 'b');

-- A read policy for public with no sign-in test.
CREATE TABLE public.ztg_open_read (id int PRIMARY KEY, owner_id uuid, note text);
ALTER TABLE public.ztg_open_read ENABLE ROW LEVEL SECURITY;
CREATE POLICY ztg_open_read_all ON public.ztg_open_read FOR SELECT TO public USING (true);
GRANT ALL ON public.ztg_open_read TO anon, authenticated, service_role;
INSERT INTO public.ztg_open_read VALUES (1, '00000000-0000-4000-8000-000000000001', 'a');

-- Reading needs a sign-in; writing has a policy for anon with no test.
CREATE TABLE public.ztg_open_write (id int PRIMARY KEY, owner_id uuid, note text);
ALTER TABLE public.ztg_open_write ENABLE ROW LEVEL SECURITY;
CREATE POLICY ztg_open_write_own ON public.ztg_open_write FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY ztg_open_write_insert ON public.ztg_open_write FOR INSERT TO anon WITH CHECK (note IS NOT NULL);
GRANT ALL ON public.ztg_open_write TO anon, authenticated, service_role;
INSERT INTO public.ztg_open_write VALUES (1, '00000000-0000-4000-8000-000000000001', 'a');

-- Reached only through PUBLIC: no role holds its own grant.
CREATE TABLE public.ztg_public_only (id int PRIMARY KEY, note text);
REVOKE ALL ON public.ztg_public_only FROM anon, authenticated, service_role;
GRANT SELECT, INSERT, TRUNCATE, REFERENCES ON public.ztg_public_only TO PUBLIC;
INSERT INTO public.ztg_public_only VALUES (1, 'a');

-- Column grants only: anon one column, PUBLIC another.
CREATE TABLE public.ztg_column_grant (id int PRIMARY KEY, shown text, other text);
REVOKE ALL ON public.ztg_column_grant FROM anon, authenticated, service_role;
GRANT SELECT (id, shown) ON public.ztg_column_grant TO anon;
GRANT SELECT (other) ON public.ztg_column_grant TO PUBLIC;
GRANT SELECT, INSERT ON public.ztg_column_grant TO service_role;
INSERT INTO public.ztg_column_grant VALUES (1, 'a', 'b');

-- Control: a read policy with a sign-in test. Its anon grant stays.
CREATE TABLE public.ztg_guarded (id int PRIMARY KEY, owner_id uuid, note text);
ALTER TABLE public.ztg_guarded ENABLE ROW LEVEL SECURITY;
CREATE POLICY ztg_guarded_own ON public.ztg_guarded FOR SELECT TO public USING (owner_id = auth.uid());
GRANT ALL ON public.ztg_guarded TO anon, authenticated, service_role;
INSERT INTO public.ztg_guarded VALUES
  (1, '00000000-0000-4000-8000-000000000001', 'mine'),
  (2, '00000000-0000-4000-8000-000000000002', 'theirs');

-- A view that runs with its owner's rights over the guarded table.
CREATE VIEW public.ztg_owner_view AS SELECT id, note FROM public.ztg_guarded;
GRANT SELECT ON public.ztg_owner_view TO anon, authenticated, service_role;

-- Control: a security_invoker view follows its table. Its anon grant stays.
CREATE VIEW public.ztg_invoker_view WITH (security_invoker = true) AS SELECT id, note FROM public.ztg_guarded;
GRANT SELECT ON public.ztg_invoker_view TO anon, authenticated, service_role;

-- An owner-rights reader (the shape of a share link) over a tightened table.
CREATE FUNCTION public.ztg_definer_read(p_id int) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT note FROM public.ztg_open_read WHERE id = p_id $$;
REVOKE ALL ON FUNCTION public.ztg_definer_read(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ztg_definer_read(int) TO anon, authenticated, service_role;

-- Every table and column grant in schema public just before the migration.
CREATE SCHEMA ztg_before;
CREATE TABLE ztg_before.grants AS
SELECT c.relname::text AS relation, NULL::text AS column_name,
       a.grantee::regrole::text AS grantee, a.privilege_type, a.is_grantable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
UNION ALL
SELECT c.relname::text, at.attname::text,
       a.grantee::regrole::text, a.privilege_type, a.is_grantable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute at ON at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
CROSS JOIN LATERAL aclexplode(at.attacl) a
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f');
