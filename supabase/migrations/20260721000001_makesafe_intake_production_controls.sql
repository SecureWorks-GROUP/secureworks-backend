-- Deterministic make-safe intake production rollout controls.
--
-- Additive and inert. Applying this migration does not change intake authority:
-- intake_mode remains 'legacy'. If deterministic authority is later approved, an
-- empty allowlist fails before business writes and the first explicit cap is one.

ALTER TABLE public.makesafe_cron_settings
  ADD COLUMN IF NOT EXISTS deterministic_max_cases_per_run smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deterministic_source_allowlist text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS deterministic_instruction_allowlist text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS deterministic_rollout_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS deterministic_rollout_changed_by text;

ALTER TABLE public.makesafe_cron_settings
  DROP CONSTRAINT IF EXISTS makesafe_cron_settings_deterministic_cap_check;
ALTER TABLE public.makesafe_cron_settings
  ADD CONSTRAINT makesafe_cron_settings_deterministic_cap_check CHECK (
    deterministic_max_cases_per_run BETWEEN 1 AND 10
  );

CREATE OR REPLACE FUNCTION public.makesafe_exact_allowlist_valid(
  values_to_check text[],
  max_items integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT cardinality(values_to_check) <= max_items
    AND COALESCE(bool_and(value IS NOT NULL AND btrim(value) <> ''), true)
    AND count(value) = count(DISTINCT value)
  FROM unnest(values_to_check) value;
$$;
REVOKE ALL ON FUNCTION public.makesafe_exact_allowlist_valid(text[], integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.makesafe_exact_allowlist_valid(text[], integer)
  TO service_role, postgres;

ALTER TABLE public.makesafe_cron_settings
  DROP CONSTRAINT IF EXISTS makesafe_cron_settings_deterministic_allowlists_check;
ALTER TABLE public.makesafe_cron_settings
  ADD CONSTRAINT makesafe_cron_settings_deterministic_allowlists_check CHECK (
    public.makesafe_exact_allowlist_valid(deterministic_source_allowlist, 50)
    AND public.makesafe_exact_allowlist_valid(deterministic_instruction_allowlist, 50)
  );

COMMENT ON COLUMN public.makesafe_cron_settings.deterministic_max_cases_per_run IS
  'DB-backed deterministic rollout cap. Starts at exactly one and is structurally bounded to 1..10; runtime has no backlog-sized fallback.';
COMMENT ON COLUMN public.makesafe_cron_settings.deterministic_source_allowlist IS
  'Exact source post ids approved for the next deterministic invocation. Empty with no instruction keys makes live runtime fail closed before business writes.';
COMMENT ON COLUMN public.makesafe_cron_settings.deterministic_instruction_allowlist IS
  'Exact canonical instruction keys approved for the next deterministic invocation. Empty with no source ids makes live runtime fail closed before business writes.';

-- Reaching the authenticated canary handler is the application-side proof that the
-- edge request passed auth. Readiness expires after one 15-minute canary interval;
-- recipient configuration alone can never imply authenticated readiness.
ALTER TABLE public.makesafe_intake_health
  ADD COLUMN IF NOT EXISTS alarm_auth_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS alarm_auth_action text;

ALTER TABLE public.makesafe_intake_health
  DROP CONSTRAINT IF EXISTS makesafe_intake_health_alarm_auth_action_check;
ALTER TABLE public.makesafe_intake_health
  ADD CONSTRAINT makesafe_intake_health_alarm_auth_action_check CHECK (
    (alarm_auth_verified_at IS NULL AND alarm_auth_action IS NULL)
    OR (
      alarm_auth_verified_at IS NOT NULL
      AND alarm_auth_action = 'makesafe_email_canary'
    )
  );

COMMENT ON COLUMN public.makesafe_intake_health.alarm_auth_verified_at IS
  'Most recent time the authenticated makesafe_email_canary handler was reached. Health treats stale or absent proof as not ready.';

-- Bounded scans need a progress guarantee that does not depend on any row ever
-- being stamped as scanned. The deterministic sweep half of each read starts
-- after this received_at position and moves it forward every live run, restarting
-- at the oldest in-window row once the sweep reaches the end.
ALTER TABLE public.makesafe_intake_health
  ADD COLUMN IF NOT EXISTS deterministic_scan_cursor_at timestamptz;

COMMENT ON COLUMN public.makesafe_intake_health.deterministic_scan_cursor_at IS
  'Advancing received_at position of the bounded deterministic source sweep. NULL restarts the sweep at the oldest row inside the window.';
