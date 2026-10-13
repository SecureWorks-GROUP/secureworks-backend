-- Prerequisites for 20261013160000_quote_builder_pricing_and_documents. Earlier registered cases already create public.users,
-- public.jobs and public.job_documents (checked here) and the API roles its grants name; only the
-- column this migration's index and this contract read is added, IF NOT EXISTS, in the live type.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.users', 'public.jobs', 'public.job_documents'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'quote builder pricing setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
   RAISE EXCEPTION 'quote builder pricing setup: role % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;

ALTER TABLE public.job_documents
 ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
