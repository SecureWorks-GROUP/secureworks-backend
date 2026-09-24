-- M4 setup: every table and function this migration reads or calls already
-- exists from earlier registered fixtures (jobs, job_documents, business_events
-- with the ladder, context_capture_runs, feature_flags, automation_switches).
-- It adds stand-ins for the jobs triggers production has (read 24 Sep 2026)
-- that no earlier fixture creates, so the link action's UPDATE runs against
-- them: the expected-costs write-once guard (repository body, 20260705000005)
-- and the SES money seal, which fires only on UPDATE OF its own columns (the
-- stand-in refuses when it fires while m4.forbid_seal is on, so the contract
-- proves the link never fires it and no other contract is affected). The
-- updated_at stamp (trg_jobs_updated) is not stood in: the contract phase runs
-- every registered case after this setup, and earlier cases set updated_at by
-- hand.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS expected_costs jsonb, ADD COLUMN IF NOT EXISTS expected_frozen_at timestamptz;
CREATE OR REPLACE FUNCTION public.jobs_expected_costs_write_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.expected_costs IS NOT NULL
     AND NEW.expected_costs IS DISTINCT FROM OLD.expected_costs THEN
    RAISE EXCEPTION 'jobs.expected_costs is write-once (job %); a frozen expected-cost baseline cannot be modified or cleared', OLD.id
      USING errcode = '23514';
  END IF;
  IF OLD.expected_frozen_at IS NOT NULL
     AND NEW.expected_frozen_at IS DISTINCT FROM OLD.expected_frozen_at THEN
    RAISE EXCEPTION 'jobs.expected_frozen_at is write-once (job %)', OLD.id
      USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_jobs_expected_costs_write_once ON public.jobs;
CREATE TRIGGER trg_jobs_expected_costs_write_once BEFORE UPDATE ON public.jobs FOR EACH ROW
 WHEN (OLD.expected_costs IS NOT NULL OR OLD.expected_frozen_at IS NOT NULL)
 EXECUTE FUNCTION public.jobs_expected_costs_write_once();
CREATE OR REPLACE FUNCTION public.m4_standin_ses_money_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND coalesce(current_setting('m4.forbid_seal',true),'')='on' THEN RAISE EXCEPTION 'm4 ses money seal fired'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_jobs_ses_money_seal_v1 ON public.jobs;
CREATE TRIGGER trg_jobs_ses_money_seal_v1 BEFORE INSERT OR UPDATE OF type, job_number, ses_money_sealed_at, ses_money_seal_source, ses_money_seal_version
 ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.m4_standin_ses_money_seal();

-- This also checks that the fixtures leave exactly production's bodies of the
-- two functions the history load calls, as read from production.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.capture_business_event(jsonb)')) IS DISTINCT FROM '4819869e6dcc40d5cd19a7eba295392c'
 THEN RAISE EXCEPTION 'm4 setup: capture_business_event is not the production C1a body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.record_capture_run(jsonb)')) IS DISTINCT FROM 'db03c98a6da49f128595342f5a93f84c'
 THEN RAISE EXCEPTION 'm4 setup: record_capture_run is not the production F1b body'; END IF;
END $$;
