-- Captain Amendments 45-46: deterministic make-safe intake is permanent standing
-- authority. Reporting runs also invoke the bounded scanner and clean-draft gate.
--
-- Apply before the matching ops-api. This migration removes the legacy flip ritual:
-- fresh databases and the singleton production row both land deterministic/full_open,
-- with an explicit ten-case commit cap and empty exact allowlists.

UPDATE public.makesafe_cron_settings
SET
  intake_mode = 'deterministic',
  deterministic_selection_mode = 'full_open',
  deterministic_max_cases_per_run = 10,
  deterministic_source_allowlist = ARRAY[]::text[],
  deterministic_instruction_allowlist = ARRAY[]::text[],
  intake_mode_changed_at = now(),
  intake_mode_changed_by = 'captain-amendment-45',
  deterministic_rollout_changed_at = now(),
  deterministic_rollout_changed_by = 'captain-amendment-45',
  updated_at = now()
WHERE id = true;

ALTER TABLE public.makesafe_cron_settings
  ALTER COLUMN intake_mode SET DEFAULT 'deterministic',
  ALTER COLUMN deterministic_selection_mode SET DEFAULT 'full_open',
  ALTER COLUMN deterministic_max_cases_per_run SET DEFAULT 10;

ALTER TABLE public.makesafe_cron_settings
  DROP CONSTRAINT IF EXISTS makesafe_cron_settings_intake_mode_check;
ALTER TABLE public.makesafe_cron_settings
  ADD CONSTRAINT makesafe_cron_settings_intake_mode_check
  CHECK (intake_mode = 'deterministic');

ALTER TABLE public.makesafe_cron_settings
  DROP CONSTRAINT IF EXISTS makesafe_cron_settings_deterministic_selection_mode_check;
ALTER TABLE public.makesafe_cron_settings
  ADD CONSTRAINT makesafe_cron_settings_deterministic_selection_mode_check
  CHECK (deterministic_selection_mode = 'full_open');

ALTER TABLE public.makesafe_cron_settings
  DROP CONSTRAINT IF EXISTS makesafe_cron_settings_full_open_empty_allowlists_check;
ALTER TABLE public.makesafe_cron_settings
  ADD CONSTRAINT makesafe_cron_settings_full_open_empty_allowlists_check
  CHECK (
    cardinality(deterministic_source_allowlist) = 0
    AND cardinality(deterministic_instruction_allowlist) = 0
  );

COMMENT ON COLUMN public.makesafe_cron_settings.intake_mode IS
  'Compatibility truth field. Standing make-safe intake is permanently deterministic; this value can no longer select the retired paid-AI engine.';
COMMENT ON COLUMN public.makesafe_cron_settings.deterministic_selection_mode IS
  'Standing authority is full_open with empty allowlists. The runtime remains bounded by its cursor page, case cap and attempt ceiling.';
COMMENT ON COLUMN public.makesafe_cron_settings.deterministic_max_cases_per_run IS
  'Maximum deterministic cases committed per standing/reporting intake pass. Structurally bounded to 1..10; standing default is 10.';

UPDATE public.makesafe_intake_health
SET intake_mode = 'deterministic'
WHERE id = true;

ALTER TABLE public.makesafe_intake_health
  ALTER COLUMN intake_mode SET DEFAULT 'deterministic';
ALTER TABLE public.makesafe_intake_health
  DROP CONSTRAINT IF EXISTS makesafe_intake_health_intake_mode_check;
ALTER TABLE public.makesafe_intake_health
  ADD CONSTRAINT makesafe_intake_health_intake_mode_check
  CHECK (intake_mode = 'deterministic');

CREATE OR REPLACE FUNCTION public.makesafe_intake_mode()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'deterministic'::text;
$$;
REVOKE ALL ON FUNCTION public.makesafe_intake_mode() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_mode() TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.makesafe_deterministic_intake_preflight(p_org_id uuid)
RETURNS TABLE (check_name text, ok boolean, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'mode_is_deterministic',
    COALESCE(
      (SELECT intake_mode = 'deterministic'
       FROM public.makesafe_cron_settings WHERE id = true),
      false
    ),
    'standing intake authority must remain deterministic'
  UNION ALL
  SELECT 'selection_is_bounded_full_open',
    COALESCE(
      (SELECT deterministic_selection_mode = 'full_open'
          AND deterministic_max_cases_per_run BETWEEN 1 AND 10
          AND cardinality(deterministic_source_allowlist) = 0
          AND cardinality(deterministic_instruction_allowlist) = 0
       FROM public.makesafe_cron_settings WHERE id = true),
      false
    ),
    'standing intake uses an empty-allowlist bounded full-open sweep'
  UNION ALL
  SELECT 'duplicate_source_accounting',
    NOT EXISTS (
      SELECT 1 FROM public.makesafe_intake_case_sources
      WHERE org_id = p_org_id
      GROUP BY post_id HAVING count(*) > 1
    ),
    'each source post must account to at most one canonical case'
  UNION ALL
  SELECT 'live_case_without_job',
    NOT EXISTS (
      SELECT 1 FROM public.makesafe_intake_cases
      WHERE org_id = p_org_id
        AND state IN ('confirmed_live_job', 'blocked_live_job')
        AND job_id IS NULL
    ),
    'every live canonical case must retain its guarded job link';
$$;
REVOKE ALL ON FUNCTION public.makesafe_deterministic_intake_preflight(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.makesafe_deterministic_intake_preflight(uuid)
  TO service_role, postgres;
