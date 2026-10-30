-- Rollback contract: 20261019200000_dispatch_material_line_provenance. With no recorded line the
-- down drops the index, the two new checks and the four columns, restores the source list to
-- manual and scope, and leaves the table and its other columns in place.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'job_material_lines'
             AND column_name IN ('source_kind', 'source_version_id', 'source_version', 'source_line_id')) THEN
  RAISE EXCEPTION 'material line provenance rollback contract: a provenance column still exists';
 END IF;
 IF to_regclass('public.job_material_lines_source_line_once') IS NOT NULL THEN
  RAISE EXCEPTION 'material line provenance rollback contract: the unique index still exists';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('job_material_lines_source_kind_valid',
                                                          'job_material_lines_source_shape')) THEN
  RAISE EXCEPTION 'material line provenance rollback contract: a provenance check still exists';
 END IF;
 IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conname = 'job_material_lines_source_valid') NOT LIKE '%''manual''%''scope''%'
    OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conname = 'job_material_lines_source_valid') LIKE '%quote_builder%' THEN
  RAISE EXCEPTION 'material line provenance rollback contract: the source list was not restored';
 END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'job_material_lines'
      AND column_name IN ('description', 'quantity', 'source', 'purchase_order_id')) <> 4 THEN
  RAISE EXCEPTION 'material line provenance rollback contract: the down removed something it does not own';
 END IF;
END $$;
