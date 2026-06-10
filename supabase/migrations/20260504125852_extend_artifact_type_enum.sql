-- Scope-Memory-Saving Loop 1, step 5 / Gate 1a — extend scope_artifacts.artifact_type
-- to cover Patio's gutter and ridge canonical renders
--
-- Status: APPLIED 2026-05-04 to project kevgrhcjxspbxgovpmfl
--   Supabase ledger: version=20260504125852 name=extend_artifact_type_enum
--   Filename: was authored as 20260504000002_extend_artifact_type_enum.sql
--     in supabase/migrations/_drafts/. After apply, promoted to
--     supabase/migrations/ on 2026-05-05 (Codex stop-time review #1) and
--     then renamed to 20260504125852_extend_artifact_type_enum.sql so the
--     filename prefix matches the Supabase ledger version exactly (Codex
--     stop-time review #2). Marnin's literal approval phrase used the
--     original draft name: "apply 20260504000002_extend_artifact_type_enum.sql"
--     — preserved verbatim here for the audit record.
--
-- Re-apply safety: idempotent. The migration DROPs the existing CHECK
-- constraint and re-ADDs it with the extended value list (every prior value
-- preserved + render_gutter_detail + render_ridge_detail). A `supabase db
-- push` against a fresh branch that replays this migration arrives at the
-- same constraint shape.
--
-- Roadmap : cio/operations/board/Scope-Memory-Saving/scope-freeze-end-to-end/roadmap.md (step 5)
-- Strategy: strategy/scope-freeze-lifecycle-evidence.md (Loop 0 §3-§4)
-- Companion: 20260504090757_scope_revisions_and_artifacts.sql (the substrate this extends; renamed from the original 20260504000001_*.sql draft per the same Codex review)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why
-- ─────────────────────────────────────────────────────────────────────────────
-- Patio Tool's exportWorkOrderViews() produces 8 canonical PNGs per scene:
--   hero, frontElevation, sideElevation, sitePlan, riserDetail, postDetail,
--   gutterDetail, ridgeDetail (gable-only).
--
-- The applied scope_artifacts.artifact_type CHECK constraint covers the first
-- 6 cleanly:
--   render_hero, render_front, render_side, render_site_plan,
--   render_riser, render_post_detail
-- The remaining two (gutterDetail, ridgeDetail) had no enum slot, so the
-- step 5 patio wiring currently SKIPS them with `skipped++` and a console
-- warning. Per CP-5 decision (option A — extend the enum, do not abuse the
-- 'drawing' slot for full renders), this migration adds the two missing
-- slots. After apply, the next pass on patio-tool/index.html can map the
-- two skipped views to their proper artifact_type values:
--   gutterDetail -> render_gutter_detail
--   ridgeDetail  -> render_ridge_detail
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Existing constraint shape (verified at draft time via execute_sql)
-- ─────────────────────────────────────────────────────────────────────────────
-- The artifact_type validation is a CHECK constraint, NOT a Postgres ENUM type:
--   CONSTRAINT scope_artifacts_artifact_type_check CHECK (
--     artifact_type = ANY (ARRAY[
--       'render_hero','render_front','render_side','render_site_plan',
--       'render_riser','render_post_detail','render_profile','render_3d_scene',
--       'quote_pdf','per_contact_pdf','work_order_pdf','material_order_pdf',
--       'model_glb','drawing'
--     ]::text[])
--   )
-- This means the safe extension pattern is DROP CONSTRAINT + ADD CONSTRAINT
-- with the extended list. PostgreSQL does not provide an in-place
-- "ALTER CHECK CONSTRAINT" operation; DROP+ADD is the canonical pattern.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why this is additive / non-destructive
-- ─────────────────────────────────────────────────────────────────────────────
--   * Strict superset. The new ARRAY adds two values and removes none. Every
--     row that satisfied the old check still satisfies the new one, so the
--     ADD CONSTRAINT validation pass cannot fail by construction.
--   * Zero data risk. The scope_artifacts table is freshly created (current
--     row count: 0 — no helper has written to it yet); even if rows existed,
--     the validation pass would succeed.
--   * No semantics change for any existing artifact_type value.
--   * No other table, column, trigger, index, policy, or row touched.
--   * The append-only triggers on scope_artifacts (trg_scope_artifacts_no_update,
--     trg_scope_artifacts_no_delete) do not fire for DDL on the parent table —
--     they target row-level UPDATE / DELETE only.
--   * No application code change is required for the migration itself; the
--     patio-tool mapping update lives in a separate edit covered by Gate 3.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Out of scope for this migration
-- ─────────────────────────────────────────────────────────────────────────────
--   * Any patio-tool / fence-designer code change. Gate 3 territory.
--   * Any ops-api enum update. Gate 2 deploy ships the existing
--     record_scope_artifact.ts which already accepts the new values once
--     they are added to the ArtifactType TS union; the union update is a
--     separate code change paired with Gate 3.
--   * Any rename / renumber of existing artifact_type values.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (time-to-revert: <2s)
-- ─────────────────────────────────────────────────────────────────────────────
--   ALTER TABLE public.scope_artifacts
--     DROP CONSTRAINT IF EXISTS scope_artifacts_artifact_type_check;
--   ALTER TABLE public.scope_artifacts
--     ADD CONSTRAINT scope_artifacts_artifact_type_check
--     CHECK (artifact_type = ANY (ARRAY[
--       'render_hero','render_front','render_side','render_site_plan',
--       'render_riser','render_post_detail','render_profile','render_3d_scene',
--       'quote_pdf','per_contact_pdf','work_order_pdf','material_order_pdf',
--       'model_glb','drawing'
--     ]::text[]));
--   -- After this rollback any rows that had been inserted with the new
--   -- values would now violate the constraint. Confirm zero rows of
--   -- artifact_type IN ('render_gutter_detail','render_ridge_detail')
--   -- BEFORE rolling back.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Apply notes (historical — this migration HAS BEEN APPLIED; see Status block)
-- ─────────────────────────────────────────────────────────────────────────────
-- The pre-apply approval phrase Marnin used at the protected gate was
-- "apply 20260504000002_extend_artifact_type_enum.sql", referencing the
-- original draft filename. Apply was via mcp__claude_ai_Supabase__apply_migration
-- with name='extend_artifact_type_enum' against project kevgrhcjxspbxgovpmfl.
-- Postflight verification (read-only):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'scope_artifacts_artifact_type_check';
-- — confirmed render_gutter_detail and render_ridge_detail present alongside
-- the existing 14 values.

BEGIN;

-- DROP and re-ADD with the extended list. Same constraint name preserved.
ALTER TABLE public.scope_artifacts
  DROP CONSTRAINT IF EXISTS scope_artifacts_artifact_type_check;

ALTER TABLE public.scope_artifacts
  ADD CONSTRAINT scope_artifacts_artifact_type_check CHECK (
    artifact_type = ANY (ARRAY[
      -- Existing 14 values (unchanged):
      'render_hero',
      'render_front',
      'render_side',
      'render_site_plan',
      'render_riser',
      'render_post_detail',
      'render_profile',
      'render_3d_scene',
      'quote_pdf',
      'per_contact_pdf',
      'work_order_pdf',
      'material_order_pdf',
      'model_glb',
      'drawing',
      -- New (added by this migration on 2026-05-04 — Patio gable + gutter detail renders):
      'render_gutter_detail',
      'render_ridge_detail'
    ]::text[])
  );

COMMIT;
