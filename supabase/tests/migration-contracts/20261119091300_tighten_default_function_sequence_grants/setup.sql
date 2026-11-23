-- Fixtures for 20261119091300_tighten_default_function_sequence_grants: one
-- routine and one sequence per kind of grant the migration acts on, plus
-- controls it must leave alone. A snapshot of every routine, sequence and
-- default-privilege grant, taken just before the migration, lets the rollback
-- contract prove the rollback restores them exactly.
DO $roles$
BEGIN
  IF to_regrole('anon') IS NULL THEN CREATE ROLE anon NOLOGIN; END IF;
  IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$roles$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- The hosted defaults give each new table, sequence and function in schema
-- public to anon, authenticated and service_role. Earlier cases set them for
-- tables and functions; sequences are set here.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.zgs_notes (id int PRIMARY KEY, note text);
INSERT INTO public.zgs_notes VALUES (1, 'a');

-- An owner-rights routine every API role and PUBLIC can execute.
CREATE FUNCTION public.zgs_definer_open(p_id int) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT note FROM public.zgs_notes WHERE id = p_id $$;

-- Reached only through PUBLIC: no API role holds its own grant.
CREATE FUNCTION public.zgs_definer_public_only() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT count(*)::int FROM public.zgs_notes $$;
REVOKE ALL ON FUNCTION public.zgs_definer_public_only() FROM anon, authenticated, service_role;

-- Granted to anon and authenticated by name, not to PUBLIC.
CREATE FUNCTION public.zgs_definer_named() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.zgs_definer_named() FROM PUBLIC, service_role;

-- An owner-rights procedure.
CREATE PROCEDURE public.zgs_definer_proc(p_id int)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ UPDATE public.zgs_notes SET note = note WHERE id = p_id $$;

-- An owner-rights trigger function on a table signed-in callers write.
CREATE FUNCTION public.zgs_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ BEGIN NEW.stamped := current_user; RETURN NEW; END $$;
CREATE TABLE public.zgs_triggered (id int PRIMARY KEY, stamped text);
CREATE TRIGGER zgs_triggered_stamp BEFORE INSERT ON public.zgs_triggered
  FOR EACH ROW EXECUTE FUNCTION public.zgs_stamp();

-- Control: owner-rights, already closed to anon and PUBLIC.
CREATE FUNCTION public.zgs_definer_closed() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT 2 $$;
REVOKE ALL ON FUNCTION public.zgs_definer_closed() FROM PUBLIC, anon, authenticated;

-- Control: a caller-rights routine anon can execute stays so.
CREATE FUNCTION public.zgs_invoker_open() RETURNS int
LANGUAGE sql STABLE SECURITY INVOKER
AS $$ SELECT 3 $$;

-- A serial column whose sequence signed-in callers reach only through PUBLIC.
CREATE TABLE public.zgs_serial (id serial PRIMARY KEY, note text);
REVOKE ALL ON SEQUENCE public.zgs_serial_id_seq FROM authenticated, service_role;
GRANT USAGE ON SEQUENCE public.zgs_serial_id_seq TO PUBLIC;

-- An identity column; its sequence carries the default grants.
CREATE TABLE public.zgs_identity (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text);

-- A free-standing sequence: PUBLIC reads and moves it; anon holds everything.
CREATE SEQUENCE public.zgs_counter;
REVOKE ALL ON SEQUENCE public.zgs_counter FROM authenticated, service_role;
GRANT SELECT, UPDATE ON SEQUENCE public.zgs_counter TO PUBLIC;

-- Control: a sequence only the server role holds.
CREATE SEQUENCE public.zgs_closed_seq;
REVOKE ALL ON SEQUENCE public.zgs_closed_seq FROM anon, authenticated;

-- Step one closes tables anon reaches with row security off, so these
-- fixture tables are not open to anon; their sequences still are.
REVOKE ALL ON TABLE public.zgs_notes, public.zgs_triggered, public.zgs_serial, public.zgs_identity FROM anon;

-- Control: a table made before keeps its anon grant (row security on, no
-- policy, so step one leaves it too).
CREATE TABLE public.zgs_kept (id int PRIMARY KEY);
ALTER TABLE public.zgs_kept ENABLE ROW LEVEL SECURITY;

-- Every routine, sequence and default-privilege grant just before the
-- migration.
CREATE SCHEMA zgs_before;
CREATE TABLE zgs_before.grants AS
SELECT 'routine' AS kind, p.oid::regprocedure::text AS object, NULL::text AS object_type,
       a.grantee::regrole::text AS grantee, a.privilege_type, a.is_grantable
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
WHERE p.pronamespace = 'public'::regnamespace
UNION ALL
SELECT 'sequence', c.oid::regclass::text, NULL, a.grantee::regrole::text, a.privilege_type, a.is_grantable
FROM pg_class c
CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
UNION ALL
SELECT 'default', format('%s %s', d.defaclrole::regrole, coalesce(d.defaclnamespace::regnamespace::text, '*')),
       d.defaclobjtype::text, a.grantee::regrole::text, a.privilege_type, a.is_grantable
FROM pg_default_acl d
CROSS JOIN LATERAL aclexplode(d.defaclacl) a;
