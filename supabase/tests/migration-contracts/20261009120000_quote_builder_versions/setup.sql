-- Prerequisites for 20261009120000_quote_builder_versions: the tables its foreign keys name
-- (jobs, users, job_variations, job_documents) and the API roles its grants name, which an earlier
-- registered setup already creates (checked here), and job_media with its live phase check
-- (20260908100000), which no earlier setup needs, so it is created here.
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

CREATE TABLE IF NOT EXISTS public.job_media (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid,
 phase text,
 type text,
 storage_url text,
 label text,
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_media_phase_check'
                AND conrelid = 'public.job_media'::regclass) THEN
  ALTER TABLE public.job_media ADD CONSTRAINT job_media_phase_check
   CHECK (phase IN ('scope', 'in_progress', 'completion', 'receipt', 'marketing', 'neighbour_signoff', 'issue'));
 END IF;
END $$;
