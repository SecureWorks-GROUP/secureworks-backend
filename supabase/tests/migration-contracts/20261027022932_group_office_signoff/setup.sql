-- The registered stack supplies the group and sign-off tables.
DO $$ BEGIN
  IF to_regclass('public.job_client_signoffs') IS NULL OR to_regclass('public.group_work_orders') IS NULL THEN
    RAISE EXCEPTION 'group office sign-off prerequisites are missing';
  END IF;
END $$;
