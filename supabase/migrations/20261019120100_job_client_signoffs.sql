-- 20261019120100_job_client_signoffs.sql
--
-- Client sign-off (Marnin, 19 Oct 2026, CALLS DSP-11): "trades should invoice
-- when the job has been signed off by the client, they should have a workflow
-- where they physically sign the job and say they are happy with it and then
-- we chase them up for payment and this allows the allocated trades to get
-- onto it".
--
-- What it adds:
--   1. job_client_signoffs: one append-only row per sign-off. The newest row
--      for a job is its current sign-off, so a reattendance can be signed
--      again. method on_site (the completion wizard) or office_waiver (staff,
--      with a reason). A row is written whether or not the client was happy;
--      whether it counts is decided in ops-api (trade_client_signoff.ts) from
--      client_signoff_settings, never stored as a verdict here.
--   2. client_signoff_settings (one row): the rating a happy sign-off needs,
--      the job types the invoice gate covers, and the instant it starts
--      applying. The seeded values are PROPOSALS awaiting Marnin's word.
--   3. feature flag trade_invoice_requires_client_signoff_v1, seeded OFF.
--      While it is off no invoice path reads a sign-off (each gated call
--      reads only the flag). An unreadable flag counts as off.
--
-- Nothing here sends, writes money, or changes an existing row.

-- ── 1. the record ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.job_client_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  method text NOT NULL CHECK (method IN ('on_site', 'office_waiver')),
  signed_name text,
  happy boolean,
  satisfaction_rating smallint CHECK (satisfaction_rating IS NULL OR satisfaction_rating BETWEEN 1 AND 5),
  signature_media_id uuid REFERENCES public.job_media(id),
  waiver_reason text,
  captured_by uuid,
  captured_by_actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_client_signoffs_on_site_check CHECK (
    method <> 'on_site'
    OR (length(btrim(COALESCE(signed_name, ''))) > 0 AND signature_media_id IS NOT NULL)
  ),
  CONSTRAINT job_client_signoffs_waiver_check CHECK (
    method <> 'office_waiver'
    OR (length(btrim(COALESCE(waiver_reason, ''))) >= 3 AND signature_media_id IS NULL)
  ),
  CONSTRAINT job_client_signoffs_actor_check CHECK (
    captured_by_actor <> '' AND captured_by_actor <> 'actor_missing'
  )
);

CREATE INDEX IF NOT EXISTS idx_job_client_signoffs_job_created
  ON public.job_client_signoffs (job_id, created_at DESC);

COMMENT ON TABLE public.job_client_signoffs IS
  'Client sign-off of a finished job (DSP-11). Append-only; the newest row per job is current. Whether it counts (happy, rating) is decided by ops-api trade_client_signoff.ts from client_signoff_settings.';

CREATE OR REPLACE FUNCTION public.job_client_signoffs_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'job_client_signoffs is append-only: record a newer sign-off instead'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_job_client_signoffs_append_only ON public.job_client_signoffs;
CREATE TRIGGER trg_job_client_signoffs_append_only
  BEFORE UPDATE OR DELETE ON public.job_client_signoffs
  FOR EACH ROW EXECUTE FUNCTION public.job_client_signoffs_append_only();

-- A row trigger never fires on TRUNCATE, so it gets its own statement trigger.
DROP TRIGGER IF EXISTS trg_job_client_signoffs_no_truncate ON public.job_client_signoffs;
CREATE TRIGGER trg_job_client_signoffs_no_truncate
  BEFORE TRUNCATE ON public.job_client_signoffs
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_client_signoffs_append_only();

ALTER TABLE public.job_client_signoffs ENABLE ROW LEVEL SECURITY;
-- Supabase's default privileges give service_role ALL on a new table, and a
-- GRANT never takes anything away, so service_role is revoked first.
REVOKE ALL ON TABLE public.job_client_signoffs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.job_client_signoffs TO service_role;
REVOKE ALL ON FUNCTION public.job_client_signoffs_append_only() FROM PUBLIC, anon, authenticated;

-- ── 2. settings (PROPOSALS) ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_signoff_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  min_happy_rating smallint NOT NULL DEFAULT 4 CHECK (min_happy_rating BETWEEN 1 AND 5),
  gated_job_types text[] NOT NULL DEFAULT ARRAY['fencing', 'patio'],
  applies_from timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.client_signoff_settings IS
  'One row. PROPOSALS until Marnin confirms: a rating under min_happy_rating is not a sign-off; the invoice gate covers gated_job_types only; jobs completed before applies_from are not held (null = every job).';

INSERT INTO public.client_signoff_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.client_signoff_settings ENABLE ROW LEVEL SECURITY;
-- Read-only to ops-api: only a reviewed migration changes a proposal.
REVOKE ALL ON TABLE public.client_signoff_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.client_signoff_settings TO service_role;

-- ── 3. the switch ────────────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('trade_invoice_requires_client_signoff_v1', false,
   'A trade cannot invoice a job (work order or per-metre) until the client has signed it off as finished and happy, or the office has waived it with a reason (DSP-11). Off until Marnin says turn it on.')
ON CONFLICT (flag_name) DO NOTHING;
