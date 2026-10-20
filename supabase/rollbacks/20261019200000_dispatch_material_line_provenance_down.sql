-- Rollback for 20261019200000_dispatch_material_line_provenance.sql.
-- Refuses while any line has recorded provenance (a quote_builder line, or a
-- fence or patio line with its revision): narrowing the source list would fail,
-- and dropping the columns would lose where those lines came from.
-- The check and every drop are one statement, so a refusal leaves nothing
-- dropped even under a plain psql -f that carries on after an error.

DO $$
DECLARE
  v_kept boolean := false;
BEGIN
  -- Checked only while the column is there, so a second run is a no-op.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_material_lines'
                AND column_name = 'source_kind') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.job_material_lines
                             WHERE source = ''quote_builder'' OR source_kind IS NOT NULL)'
      INTO v_kept;
  END IF;
  IF v_kept THEN
    RAISE EXCEPTION 'material lines with recorded provenance exist; keep or export them before rolling back 20261019200000';
  END IF;

  DROP INDEX IF EXISTS public.job_material_lines_source_line_once;
  ALTER TABLE public.job_material_lines
    DROP CONSTRAINT IF EXISTS job_material_lines_source_shape,
    DROP CONSTRAINT IF EXISTS job_material_lines_source_kind_valid,
    DROP CONSTRAINT IF EXISTS job_material_lines_source_valid;
  ALTER TABLE public.job_material_lines
    ADD CONSTRAINT job_material_lines_source_valid CHECK (source IN ('manual', 'scope'));
  ALTER TABLE public.job_material_lines
    DROP COLUMN IF EXISTS source_line_id,
    DROP COLUMN IF EXISTS source_version,
    DROP COLUMN IF EXISTS source_version_id,
    DROP COLUMN IF EXISTS source_kind;
END $$;
