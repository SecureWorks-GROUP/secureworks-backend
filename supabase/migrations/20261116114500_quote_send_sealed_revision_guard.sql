-- Ruling 18 K2: a fence or patio quote goes to a customer only from its
-- sealed, newest revision, as the PDF prepared for that revision.
--
-- 1. job_documents.scope_revision_id: the frozen revision a quote document was
--    prepared for. Written only by ghl-proxy prepare_quote and
--    prepare_neighbour_quotes when the producer names a frozen row of the same
--    job; null on every older row and whenever none is named.
-- 2. quote_send_sealed_revision_misses: one row per fence or patio send the
--    guard misses, refused (switch on) or sent as today (switch off). Ids,
--    codes and the calling page only; never a name, address, email, phone,
--    message, PDF address or link token. Append only; service role only.
-- 3. feature_flags.quote_send_sealed_revision_required_v1, seeded OFF. Missing
--    or unreadable reads as off (send-quote sealed_send_guard.ts).
--
-- Nothing here changes a send. The rollback keeps the recorded misses.

ALTER TABLE public.job_documents
  ADD COLUMN IF NOT EXISTS scope_revision_id uuid REFERENCES public.scope_revisions(id) ON DELETE RESTRICT;
COMMENT ON COLUMN public.job_documents.scope_revision_id IS
  'Ruling 18 K2: the frozen scope revision this quote document was prepared for, recorded by ghl-proxy prepare_quote / prepare_neighbour_quotes only when the producer names a frozen row of the same job. Null means unknown. send-quote compares it with the revision a fence or patio send names.';

CREATE TABLE IF NOT EXISTS public.quote_send_sealed_revision_misses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logged_at timestamptz NOT NULL DEFAULT now(),
  job_id uuid NOT NULL,
  path text NOT NULL CHECK (path IN ('send', 'send-runs')),
  document_id uuid,
  named_scope_revision_id uuid,
  reason text NOT NULL CHECK (reason IN (
    'no_named_revision',
    'revision_not_sealed',
    'revision_not_newest',
    'document_revision_unrecorded',
    'document_revision_mismatch',
    'run_pdf_not_from_revision',
    'check_unreadable'
  )),
  switch_on boolean NOT NULL,
  sender_mode text NOT NULL CHECK (sender_mode IN ('api_key', 'jwt')),
  sender_user_id uuid,
  caller_origin text CHECK (caller_origin IS NULL OR (length(caller_origin) <= 200 AND caller_origin !~ '[?#@]')),
  caller_referer text CHECK (caller_referer IS NULL OR (length(caller_referer) <= 300 AND caller_referer !~ '[?#@]')),
  body_keys text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(body_keys) <= 40
    AND array_to_string(body_keys, ',') ~ '^[A-Za-z0-9_,]*$'
  )
);
COMMENT ON TABLE public.quote_send_sealed_revision_misses IS
  'Ruling 18 K2: every fence or patio quote send (send-quote /send, /send-runs) that was not from its sealed, newest revision as the PDF prepared for it. switch_on false: sent as today; true: refused, nothing sent. Ids, codes, the sign-in that sent it and the calling page (origin and path only, and the names of the request body keys, never their values). No customer details. Append only.';

CREATE INDEX IF NOT EXISTS quote_send_sealed_revision_misses_job_idx
  ON public.quote_send_sealed_revision_misses (job_id, logged_at DESC);

CREATE OR REPLACE FUNCTION public.quote_send_sealed_revision_misses_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'quote_send_sealed_revision_misses is append only'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_quote_send_sealed_revision_misses_append_only ON public.quote_send_sealed_revision_misses;
CREATE TRIGGER trg_quote_send_sealed_revision_misses_append_only
  BEFORE UPDATE OR DELETE ON public.quote_send_sealed_revision_misses
  FOR EACH ROW EXECUTE FUNCTION public.quote_send_sealed_revision_misses_append_only();
DROP TRIGGER IF EXISTS trg_quote_send_sealed_revision_misses_no_truncate ON public.quote_send_sealed_revision_misses;
CREATE TRIGGER trg_quote_send_sealed_revision_misses_no_truncate
  BEFORE TRUNCATE ON public.quote_send_sealed_revision_misses
  FOR EACH STATEMENT EXECUTE FUNCTION public.quote_send_sealed_revision_misses_append_only();

ALTER TABLE public.quote_send_sealed_revision_misses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_send_sealed_revision_misses FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.quote_send_sealed_revision_misses FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.quote_send_sealed_revision_misses FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON public.quote_send_sealed_revision_misses FROM service_role';
    EXECUTE 'GRANT SELECT, INSERT ON public.quote_send_sealed_revision_misses TO service_role';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.quote_send_sealed_revision_misses_append_only() FROM PUBLIC;

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES (
  'quote_send_sealed_revision_required_v1', false,
  'Ruling 18 K2. When on, send-quote refuses a fence or patio send (/send and /send-runs) that names no sealed revision, names one whose frozen pricing is not sealed, names one that is not the job''s newest frozen revision, or whose PDF is not that revision''s own (the document''s recorded revision, or a run PDF not recorded on the revision); nothing is sent and the scoper is told to open the Scope Engine, seal and save, then send. Off (as seeded): every send goes as before and each one it would refuse is recorded in quote_send_sealed_revision_misses. Turning it on stops every send from the old fence page copy (before 4 Nov). The owner says when.')
ON CONFLICT (flag_name) DO NOTHING;
