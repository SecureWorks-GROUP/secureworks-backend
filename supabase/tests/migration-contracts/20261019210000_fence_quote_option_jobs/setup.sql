-- Prerequisites for 20261019210000_fence_quote_option_jobs. Earlier registered cases create
-- public.jobs, public.users, public.feature_flags, public.job_events, public.job_assignments and
-- public.xero_invoices; the columns this migration reads are made sure of here.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.feature_flags', 'public.job_events',
                          'public.job_assignments', 'public.xero_invoices'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'fence quote option jobs setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS ghl_contact_id text;
ALTER TABLE public.job_events
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS detail_json jsonb;
ALTER TABLE public.job_assignments ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS status text;
