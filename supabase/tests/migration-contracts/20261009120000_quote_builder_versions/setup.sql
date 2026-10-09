-- Prerequisites for 20261009120000_quote_builder_versions: the tables its foreign keys name
-- (jobs, users, job_variations, job_documents) and the API roles its grants name. Every one is
-- already created by an earlier registered setup; this only checks they are there.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.users', 'public.job_variations', 'public.job_documents'] LOOP
  IF to_regclass(t) IS NULL THEN RAISE EXCEPTION 'quote builder setup: % missing from the registered stack', t; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
   RAISE EXCEPTION 'quote builder setup: role % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
