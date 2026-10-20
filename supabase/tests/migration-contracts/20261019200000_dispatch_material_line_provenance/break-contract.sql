-- Drop the shape check: the contract must then fail on a manual line that names a kind.
ALTER TABLE public.job_material_lines DROP CONSTRAINT job_material_lines_source_shape;
