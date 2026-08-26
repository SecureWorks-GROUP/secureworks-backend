-- Repair intake pipeline — slice 1 schema contract
--
-- Business meaning:
--   Insurance REPAIR work orders arriving in the SES mailbox are already
--   classified deterministically (family = 'repair'). Until now they were minted
--   as make-safes (SWMS-) and only *looked* like repairs on the Repairs board.
--   This migration makes `jobs.type = 'repair'` a real, lawful, SWR- numbered
--   job type, while keeping every SES evidence/pack surface those cards depend
--   on (the makesafe_job_details overlay row and the intake-case links).
--
-- What deliberately does NOT change:
--   * guard_jobs_ses_money_seal_v1 is untouched. A repair job numbered SWR- is
--     therefore NOT auto-money-sealed. That is intentional: the repair pipeline
--     carries quoted/variation stages the SES money seal would block.
--     >>> OPEN RISK #1 — captain signoff required. <<<
--   * No existing row is retyped, renumbered or re-sealed here. Backfill is a
--     separate, additive, metadata-only script (scripts/backfill-repair-stage.sql).
--   * renovation and roofing keep their SWR- mapping. Zero rows of either type
--     exist and zero SWR- numbers exist, and job_number_counters is one shared
--     per-year sequence, so there is no sequence conflict — only a prefix that no
--     longer identifies a type on its own.
--
-- Safety:
--   PR review IS the production gate for this file (merge to main auto-applies).
--   Every function change below is either a verbatim re-declaration of a small
--   deployed function or a fail-closed, assertion-guarded in-place patch of a
--   large one. Nothing is patched blind.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Admit 'repair' to the central job type vocabulary.
-- Supersedes 20260601000001_makesafe_job_contract.sql:14-27 (the 10-value list).
-- ─────────────────────────────────────────────────────────────────────────────
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
    'makesafe',
    'repair'
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) next_job_number: add the repair -> 'SWR-' branch.
--
-- This is patched IN PLACE rather than re-declared from the repo text, and the
-- reason is load-bearing:
--
--   The deployed function ends with
--       lpad(seq::text, greatest(3, length(seq::text)), '0')
--   but the newest repo migration (20260601000001:64) still says
--       lpad(seq::text, 3, '0')
--   No migration in this repository contains `greatest(3` — the width fix was
--   applied to production outside the migration history. public.job_number_counters
--   is already at last_seq = 1313, i.e. four digits. Re-declaring the repo body
--   would silently start truncating every new job number of every type
--   (SWR-26131 instead of SWR-261313). So the deployed definition is read from
--   the catalog, one CASE arm is inserted, and the rest is preserved byte for byte.
--
-- The patch is fail-closed: it refuses unless the fallback arm appears exactly once.
-- ─────────────────────────────────────────────────────────────────────────────
DO $repair_next_job_number$
DECLARE
  current_definition text;
  fallback_arm constant text := 'ELSE ''SW-''';
  fallback_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO current_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'next_job_number'
    AND pg_get_function_identity_arguments(p.oid) = 'job_type text';

  IF current_definition IS NULL THEN
    RAISE EXCEPTION
      'next_job_number(text) is not deployed; the repair prefix cannot be added';
  END IF;

  -- Idempotent re-run: the branch is already present, leave the body alone.
  IF current_definition ~ 'WHEN\s+''repair''' THEN
    RAISE NOTICE 'next_job_number already carries the repair branch; no change';
    RETURN;
  END IF;

  fallback_hits := (
    length(current_definition) - length(replace(current_definition, fallback_arm, ''))
  ) / length(fallback_arm);

  IF fallback_hits <> 1 THEN
    RAISE EXCEPTION
      'next_job_number prefix CASE has % fallback arms (expected exactly 1); refusing to patch blind',
      fallback_hits;
  END IF;

  EXECUTE replace(
    current_definition,
    fallback_arm,
    'WHEN ''repair''        THEN ''SWR-''' || E'\n    ' || fallback_arm
  );
END;
$repair_next_job_number$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) makesafe_job_details may hang off a repair job.
--
-- Repair jobs KEEP their overlay details row. That row is what carries them into
-- the MakeSafe board population (from which excludeInsuranceRepairs then filters
-- them out, exactly as today), keeps them visible to the fuzzy duplicate guard
-- that scans makesafe_job_details.external_ref, and keeps the whole SES
-- evidence/pack/report/invoice recipe working with no SES-engine change.
--
-- Re-declared in full: the deployed body is four lines and matches
-- 20260601000001:128-142 verbatim. Only the type predicate widens.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_makesafe_job_details_job_type()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.jobs j
    WHERE j.id = NEW.job_id
      AND j.type IN ('makesafe', 'repair')
  ) THEN
    RAISE EXCEPTION 'makesafe_job_details rows require jobs.type = makesafe or repair';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) An intake case may TARGET a repair job (cancellation / reopen / correction).
-- Re-declared in full from 20260727012426:34-52; only the predicate widens.
-- Grants are re-asserted because CREATE OR REPLACE keeps existing ACLs but a
-- first-time deploy order must not depend on that.
-- ─────────────────────────────────────────────────────────────────────────────
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
      AND j.type IN ('makesafe', 'repair')
  ) THEN
    RAISE EXCEPTION
      'intake target job must be a make-safe or repair in the same organisation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_makesafe_intake_target_job()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_makesafe_intake_target_job()
  TO service_role, postgres;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) An intake case may LINK to a repair job (makesafe_intake_cases.job_id).
--
-- This predicate lives inside enforce_makesafe_intake_case_write(), a ~170-line
-- append-only/decision-provenance/state-machine enforcement function
-- (20260720000001:502-673). Transcribing all of it here to change one line would
-- put every one of those unrelated guards at transcription risk, so instead the
-- deployed definition is read from the catalog and exactly one predicate is
-- rewritten. Everything else stays byte for byte.
--
-- This write is what the deterministic runtime performs immediately after a mint
-- (makesafe_deterministic_intake_runtime.ts:3937 via :5062-5072), so without this
-- widening a repair job would mint and then throw mid-run at case linkage.
--
-- Fail-closed: refuses unless the make-safe predicate appears exactly once.
-- ─────────────────────────────────────────────────────────────────────────────
DO $repair_intake_case_link$
DECLARE
  current_definition text;
  makesafe_predicate constant text := 'job.type = ''makesafe''';
  widened_predicate constant text := 'job.type IN (''makesafe'', ''repair'')';
  predicate_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO current_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'enforce_makesafe_intake_case_write'
    AND pg_get_function_identity_arguments(p.oid) = '';

  IF current_definition IS NULL THEN
    RAISE EXCEPTION
      'enforce_makesafe_intake_case_write() is not deployed; the repair link cannot be admitted';
  END IF;

  -- Idempotent re-run.
  IF position(widened_predicate in current_definition) > 0 THEN
    RAISE NOTICE 'intake case job_id guard already admits repair; no change';
    RETURN;
  END IF;

  predicate_hits := (
    length(current_definition) - length(replace(current_definition, makesafe_predicate, ''))
  ) / length(makesafe_predicate);

  IF predicate_hits <> 1 THEN
    RAISE EXCEPTION
      'enforce_makesafe_intake_case_write contains % make-safe job-type predicates (expected exactly 1); refusing to patch blind',
      predicate_hits;
  END IF;

  current_definition := replace(
    current_definition,
    makesafe_predicate,
    widened_predicate
  );
  current_definition := replace(
    current_definition,
    'job_id must reference a make-safe job in the same org',
    'job_id must reference a make-safe or repair job in the same org'
  );
  EXECUTE current_definition;
END;
$repair_intake_case_link$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Post-conditions. Every promise this migration makes is asserted here so a
-- partially applied file fails the transaction rather than deploying half a
-- contract.
-- ─────────────────────────────────────────────────────────────────────────────
DO $repair_contract_assertions$
DECLARE
  type_check_definition text;
  numbering_definition text;
  intake_case_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO type_check_definition
  FROM pg_constraint
  WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_type_check';
  IF type_check_definition IS NULL OR type_check_definition !~ '''repair''' THEN
    RAISE EXCEPTION 'jobs_type_check does not admit repair after this migration';
  END IF;
  IF type_check_definition !~ '''makesafe''' OR type_check_definition !~ '''fencing''' THEN
    RAISE EXCEPTION 'jobs_type_check lost a pre-existing job type';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO numbering_definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'next_job_number'
    AND pg_get_function_identity_arguments(p.oid) = 'job_type text';
  IF numbering_definition !~ 'WHEN\s+''repair''\s+THEN\s+''SWR-''' THEN
    RAISE EXCEPTION 'next_job_number did not gain the repair -> SWR- branch';
  END IF;
  IF numbering_definition !~ 'WHEN\s+''makesafe''\s+THEN\s+''SWMS-''' THEN
    RAISE EXCEPTION 'next_job_number lost the makesafe -> SWMS- branch';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO intake_case_definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'enforce_makesafe_intake_case_write'
    AND pg_get_function_identity_arguments(p.oid) = '';
  IF position('job.type IN (''makesafe'', ''repair'')' in intake_case_definition) = 0 THEN
    RAISE EXCEPTION 'intake case job_id guard still refuses repair jobs';
  END IF;
END;
$repair_contract_assertions$;

COMMENT ON CONSTRAINT jobs_type_check ON public.jobs IS
  'Central job type vocabulary. ''repair'' added 2026-08-26 for the SES repair intake pipeline (SWR- numbers, Repairs board stages in jobs.metadata.repair_stage).';
