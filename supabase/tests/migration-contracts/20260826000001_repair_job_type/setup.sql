-- Minimal pre-migration schema surface required by the repair job type contract.
-- This is test infrastructure, not a replacement for the production schema.
--
-- The runner applies registered cases in timestamp order, so public.jobs already
-- exists from 20260821093825's setup. Everything below is written to be additive
-- and compatible with that table rather than redefining it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  status text NOT NULL,
  type text NOT NULL,
  job_number text NOT NULL UNIQUE
);

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS site_address text,
  ADD COLUMN IF NOT EXISTS site_suburb text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS legacy boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ses_money_sealed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ses_money_seal_source text,
  ADD COLUMN IF NOT EXISTS ses_money_seal_version int,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- The job_number auto-assign trigger fills this in BEFORE INSERT, so the column
-- stays NOT NULL exactly as the earlier registered setup declared it.
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

CREATE TABLE IF NOT EXISTS public.job_number_counters (
  year smallint PRIMARY KEY,
  last_seq int NOT NULL
);

-- IMPORTANT: this is the DEPLOYED definition of next_job_number, not the newest
-- repo migration's. Production ends with
--   lpad(seq::text, greatest(3, length(seq::text)), '0')
-- while supabase/migrations/20260601000001_makesafe_job_contract.sql:64 still
-- reads lpad(seq::text, 3, '0'). No migration in this repository contains the
-- greatest() form. The contract must model production, and the migration under
-- test patches the deployed body in place precisely so this width fix survives.
CREATE OR REPLACE FUNCTION public.next_job_number(job_type text DEFAULT 'patio'::text)
RETURNS text
LANGUAGE plpgsql
AS $function$
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
  -- Minimum width 3, but never truncate a longer (>=1000) sequence.
  RETURN prefix || yr::text || lpad(seq::text, greatest(3, length(seq::text)), '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_assign_job_number()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.job_number IS NULL THEN
    NEW.job_number := next_job_number(COALESCE(NEW.type, 'patio'));
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_auto_job_number ON public.jobs;
CREATE TRIGGER trg_auto_job_number
  BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.auto_assign_job_number();

CREATE TABLE IF NOT EXISTS public.makesafe_job_details (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  requesting_company_slug text,
  requesting_company_name text,
  external_ref text,
  report_type text,
  substatus text NOT NULL DEFAULT 'company_contact_required'
    CHECK (substatus IN (
      'company_contact_required',
      'company_contact_done',
      'waiting_on_trade_report',
      'admin_to_send_report',
      'ready_to_invoice',
      'complete'
    )),
  created_at timestamptz NOT NULL DEFAULT now()
);

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

-- The SECOND auto-seal path, reproduced verbatim from
-- 20260728050000_makesafe_ses_fence_hardening.sql:65-125. This is the one the
-- migration patches: it carries NO type predicate, and the repair route always
-- inserts a details row, so without §7 every repair job is sealed at mint.
CREATE OR REPLACE FUNCTION public.seal_makesafe_job_v1(
  p_job_id uuid,
  p_source text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_job_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.jobs
  SET
    ses_money_sealed_at = clock_timestamp(),
    ses_money_seal_source = COALESCE(NULLIF(btrim(p_source), ''), 'canonical_spine'),
    ses_money_seal_version = 1
  WHERE id = p_job_id
    AND ses_money_sealed_at IS NULL;
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM public.jobs WHERE id = p_job_id
  ) THEN
    RAISE EXCEPTION 'cannot seal missing SES job %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.seal_makesafe_child_job_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seal_makesafe_job_v1(NEW.job_id, TG_TABLE_NAME);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_makesafe_details_seal_job
  ON public.makesafe_job_details;
CREATE TRIGGER trg_makesafe_details_seal_job
  AFTER INSERT OR UPDATE OF job_id ON public.makesafe_job_details
  FOR EACH ROW EXECUTE FUNCTION public.seal_makesafe_child_job_v1();

DROP TRIGGER IF EXISTS trg_makesafe_job_details_job_type
  ON public.makesafe_job_details;
CREATE TRIGGER trg_makesafe_job_details_job_type
  BEFORE INSERT OR UPDATE OF job_id
  ON public.makesafe_job_details
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_makesafe_job_details_job_type();

CREATE TABLE IF NOT EXISTS public.makesafe_intake_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  state text NOT NULL,
  reason_code text,
  job_id uuid,
  target_job_id uuid,
  external_ref_canonical text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.validate_makesafe_intake_target_job()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.target_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.jobs j
    WHERE j.id = NEW.target_job_id
      AND j.org_id = NEW.org_id
      AND j.type = 'makesafe'
  ) THEN
    RAISE EXCEPTION
      'intake target job must be a make-safe in the same organisation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_makesafe_intake_target_job
  ON public.makesafe_intake_cases;
CREATE TRIGGER trg_makesafe_intake_target_job
  BEFORE INSERT OR UPDATE OF org_id, target_job_id
  ON public.makesafe_intake_cases
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_makesafe_intake_target_job();

-- A deliberately reduced stand-in for the production
-- enforce_makesafe_intake_case_write(): it carries the ONE predicate the
-- migration patches, plus one unrelated guard, so the contract can prove the
-- in-place patch widened the job-type predicate WITHOUT disturbing the rest of
-- the body it never transcribed.
CREATE OR REPLACE FUNCTION public.enforce_makesafe_intake_case_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.state IS NULL OR btrim(NEW.state) = '' THEN
    RAISE EXCEPTION 'case state is required';
  END IF;

  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.jobs job
    WHERE job.id = NEW.job_id
      AND job.org_id = NEW.org_id
      AND job.type = 'makesafe'
  ) THEN
    RAISE EXCEPTION 'job_id must reference a make-safe job in the same org';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_makesafe_intake_cases_enforce
  ON public.makesafe_intake_cases;
CREATE TRIGGER trg_makesafe_intake_cases_enforce
  BEFORE INSERT OR UPDATE
  ON public.makesafe_intake_cases
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_makesafe_intake_case_write();

-- A deliberately REDUCED stand-in for public.job_financials. The production view
-- is ~110 lines of revenue/cost CTEs and margin arithmetic over xero_invoices and
-- v_trade_charge_resolved; none of that is what the migration touches. What the
-- migration touches is the single trailing type predicate, and this stand-in
-- carries the WHERE clause in exactly the production shape (org + legacy +
-- not-cancelled + type) so the in-place regex patch is exercised against a real
-- catalog definition, with the real rendering PostgreSQL chooses.
CREATE OR REPLACE VIEW public.job_financials AS
SELECT
  j.id          AS job_id,
  j.job_number,
  j.client_name,
  j.type        AS job_type,
  j.status,
  j.created_at
FROM public.jobs j
WHERE j.org_id  = '00000000-0000-0000-0000-000000000001'
  AND j.legacy  = false
  AND j.status <> 'cancelled'
  AND j.type    = 'makesafe';
