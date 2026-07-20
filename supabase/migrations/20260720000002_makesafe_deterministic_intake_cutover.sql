-- Deterministic make-safe intake cutover package.
--
-- This migration is NOT applied by repository code. It is inert while intake_mode
-- remains 'legacy'. Applying and flipping remain separate Captain-gated actions.
-- A direct guarded cutover is one UPDATE; rollback is the inverse one UPDATE.

ALTER TABLE public.makesafe_cron_settings
  ADD COLUMN IF NOT EXISTS intake_mode text NOT NULL DEFAULT 'legacy'
    CHECK (intake_mode IN ('legacy', 'deterministic')),
  ADD COLUMN IF NOT EXISTS intake_mode_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS intake_mode_changed_by text;

UPDATE public.makesafe_cron_settings
SET intake_mode = COALESCE(intake_mode, 'legacy')
WHERE id = true;

COMMENT ON COLUMN public.makesafe_cron_settings.intake_mode IS
  'Single make-safe intake authority switch. legacy runs the pre-cutover path; deterministic runs adapters with no AI fallback. Rollback is one UPDATE back to legacy.';

CREATE OR REPLACE FUNCTION public.makesafe_intake_mode()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT intake_mode FROM public.makesafe_cron_settings WHERE id = true),
    'legacy'
  );
$$;
REVOKE ALL ON FUNCTION public.makesafe_intake_mode() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_mode() TO service_role, postgres;

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
    (adapter_id IS NULL OR adapter_id IN ('mlb', 'ajs_ajbr', 'prime', 'rapid', 'chatter'))
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

CREATE INDEX IF NOT EXISTS idx_makesafe_intake_cases_source_fingerprint
  ON public.makesafe_intake_cases (org_id, source_fingerprint)
  WHERE source_fingerprint IS NOT NULL;

-- Drafts remain approval artifacts. This key reserves one deterministic draft per
-- canonical instruction, including multiple instructions sourced from one email.
ALTER TABLE public.makesafe_intake_drafts
  ADD COLUMN IF NOT EXISTS deterministic_key text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_makesafe_intake_drafts_deterministic_key
  ON public.makesafe_intake_drafts (org_id, deterministic_key)
  WHERE deterministic_key IS NOT NULL;

-- Append-only artifact identity/cursor ledger. It records completed deterministic
-- PDFs/screenshots/drafts and approval references without storing bytes, signed URLs,
-- message bodies or personal information. Invoices and outbound messages are not
-- produced by deterministic intake, but their kinds are reserved so retries cannot
-- accidentally acquire an untracked side effect later.
CREATE TABLE IF NOT EXISTS public.makesafe_intake_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,
  case_id uuid NOT NULL,
  artifact_key text NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN (
    'pdf', 'screenshot', 'draft', 'job', 'invoice', 'outbound_message', 'approval'
  )),
  status text NOT NULL CHECK (status IN ('staged', 'completed', 'blocked')),
  storage_locator text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  recovery_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_intake_artifacts_case_fk
    FOREIGN KEY (org_id, case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_artifacts_key UNIQUE (org_id, artifact_key),
  CONSTRAINT makesafe_intake_artifacts_values_check CHECK (
    btrim(artifact_key) <> ''
    AND jsonb_typeof(evidence) = 'object'
    AND jsonb_typeof(recovery_cursor) = 'object'
    AND (status <> 'completed' OR completed_at IS NOT NULL)
  )
);
ALTER TABLE public.makesafe_intake_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.makesafe_intake_artifacts FROM anon, authenticated;
GRANT ALL ON public.makesafe_intake_artifacts TO service_role;
DROP POLICY IF EXISTS service_role_all_makesafe_intake_artifacts
  ON public.makesafe_intake_artifacts;
CREATE POLICY service_role_all_makesafe_intake_artifacts
  ON public.makesafe_intake_artifacts FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_makesafe_intake_artifacts_append_only
  ON public.makesafe_intake_artifacts;
CREATE TRIGGER trg_makesafe_intake_artifacts_append_only
  BEFORE UPDATE OR DELETE ON public.makesafe_intake_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.reject_makesafe_intake_append_only_mutation();

ALTER TABLE public.makesafe_intake_health
  ADD COLUMN IF NOT EXISTS intake_mode text NOT NULL DEFAULT 'legacy'
    CHECK (intake_mode IN ('legacy', 'deterministic')),
  ADD COLUMN IF NOT EXISTS last_scan_model_calls integer NOT NULL DEFAULT 0
    CHECK (last_scan_model_calls >= 0);

COMMENT ON COLUMN public.makesafe_intake_health.last_scan_model_calls IS
  'Truthful provider usage count. Deterministic scans always write zero; deterministic mode never silently calls or falls back to AI.';

-- Preflight helper is read-only and deliberately refuses cutover when the inert
-- case migration or deterministic columns are absent, or when source accounting is
-- already contradictory. It does not flip the mode.
CREATE OR REPLACE FUNCTION public.makesafe_deterministic_intake_preflight(p_org_id uuid)
RETURNS TABLE (check_name text, ok boolean, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'switch_present', true, 'makesafe_cron_settings.intake_mode exists'
  UNION ALL
  SELECT 'mode_is_legacy',
    COALESCE((SELECT intake_mode = 'legacy' FROM public.makesafe_cron_settings WHERE id = true), false),
    'preflight must run before the direct cutover'
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

-- CUTOVER (Captain-gated, not executed by this migration):
-- UPDATE public.makesafe_cron_settings
-- SET intake_mode='deterministic', intake_mode_changed_at=now(),
--     intake_mode_changed_by='<approved operator>'
-- WHERE id=true AND intake_mode='legacy';
--
-- ONE-SWITCH ROLLBACK:
-- UPDATE public.makesafe_cron_settings
-- SET intake_mode='legacy', intake_mode_changed_at=now(),
--     intake_mode_changed_by='<approved operator rollback>'
-- WHERE id=true AND intake_mode='deterministic';
