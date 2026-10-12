-- Admit the 'ambrose' adapter id on makesafe_intake_cases.
--
-- The deterministic intake stamps every case with the adapter that read it
-- (makesafe_deterministic_intake.ts, DETERMINISTIC_ADAPTER_REGISTRY), and
-- makesafe_intake_cases_deterministic_shapes_check holds the list of adapter
-- ids the table accepts. PR #1004 added the Ambrose Construct Group adapter in
-- code and its company row (20261009140000) but not its id here, so every
-- Ambrose case was refused on insert. Measured in production on 12 Oct 2026:
-- 15 Ambrose cases, all stored only as the stripped persistence-failure
-- fallback (state exception, adapter_id null), no job and no review draft.
--
-- This is the ONLY adapter list in the database: makesafe_intake_cases is the
-- one table with an adapter_id column, and no other intake table (case
-- sources, drafts, artifacts, case events) constrains an adapter. The contract
-- test makesafe_adapter_admission_contract_test.ts fails whenever an adapter
-- registered in code is missing from the newest definition of any such list.
--
-- Everything else in the constraint is unchanged from
-- 20260727080821_makesafe_synthetic_livefire_infrastructure.sql. Re-adding a
-- CHECK validates the rows already stored; every stored adapter id is in the
-- wider list, so validation cannot fail on existing data. No row is written.
--
-- The cases already stored as fallbacks are recovered by the ordinary intake
-- scan, not by this migration: see RELEASED_SOURCE_PERSIST_FALLBACK_ADAPTERS in
-- makesafe_deterministic_intake_runtime.ts.
--
-- Rollback: supabase/rollbacks/20261012043000_makesafe_intake_cases_admit_
-- ambrose_adapter_down.sql.
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
        'ambrose',
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
  );
