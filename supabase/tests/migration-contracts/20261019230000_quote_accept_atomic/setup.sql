-- Prerequisites for 20261019230000_quote_accept_atomic. Earlier registered cases create
-- public.jobs, public.job_contacts, public.job_documents, public.run_acceptances,
-- public.run_line_items, public.job_events and public.feature_flags, and
-- 20261019210000_fence_quote_option_jobs creates quote_option_settle_runs and the supersede
-- trigger; the columns and the unique key this migration uses are made sure of here.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.job_contacts', 'public.job_documents',
                          'public.run_acceptances', 'public.run_line_items', 'public.job_events',
                          'public.feature_flags'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'quote accept atomic setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE public.job_documents
  ADD COLUMN IF NOT EXISTS sent_to_client boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS share_token text,
  ADD COLUMN IF NOT EXISTS send_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS version int DEFAULT 1,
  ADD COLUMN IF NOT EXISTS run_label text,
  ADD COLUMN IF NOT EXISTS job_contact_id uuid,
  ADD COLUMN IF NOT EXISTS data_snapshot_json jsonb,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.run_acceptances
  ADD COLUMN IF NOT EXISTS job_document_id uuid,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_accept_unique
  ON public.run_acceptances (job_id, job_contact_id, run_label);
ALTER TABLE public.job_events ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
