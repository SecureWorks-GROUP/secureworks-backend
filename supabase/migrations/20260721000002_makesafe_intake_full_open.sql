-- Explicit deterministic intake selection authority.
--
-- `exact` preserves the guarded rollout contract: deterministic live scans require
-- at least one source/instruction allowlist entry at runtime. `full_open` is the
-- separately approved production authority to process the bounded sweep directly;
-- it is deliberately distinct from an accidentally empty exact allowlist.
--
-- Additive and inert: existing rows remain `exact` and intake_mode is untouched.

ALTER TABLE public.makesafe_cron_settings
  ADD COLUMN IF NOT EXISTS deterministic_selection_mode text NOT NULL DEFAULT 'exact';

ALTER TABLE public.makesafe_cron_settings
  DROP CONSTRAINT IF EXISTS makesafe_cron_settings_deterministic_selection_mode_check;
ALTER TABLE public.makesafe_cron_settings
  ADD CONSTRAINT makesafe_cron_settings_deterministic_selection_mode_check CHECK (
    deterministic_selection_mode IN ('exact', 'full_open')
  );

-- Full-open authority and exact allowlists are mutually exclusive. This prevents a
-- mixed configuration whose apparent scope depends on application precedence.
-- Exact+empty remains legal in legacy mode and fails closed at runtime if somebody
-- flips deterministic authority without first choosing full_open or naming a source.
ALTER TABLE public.makesafe_cron_settings
  DROP CONSTRAINT IF EXISTS makesafe_cron_settings_full_open_empty_allowlists_check;
ALTER TABLE public.makesafe_cron_settings
  ADD CONSTRAINT makesafe_cron_settings_full_open_empty_allowlists_check CHECK (
    deterministic_selection_mode <> 'full_open'
    OR (
      cardinality(deterministic_source_allowlist) = 0
      AND cardinality(deterministic_instruction_allowlist) = 0
    )
  );

COMMENT ON COLUMN public.makesafe_cron_settings.deterministic_selection_mode IS
  'exact requires a non-empty DB allowlist in deterministic live mode; full_open requires both allowlists empty and processes only the bounded cursor page/case cap.';
