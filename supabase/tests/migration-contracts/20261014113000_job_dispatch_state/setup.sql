-- Prerequisites for 20261014113000_job_dispatch_state. Earlier registered cases already create
-- public.users, public.jobs and the API roles in reduced shapes (checked here); the table only
-- references jobs(id) and users(id), so nothing is added.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.users', 'public.jobs'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'job dispatch state setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
   RAISE EXCEPTION 'job dispatch state setup: role % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
