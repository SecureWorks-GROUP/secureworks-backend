-- After the down migration the switch is gone, which reads as off.
DO $contract$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'repair_intake_auto_v1'
  ) THEN
    RAISE EXCEPTION 'rollback left repair_intake_auto_v1 behind';
  END IF;
END;
$contract$;
