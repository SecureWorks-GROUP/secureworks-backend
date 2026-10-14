-- Let the browser read the material lines; the contract must then fail on the privilege check.
GRANT SELECT ON TABLE public.job_material_lines TO authenticated;
