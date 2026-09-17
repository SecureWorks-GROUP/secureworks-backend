-- After the down migration the kind check is pack/stamp only and no
-- thread_facts rows remain. The table itself stays (owned by 20260917130000).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.sales_booking_packs WHERE kind = 'thread_facts'
  ) THEN
    RAISE EXCEPTION 'rollback-contract: thread_facts rows still exist';
  END IF;
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload)
    VALUES ('marnin', '1970-01-05', 'thread_facts', now(), '{}'::jsonb);
    RAISE EXCEPTION 'rollback-contract: thread_facts kind was still accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;
