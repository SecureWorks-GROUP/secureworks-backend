-- After the down migration the list is gone and the settings row, with every
-- make-safe setting on it, is still there.
DO $contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'makesafe_notify_settings'
      AND column_name = 'repair_new_job_user_ids'
  ) THEN
    RAISE EXCEPTION 'rollback left repair_new_job_user_ids behind';
  END IF;
  IF (SELECT count(*) FROM public.makesafe_notify_settings
      WHERE id AND notify_enabled IS NOT NULL AND from_number IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'rollback lost the make-safe notify settings row';
  END IF;
END;
$contract$;
