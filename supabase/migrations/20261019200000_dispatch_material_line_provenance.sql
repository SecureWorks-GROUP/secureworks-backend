-- Dispatch: where a material line came from, kept on the line.
--
-- HELD. Not for merge until the Rayleigh release, after a second-model review
-- and a dry run of scripts/apply-pending-migrations.sh against the live ledger
-- (this version must not collide with a live ledger row; renumber it if it does).
--
-- Why: a line Dispatch takes from a quote (the repair and private quote
-- builder, contract-repair-misc-pack-intake-20261019 in the Dispatch folder) or
-- from a frozen fence or patio scope keeps no record of which version and which
-- source line it came from once the suggest reply is gone. A later "the quote
-- changed since these lines were taken" check and the money match of ordered
-- against quoted both need that record, so it is kept on the line itself.
-- purchase_orders.quote_builder_version_id records the version only, only at
-- order time, and only on the builder's own order path.
--
-- Additive only: four nullable columns, a wider source list, two shape checks
-- and one partial unique index. No backfill: lines taken before this migration
-- keep null provenance and read as "source not recorded". Writes no row.
--
-- Columns:
--   source_kind        what the source is: quote_builder_version,
--                      fence_scope_revision, patio_scope_revision.
--   source_version_id  the id of that version or revision row.
--   source_version     its version number or label as shown to people.
--   source_line_id     the source's own line id (quote builder cost_lines
--                      line_id). Fence and patio lines are worked out from the
--                      scope and have no line of their own, so they carry a
--                      material key (dispatchScopeMaterialKey in
--                      ops-api/dispatch_materials.ts), which the variation
--                      press compares between revisions.
--
-- The partial unique index makes one source line land on a job at most once,
-- whatever the press order: a second or concurrent take of the same quote line
-- fails on the index (23505), as the suggest action's line ids already do.
-- The same line id under a later version is a different row, so a reissue is
-- handled on purpose by the take or refresh code, never by this index. The
-- writer checks a version for repeated line ids first and refuses
-- source_line_id_repeated, so a 23505 here never reads as "lines exist".
--
-- Rollback: supabase/rollbacks/20261019200000_dispatch_material_line_provenance_down.sql.

ALTER TABLE public.job_material_lines
  ADD COLUMN IF NOT EXISTS source_kind text NULL,
  ADD COLUMN IF NOT EXISTS source_version_id uuid NULL,
  ADD COLUMN IF NOT EXISTS source_version text NULL,
  ADD COLUMN IF NOT EXISTS source_line_id text NULL;

ALTER TABLE public.job_material_lines
  DROP CONSTRAINT IF EXISTS job_material_lines_source_valid;
ALTER TABLE public.job_material_lines
  ADD CONSTRAINT job_material_lines_source_valid
  CHECK (source IN ('manual', 'scope', 'quote_builder'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'job_material_lines_source_kind_valid') THEN
    ALTER TABLE public.job_material_lines
      ADD CONSTRAINT job_material_lines_source_kind_valid CHECK (
        source_kind IS NULL
        OR source_kind IN ('quote_builder_version', 'fence_scope_revision', 'patio_scope_revision'));
  END IF;
  -- A hand-added line has no source; a quote builder line always names its
  -- version and its line; a line id never stands without its version.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'job_material_lines_source_shape') THEN
    ALTER TABLE public.job_material_lines
      ADD CONSTRAINT job_material_lines_source_shape CHECK (
        (source <> 'manual' OR source_kind IS NULL)
        AND (source <> 'quote_builder'
             OR (source_kind = 'quote_builder_version'
                 AND source_version_id IS NOT NULL
                 AND source_line_id IS NOT NULL))
        -- A scope line names only a frozen fence or patio revision, never a
        -- quote builder version.
        AND (source <> 'scope' OR source_kind IS NULL
             OR source_kind IN ('fence_scope_revision', 'patio_scope_revision'))
        AND (source_kind IS NULL) = (source_version_id IS NULL)
        AND (source_line_id IS NULL OR source_version_id IS NOT NULL)
        AND (source_line_id IS NULL OR char_length(source_line_id) BETWEEN 1 AND 100)
        AND (source_version IS NULL OR char_length(source_version) BETWEEN 1 AND 50));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS job_material_lines_source_line_once
  ON public.job_material_lines (job_id, source_version_id, source_line_id)
  WHERE source_line_id IS NOT NULL;

COMMENT ON COLUMN public.job_material_lines.source_version_id IS
  'The quote builder version or frozen scope revision this line was taken from. Null: hand-added, or taken before 20261019200000 (not recorded).';
COMMENT ON COLUMN public.job_material_lines.source_line_id IS
  'The source''s own line id (quote builder cost_lines line_id), or a fence or patio line''s material key. Unique per job and version.';
