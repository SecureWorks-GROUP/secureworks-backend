-- The registered stack supplies the group, invoice and sign-off surfaces.
DO $$ BEGIN
  IF to_regprocedure('public.freeze_group_work_order_split(uuid)') IS NULL
     OR to_regprocedure('public.group_work_order_share_pay(uuid,numeric)') IS NULL
     OR to_regclass('public.job_client_signoffs') IS NULL THEN
    RAISE EXCEPTION 'group employer-super release prerequisites are missing';
  END IF;
END $$;
