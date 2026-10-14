-- Rollback of 20261012043000_makesafe_intake_cases_admit_ambrose_adapter:
-- stop admitting the 'ambrose' adapter id on new and changed rows.
--
-- The constraint is restored NOT VALID on purpose. Ambrose cases stored while
-- the adapter was admitted stay as they are (a validated re-add would refuse to
-- run while any such row exists, and they are bound to jobs and review drafts);
-- NOT VALID still checks every later insert and update, so new Ambrose cases
-- fall back to the stripped persistence-failure exception exactly as they did
-- before the forward migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_deterministic_shapes_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_deterministic_shapes_check CHECK (
    (
      adapter_id IS NULL
      OR adapter_id IN (
        'mlb',
        'ajs_ajbr',
        'prime',
        'rapid',
        'builderwest',
        'western',
        'chatter',
        'synthetic_livefire'
      )
    )
    AND jsonb_typeof(story_json) = 'array'
    AND jsonb_typeof(evidence_map) = 'object'
    AND jsonb_typeof(recovery_cursor) = 'object'
    AND (
      adapter_id IS NULL
      OR (
        btrim(adapter_version) <> ''
        AND btrim(manifest_version) <> ''
        AND btrim(source_fingerprint) <> ''
        AND recovery_cursor ? 'version'
        AND recovery_cursor ? 'searchedSourcePostIds'
        AND recovery_cursor ? 'sideEffectKeys'
      )
    )
  ) NOT VALID;
