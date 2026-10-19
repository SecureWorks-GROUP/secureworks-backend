-- Rollback for 20261019200000_dispatch_material_line_provenance.sql.
-- Refuses while any quote_builder line exists: narrowing the source list would
-- fail on it, and dropping the columns would lose where those lines came from.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.job_material_lines WHERE source = 'quote_builder') THEN
    RAISE EXCEPTION 'quote_builder material lines exist; move or remove them before rolling back 20261019200000';
  END IF;
END $$;

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
