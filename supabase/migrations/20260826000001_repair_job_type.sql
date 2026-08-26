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
-- Money seal — CORRECTED 2026-08-26 after a production risk assessment:
--   An earlier version of this header claimed repair jobs would not be
--   auto-money-sealed because guard_jobs_ses_money_seal_v1 is untouched. That
--   was TRUE of the jobs-table guard and FALSE of the outcome. There is a
--   SECOND seal path: trg_makesafe_details_seal_job fires AFTER INSERT on
--   makesafe_job_details and calls seal_makesafe_job_v1(), which carries no
--   type predicate at all — and the repair route ALWAYS inserts a details row.
--   Verified live: 536 of 536 jobs holding a details row are sealed, 100%.
--   So every repair job would have been sealed on the way in, permanently,
--   the seal being write-once and impossible to clear.
--   §7 below closes that path for repair-typed jobs. guard_jobs_ses_money_seal_v1
--   itself stays untouched (a repair job is type='repair' with an SWR- number and
--   matches neither of its two arms).
--   >>> OPEN RISK #1 — captain signoff still required, and the decision must be
--   re-taken on these facts rather than the earlier false premise. <<<
--
-- What deliberately does NOT change:
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
-- 6) Repair revenue stays inside the P&L view.
--
-- job_financials (20260613000001:133-241) ends `AND j.type = 'makesafe'` — its
-- own comment calls that "V1 SCOPE: remove at M6 to expand to all jobs". Today's
-- repair cards are type='makesafe', so they ARE in that view. The moment the type
-- flips they drop out, and the first SWR- job's revenue would be missing from the
-- one P&L surface the ops job-financials panel reads. That is a month-end
-- surprise, not a backlog item, so the view moves with the type.
--
-- Its cost lanes come from v_trade_charge_resolved directly (NOT from
-- v_makesafe_charge_ledger), so admitting repair to the WHERE clause is the whole
-- fix: labour and materials resolve for a repair job exactly as for a make-safe.
--
-- Patched in place for the same reason as §2 and §5 — the view body is ~110 lines
-- of margin arithmetic and flag vocabulary that must not be retyped to change one
-- predicate, and CREATE OR REPLACE VIEW would reject any accidental column drift
-- anyway. The anchor is regex-matched so it tolerates however PostgreSQL chose to
-- render the literal ('makesafe' vs 'makesafe'::text, with or without brackets),
-- and it refuses unless it matches exactly once.
-- ─────────────────────────────────────────────────────────────────────────────
DO $repair_job_financials$
DECLARE
  view_body text;
  makesafe_predicate_re constant text := '\(?\s*j\.type\s*=\s*''makesafe''(::text)?\s*\)?';
  predicate_hits int;
  patched_body text;
BEGIN
  IF to_regclass('public.job_financials') IS NULL THEN
    RAISE NOTICE 'job_financials is not deployed here; nothing to widen';
    RETURN;
  END IF;

  view_body := pg_get_viewdef('public.job_financials'::regclass, true);

  -- Idempotent re-run.
  IF view_body ~ '''repair''' THEN
    RAISE NOTICE 'job_financials already admits repair; no change';
    RETURN;
  END IF;

  SELECT count(*) INTO predicate_hits
  FROM regexp_matches(view_body, makesafe_predicate_re, 'g');

  IF predicate_hits <> 1 THEN
    RAISE EXCEPTION
      'job_financials contains % make-safe type predicates (expected exactly 1); refusing to patch blind',
      predicate_hits;
  END IF;

  patched_body := regexp_replace(
    view_body,
    makesafe_predicate_re,
    'j.type = ANY (ARRAY[''makesafe''::text, ''repair''::text])'
  );

  EXECUTE 'CREATE OR REPLACE VIEW public.job_financials AS ' || patched_body;
END;
$repair_job_financials$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) A repair job is NOT auto-money-sealed by the child-table path.
--
-- This is the defect the production risk assessment found, and it is the reason
-- Captain Decision 4 has to be re-taken on true facts.
--
-- There are TWO auto-seal paths, and only one of them was accounted for:
--   a. guard_jobs_ses_money_seal_v1 — BEFORE INSERT/UPDATE on jobs, seals when
--      type is 'makesafe' OR job_number matches ^SWMS-. A repair job is
--      type='repair' with an SWR- number, so this arm genuinely never fires.
--      Untouched, exactly as the captain decision says.
--   b. seal_makesafe_job_v1(job_id, source) — called by seal_makesafe_child_job_v1
--      from AFTER INSERT triggers on makesafe_job_details, makesafe_attendance_cycles
--      and makesafe_docket_revisions, and by seal_makesafe_case_jobs_v1 from
--      makesafe_intake_cases (both job_id and target_job_id). It has NO type
--      predicate whatsoever — it seals whatever job id it is handed.
--
-- The repair route ALWAYS inserts a makesafe_job_details row (that row is what
-- keeps a repair card inside the SES evidence surface — see §3), so path (b)
-- would have sealed every repair job at mint. Live proof: 536 of 536 jobs
-- holding a details row are sealed. And §5 of this same migration lets an intake
-- case link a repair job, which arms the case trigger for repair too.
--
-- The seal is write-once and can never be cleared or mutated (ERRCODE 23514), so
-- this is not a thing that could be tidied up afterwards.
--
-- The predicate goes in seal_makesafe_job_v1 itself rather than in one trigger,
-- because that single function is the choke point for ALL FIVE child paths.
-- Fixing the details trigger alone would leave the case-link path open.
--
-- A repair job now falls through as a silent no-op: the UPDATE matches no row,
-- and the existing not-found guard still raises only when the job genuinely does
-- not exist, so a missing job is still a loud error.
--
-- Patched in place with the same fail-closed discipline as §2, §5 and §6.
-- ─────────────────────────────────────────────────────────────────────────────
DO $repair_money_seal$
DECLARE
  current_definition text;
  seal_predicate_re constant text := 'AND\s+ses_money_sealed_at\s+IS\s+NULL\s*;';
  predicate_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO current_definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'seal_makesafe_job_v1'
    AND pg_get_function_identity_arguments(p.oid) = 'p_job_id uuid, p_source text';

  IF current_definition IS NULL THEN
    RAISE EXCEPTION
      'seal_makesafe_job_v1(uuid, text) is not deployed; the repair seal exemption cannot be applied';
  END IF;

  -- Idempotent re-run.
  IF current_definition ~ 'type\s*<>\s*''repair''' THEN
    RAISE NOTICE 'seal_makesafe_job_v1 already exempts repair jobs; no change';
    RETURN;
  END IF;

  SELECT count(*) INTO predicate_hits
  FROM regexp_matches(current_definition, seal_predicate_re, 'g');

  IF predicate_hits <> 1 THEN
    RAISE EXCEPTION
      'seal_makesafe_job_v1 contains % seal predicates (expected exactly 1); refusing to patch blind',
      predicate_hits;
  END IF;

  EXECUTE regexp_replace(
    current_definition,
    seal_predicate_re,
    'AND ses_money_sealed_at IS NULL' || E'\n' ||
    '    -- A repair job is never auto-sealed by a child-table write. Its' || E'\n' ||
    '    -- pipeline carries quoted/variation stages the SES money seal blocks.' || E'\n' ||
    '    AND type <> ''repair'';'
  );
END;
$repair_money_seal$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) Post-conditions. Every promise this migration makes is asserted here so a
-- partially applied file fails the transaction rather than deploying half a
-- contract.
-- ─────────────────────────────────────────────────────────────────────────────
DO $repair_contract_assertions$
DECLARE
  type_check_definition text;
  numbering_definition text;
  intake_case_definition text;
  financials_definition text;
  seal_definition text;
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

  IF to_regclass('public.job_financials') IS NOT NULL THEN
    financials_definition := pg_get_viewdef('public.job_financials'::regclass, true);
    IF financials_definition !~ '''repair''' THEN
      RAISE EXCEPTION 'job_financials still excludes repair jobs from the P&L view';
    END IF;
    IF financials_definition !~ '''makesafe''' THEN
      RAISE EXCEPTION 'job_financials lost make-safe jobs while admitting repair';
    END IF;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO seal_definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'seal_makesafe_job_v1'
    AND pg_get_function_identity_arguments(p.oid) = 'p_job_id uuid, p_source text';
  IF seal_definition !~ 'type\s*<>\s*''repair''' THEN
    RAISE EXCEPTION 'seal_makesafe_job_v1 would still auto-seal a repair job';
  END IF;
  IF seal_definition !~ 'ses_money_sealed_at\s+IS\s+NULL' THEN
    RAISE EXCEPTION 'seal_makesafe_job_v1 lost its already-sealed guard';
  END IF;
END;
$repair_contract_assertions$;

COMMENT ON CONSTRAINT jobs_type_check ON public.jobs IS
  'Central job type vocabulary. ''repair'' added 2026-08-26 for the SES repair intake pipeline (SWR- numbers, Repairs board stages in jobs.metadata.repair_stage).';
