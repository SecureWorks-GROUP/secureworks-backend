-- T20 (Scope Engine P9, 2 Nov 2026): the supplier order goes into Dispatch with
-- no retyping, filled from the job's sealed scope revision.
--
-- Dispatch v2's fill (ops-api dispatch_v2_suggest_draft) now reads the job's
-- frozen scope_revisions row by Context's material-take rule (D1 fix F3,
-- #1238), the one the older Materials panel already uses: the revision
-- recorded at acceptance, else the one the acceptance chain names, else the
-- latest frozen revision. It fills from that row's own scope_canonical_text,
-- never from jobs.scope_json. Rule: ops-api/dispatch_v2_sealed_scope.ts.
--
-- One nullable column on dispatch_v2_scope_fills, pointing at scope_revisions(id):
--
--   scope_revision_id  the frozen revision the job's draft list was filled
--                      from. NULL = a fill recorded before 20261102203000.
--
-- Each filled line already records its revision in job_material_lines'
-- provenance columns (production migration 20261019200000): source_kind
-- fence_scope_revision or patio_scope_revision, source_version_id the
-- scope_revisions id, source_version its revision number, source_line_id the
-- engine's own line id (patio). Those columns are not changed here.
--
-- Access: no grant, policy or RLS change; the column takes the table's
-- privileges. ON DELETE RESTRICT as quote_revisions.scope_revision_id (#1207);
-- scope_revisions rows are never deleted. No backfill: the six fills before this
-- were read from the job's scope at the time, not from a sealed revision.
--
-- Order: apply BEFORE the matching ops-api (it inserts and reads the column;
-- scripts/edge-function-schema-requirements.txt holds it back).
-- Rollback: supabase/rollbacks/20261102203000_dispatch_v2_scope_fill_revision_down.sql.

ALTER TABLE public.dispatch_v2_scope_fills
  ADD COLUMN IF NOT EXISTS scope_revision_id uuid NULL
    CONSTRAINT dispatch_v2_scope_fills_scope_revision_id_fkey
    REFERENCES public.scope_revisions(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.dispatch_v2_scope_fills.scope_revision_id IS
  'T20 (20261102203000). The frozen scope_revisions row this job''s draft list was filled from: the accepted revision, else the one the acceptance chain names, else the latest frozen revision (Context D1 fix F3). NULL = a fill recorded before 20261102203000. Never backfilled.';
