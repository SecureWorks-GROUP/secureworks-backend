-- Disposable prerequisites and one synthetic operator for the claim foreign key.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.organisations (id uuid PRIMARY KEY, name text);
CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY, org_id uuid, name text, role text);
INSERT INTO public.organisations (id, name)
VALUES ('00000000-0000-4000-8000-000000000409', 'ZZTEST organisation') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, org_id, name, role)
VALUES ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000409', 'admin', 'admin') ON CONFLICT (id) DO NOTHING;
