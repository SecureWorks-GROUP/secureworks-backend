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

-- A committed acceptance that exists before this migration, so the rollback contract can
-- prove the down keeps acceptances (document, job status and accepted_at, event) in place.
INSERT INTO public.jobs (id, org_id, status, type, accepted_at)
VALUES ('9e9e0000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio',
        '2026-10-01 00:00:00+00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.job_documents (id, job_id, type, sent_to_client, accepted_at)
VALUES ('9e9e0000-0000-4000-8000-0000000000d1', '9e9e0000-0000-4000-8000-000000000001', 'quote', true,
        '2026-10-01 00:00:00+00')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.job_events (id, job_id, event_type, detail_json)
VALUES ('9e9e0000-0000-4000-8000-0000000000e1', '9e9e0000-0000-4000-8000-000000000001', 'quote_accepted',
        '{"document_id":"9e9e0000-0000-4000-8000-0000000000d1"}')
ON CONFLICT (id) DO NOTHING;
