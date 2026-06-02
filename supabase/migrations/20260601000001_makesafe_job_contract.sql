-- MakeSafe Job Mission — Slice 1 backend/state contract
--
-- Business meaning:
--   Make-safes are a real SecureSuite job type, not a separate tracker.
--   Core movement stays on public.jobs.status:
--     accepted -> scheduled -> in_progress -> complete -> invoiced -> archived
--   Make-safe-specific details/substages live in public.makesafe_job_details.
--
-- Safety:
--   This migration is intended for PR review first. Do not apply to production
--   without the standard SecureWorks deploy/migration approval gate.

-- 1) Allow the central jobs table to carry true make-safe jobs.
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN (
    'fencing',
    'patio',
    'combo',
    'decking',
    'renovation',
    'insurance',
    'roofing',
    'miscellaneous',
    'general',
    'makesafe'
  ));

-- Existing ops-api make-safe creation stores company/work-order metadata on
-- jobs.metadata. Some environments already have this; keep it idempotent.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2) Generate SWMS-YY### job numbers for make-safes through the same helper
-- used by other job types. SWM- already belongs to miscellaneous, so make-safe
-- gets SWMS- to stay unambiguous for ops, Xero references, and map/search.
CREATE OR REPLACE FUNCTION public.next_job_number(job_type text DEFAULT 'patio')
RETURNS text AS $$
DECLARE
  prefix text;
  yr smallint;
  seq int;
BEGIN
  prefix := CASE lower(job_type)
    WHEN 'patio'          THEN 'SWP-'
    WHEN 'fencing'        THEN 'SWF-'
    WHEN 'decking'        THEN 'SWD-'
    WHEN 'renovation'     THEN 'SWR-'
    WHEN 'insurance'      THEN 'SWI-'
    WHEN 'roofing'        THEN 'SWR-'
    WHEN 'miscellaneous'  THEN 'SWM-'
    WHEN 'general'        THEN 'SWG-'
    WHEN 'makesafe'       THEN 'SWMS-'
    ELSE 'SW-'
  END;

  yr := (EXTRACT(YEAR FROM now()) % 100)::smallint;

  INSERT INTO public.job_number_counters (year, last_seq)
  VALUES (yr, 1)
  ON CONFLICT (year) DO UPDATE SET last_seq = public.job_number_counters.last_seq + 1
  RETURNING last_seq INTO seq;

  RETURN prefix || yr::text || lpad(seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- 3) Requesting-company profiles. This supports manual ops entry now and
-- Graph/email parsing later without changing the job model again.
CREATE TABLE IF NOT EXISTS public.makesafe_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organisations(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  sender_patterns text[] NOT NULL DEFAULT '{}',
  invoice_email text,
  safety_requirements text,
  special_instructions text,
  external_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  parsing_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_makesafe_companies_org_active
  ON public.makesafe_companies (org_id, active);

-- 4) Make-safe overlay details. The high-level job is still public.jobs; this
-- table holds only the make-safe-specific business process fields.
CREATE TABLE IF NOT EXISTS public.makesafe_job_details (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  requesting_company_id uuid REFERENCES public.makesafe_companies(id) ON DELETE SET NULL,
  requesting_company_slug text,
  requesting_company_name text,
  external_ref text,
  substatus text NOT NULL DEFAULT 'company_contact_required'
    CHECK (substatus IN (
      'company_contact_required',
      'company_contact_done',
      'waiting_on_trade_report',
      'admin_to_send_report',
      'ready_to_invoice',
      'complete'
    )),
  company_contacted_at timestamptz,
  report_received_at timestamptz,
  report_sent_at timestamptz,
  invoice_ready_at timestamptz,
  invoice_notes text,
  safety_requirements text,
  special_instructions text,
  external_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  billing_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_makesafe_job_details_substatus
  ON public.makesafe_job_details (substatus);

CREATE INDEX IF NOT EXISTS idx_makesafe_job_details_company
  ON public.makesafe_job_details (requesting_company_slug);

-- Keep details limited to make-safe jobs. Postgres CHECK constraints cannot
-- look into another table, so enforce this with a small trigger instead.
CREATE OR REPLACE FUNCTION public.ensure_makesafe_job_details_job_type()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.jobs j
    WHERE j.id = NEW.job_id
      AND j.type = 'makesafe'
  ) THEN
    RAISE EXCEPTION 'makesafe_job_details rows require jobs.type = makesafe';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_makesafe_job_details_job_type
  ON public.makesafe_job_details;

CREATE TRIGGER trg_makesafe_job_details_job_type
  BEFORE INSERT OR UPDATE OF job_id
  ON public.makesafe_job_details
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_makesafe_job_details_job_type();

-- RLS follows the same conservative pattern as other backend-owned ops tables:
-- service role can fully manage it; authenticated reads can be added later
-- when the dashboard/trade UI contract is reviewed.
ALTER TABLE public.makesafe_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.makesafe_job_details ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'makesafe_companies'
      AND policyname = 'service_role_all_makesafe_companies'
  ) THEN
    CREATE POLICY "service_role_all_makesafe_companies"
      ON public.makesafe_companies FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'makesafe_job_details'
      AND policyname = 'service_role_all_makesafe_job_details'
  ) THEN
    CREATE POLICY "service_role_all_makesafe_job_details"
      ON public.makesafe_job_details FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

COMMENT ON TABLE public.makesafe_job_details IS
  'MakeSafe Job Mission overlay table. The core job remains public.jobs; this stores requesting-company refs, make-safe substages, report handoff, safety, and invoice notes.';
