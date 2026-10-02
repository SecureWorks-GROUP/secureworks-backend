-- Pre-migration state for 20261002150000_exec_sql_revoke_public.
-- A stand-in for the live-only public.exec_sql(text): SECURITY DEFINER, owned
-- by the migrating superuser, with the body and grants the 2 Oct read-only
-- production check found (EXECUTE held by PUBLIC, anon, authenticated).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.exec_sql(query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
BEGIN
  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || query || ') t' INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO PUBLIC, anon, authenticated, service_role;

-- A table only the owner can read, to prove the definer path still reaches
-- it for service_role.
CREATE TABLE IF NOT EXISTS public.exec_sql_contract_secret (id int PRIMARY KEY, v text);
REVOKE ALL ON TABLE public.exec_sql_contract_secret FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO public.exec_sql_contract_secret VALUES (1, 'owner-only') ON CONFLICT DO NOTHING;
