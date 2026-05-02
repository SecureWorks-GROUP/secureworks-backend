-- ════════════════════════════════════════════════════════════════
-- DRAFT — Cap 1C state_engine_observations table
-- 2026-05-02
--
-- ⚠️ NOT YET APPLIED. This is a DRAFT migration sitting in
-- supabase/migrations/_drafts/ so the Supabase CLI does NOT pick it
-- up. To promote: move (or copy) into supabase/migrations/ with a
-- proper timestamped filename (e.g. 20260503000001_state_engine_observations.sql)
-- after Marnin/CIO approval.
--
-- Authority: secureworks-docs/cio/evidence/cap1c-shadow-mode-2026-05-02/
-- Sub-ADR: secureworks-docs/decisions/2026-05-02-cap1c-observations-surface.md
--
-- One-way door: this migration creates a new table. The reverse
-- migration (rollback) drops it. As long as no consumer reads from
-- it as a hard dependency, rollback is safe. After Cap 1D writes
-- to it, follow-up consumers must not break on an empty/missing
-- table.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.state_engine_observations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_id          TEXT,                      -- intentionally TEXT to mirror business_events.job_id (post-Cap-0 normalisation tracked separately)
  from_status     TEXT,
  to_status       TEXT,
  writer_source   TEXT NOT NULL,             -- ops_dashboard | api | ghl_webhook | send_quote | xero_sync | reporting_api | mcp_agent | trade_app
  engine_verdict  TEXT NOT NULL CHECK (engine_verdict IN ('allow','block','warn','overridden','error')),
  hard_blocked    BOOLEAN NOT NULL DEFAULT false,
  requires_override BOOLEAN NOT NULL DEFAULT false,
  blockers        JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{gate_id, severity, reason}, ...]
  warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  overrides       JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_stage   TEXT,
  frontend_bucket TEXT,
  evidence_refs   JSONB,
  engine_version  TEXT,
  shadow_error    TEXT,                      -- non-null when engine threw; transition still proceeded per current behaviour
  correlation_id  UUID,                      -- mirrors business_events.correlation_id
  actual_write_succeeded BOOLEAN,
  actor_email     TEXT,
  metadata        JSONB
);

COMMENT ON TABLE public.state_engine_observations IS
  'Cap 1C shadow-mode observations. Append-only. Records what the stage-gate engine WOULD have done for each transition attempt. Cap 1C never enforces — observations are advisory only.';

-- Append-only safety: revoke UPDATE/DELETE for typical roles. Service role retains full access.
REVOKE UPDATE, DELETE ON public.state_engine_observations FROM authenticated;
REVOKE UPDATE, DELETE ON public.state_engine_observations FROM anon;

-- Indexes for the common query patterns documented in the sub-ADR:
--   1. by writer_source + observed_at — "what verdicts has each writer produced over the last 7 days?"
--   2. by job_id + observed_at        — "what's the gate history for this job?"
--   3. by engine_verdict + observed_at — "how often does the engine see blocks?"
CREATE INDEX IF NOT EXISTS state_engine_observations_writer_observed_at_idx
  ON public.state_engine_observations (writer_source, observed_at DESC);

CREATE INDEX IF NOT EXISTS state_engine_observations_job_observed_at_idx
  ON public.state_engine_observations (job_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS state_engine_observations_verdict_observed_at_idx
  ON public.state_engine_observations (engine_verdict, observed_at DESC);

-- RLS policy: service role only. Conservative — Cap 1D may relax to
-- include authenticated reads for the override audit page (Marnin/Shaun).
ALTER TABLE public.state_engine_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY state_engine_observations_service_role_only
  ON public.state_engine_observations
  AS PERMISSIVE FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════
-- ROLLBACK (manual — copy into a separate down-migration if needed):
--
-- DROP POLICY IF EXISTS state_engine_observations_service_role_only ON public.state_engine_observations;
-- DROP INDEX IF EXISTS public.state_engine_observations_verdict_observed_at_idx;
-- DROP INDEX IF EXISTS public.state_engine_observations_job_observed_at_idx;
-- DROP INDEX IF EXISTS public.state_engine_observations_writer_observed_at_idx;
-- DROP TABLE IF EXISTS public.state_engine_observations;
--
-- Pre-rollback verification: ensure no consumer depends on the
-- table. Cap 1C's shadow-mode wrapper writes to it; rollback
-- requires either disabling STATE_ENGINE_SHADOW first OR accepting
-- that future writes will silently fail (the wrapper catches any
-- insert error and continues).
-- ════════════════════════════════════════════════════════════════
