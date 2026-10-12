-- makesafe_intake_cases as live for this contract, on top of the narrow table
-- 20260826000001_repair_job_type declares: the deterministic columns and the
-- adapter list exactly as production held them before this migration (the
-- definition from 20260727080821_makesafe_synthetic_livefire_infrastructure),
-- so the migration is replayed against the real pre-existing constraint.
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
ALTER TABLE public.makesafe_intake_cases
  ADD COLUMN IF NOT EXISTS adapter_id text,
  ADD COLUMN IF NOT EXISTS adapter_version text,
  ADD COLUMN IF NOT EXISTS manifest_version text,
  ADD COLUMN IF NOT EXISTS source_fingerprint text,
  ADD COLUMN IF NOT EXISTS story_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recovery_cursor jsonb NOT NULL DEFAULT '{}'::jsonb;

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
  );

-- A case stored before the migration, as the stripped fallback production
-- holds for every Ambrose email: no adapter. The migration must leave it be.
INSERT INTO public.makesafe_intake_cases (id, org_id, state, reason_code)
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'exception',
  'adapter_parse_failure'
)
ON CONFLICT (id) DO NOTHING;
