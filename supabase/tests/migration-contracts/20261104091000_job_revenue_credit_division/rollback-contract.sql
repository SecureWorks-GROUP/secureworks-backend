-- After the down: v_job_revenue_events is back to its exact earlier definition (production, or in this registered
-- stack the definition before the unregistered 20261103200000) and still reads.
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) NOT IN ('aeb851cd8d3d6e807cd7a5d620e020a8', 'ac208427bcf489ec12086cc08e3b9289') THEN
    RAISE EXCEPTION 'A3 rollback 20261104091000: v_job_revenue_events is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true));
  END IF;
  PERFORM count(*) FROM public.v_job_revenue_events;
END $$;
