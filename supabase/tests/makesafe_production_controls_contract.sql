-- Disposable production-schema-clone contract for deterministic rollout controls.
-- All mutations are rolled back. Never run against production.

BEGIN;

DO $$
DECLARE
  settings_row public.makesafe_cron_settings%ROWTYPE;
BEGIN
  SELECT * INTO STRICT settings_row
  FROM public.makesafe_cron_settings
  WHERE id = true;

  IF settings_row.intake_mode <> 'deterministic' THEN
    RAISE EXCEPTION 'standing intake authority must be deterministic';
  END IF;
  IF settings_row.deterministic_selection_mode <> 'full_open' THEN
    RAISE EXCEPTION 'standing deterministic selection must be full_open';
  END IF;
  IF settings_row.deterministic_max_cases_per_run <> 10 THEN
    RAISE EXCEPTION 'standing deterministic cap must default to ten';
  END IF;
  IF cardinality(settings_row.deterministic_source_allowlist) <> 0
    OR cardinality(settings_row.deterministic_instruction_allowlist) <> 0
  THEN
    RAISE EXCEPTION 'deterministic rollout allowlists must default empty';
  END IF;
  IF to_regclass('public.makesafe_intake_artifacts') IS NULL THEN
    RAISE EXCEPTION 'artifact ledger missing';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE public.makesafe_cron_settings
    SET deterministic_max_cases_per_run = 11
    WHERE id = true;
    RAISE EXCEPTION 'cap above ten unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE public.makesafe_cron_settings
    SET deterministic_source_allowlist = ARRAY['approved-source', 'approved-source']
    WHERE id = true;
    RAISE EXCEPTION 'duplicate exact source allowlist unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE public.makesafe_cron_settings
    SET deterministic_instruction_allowlist = ARRAY['']
    WHERE id = true;
    RAISE EXCEPTION 'blank instruction allowlist unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
