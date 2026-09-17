-- After the down migration the kind check is pack/stamp/thread_facts and no
-- roster rows remain. The table itself stays (owned by 20260917130000).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.sales_booking_packs WHERE kind = 'roster'
  ) THEN
    RAISE EXCEPTION 'rollback-contract: roster rows still exist';
  END IF;
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload)
    VALUES ('marnin', '2026-09-14', 'roster', now(), '{}'::jsonb);
    RAISE EXCEPTION 'rollback-contract: roster kind was still accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.sales_booking_packs (resource, week_start, kind, as_of, payload, published_by)
    VALUES ('nithin', '1970-01-05', 'thread_facts', now(), '{"facts":{}}'::jsonb, 'rollback');
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'rollback-contract: thread_facts kind was refused after roster down';
  END;
END $$;
