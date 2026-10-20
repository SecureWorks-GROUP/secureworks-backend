-- Prerequisites for 20261019200000_dispatch_material_line_provenance. The registered
-- 20261014130000 case already creates public.job_material_lines (with source manual or scope)
-- on reduced public.jobs and public.suppliers; nothing is added here.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.jobs', 'public.suppliers', 'public.job_material_suppliers', 'public.job_material_lines'] LOOP
  IF to_regclass(t) IS NULL THEN
   RAISE EXCEPTION 'material line provenance setup: % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
