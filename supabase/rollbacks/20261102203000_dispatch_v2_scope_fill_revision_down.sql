-- Down for 20261102203000_dispatch_v2_scope_fill_revision. Roll ops-api back
-- FIRST: its scope fill inserts and reads dispatch_v2_scope_fills.scope_revision_id,
-- and with the column gone the materials read and every fill are refused.
-- Drops the foreign key and the column; every fill row stays. The recorded
-- revision of each fill is lost with the column (each filled line keeps its own
-- in job_material_lines.source_version_id, which this does not touch).
ALTER TABLE public.dispatch_v2_scope_fills DROP CONSTRAINT IF EXISTS dispatch_v2_scope_fills_scope_revision_id_fkey;
ALTER TABLE public.dispatch_v2_scope_fills DROP COLUMN IF EXISTS scope_revision_id;
