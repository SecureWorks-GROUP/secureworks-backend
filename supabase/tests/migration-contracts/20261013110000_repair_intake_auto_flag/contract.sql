-- The switch exists exactly once and is OFF after the migration.
DO $contract$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags
      WHERE flag_name = 'repair_intake_auto_v1') <> 1 THEN
    RAISE EXCEPTION 'repair_intake_auto_v1 must exist exactly once';
  END IF;
  IF (SELECT enabled FROM public.feature_flags
      WHERE flag_name = 'repair_intake_auto_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'repair_intake_auto_v1 must be seeded off';
  END IF;
END;
$contract$;

-- A re-apply never switches on a flag someone left off, never switches off a
-- flag the owner turned on, and never adds a second row.
BEGIN;
UPDATE public.feature_flags SET enabled = true
WHERE flag_name = 'repair_intake_auto_v1';
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'repair_intake_auto_v1', false, 're-apply'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE flag_name = 'repair_intake_auto_v1'
);
DO $contract$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags
      WHERE flag_name = 'repair_intake_auto_v1') <> 1 THEN
    RAISE EXCEPTION 're-apply added a second repair_intake_auto_v1 row';
  END IF;
  IF (SELECT enabled FROM public.feature_flags
      WHERE flag_name = 'repair_intake_auto_v1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 're-apply switched repair_intake_auto_v1 off';
  END IF;
END;
$contract$;
ROLLBACK;
